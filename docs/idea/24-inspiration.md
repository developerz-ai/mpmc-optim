# Inspiration from outside queue libraries

**Rule: steal the mechanism, not the system.** Every row names one mechanism, its primary source, what it suggests for our ring, how it goes wrong, and a verdict. Queue libraries themselves (Vyukov, LCRQ, SCQ, wCQ, folly, moodycamel, crossbeam, `rte_ring` internals) belong to [02-prior-art.md](02-prior-art.md). Nothing here is measured by us: every "suggests" is a hypothesis until [19-benchmarking.md](19-benchmarking.md) or [17-testing-and-verification.md](17-testing-and-verification.md) says otherwise.

Status facts are **as of 2026-11** (Linux mainline at 7.4-rc4, checked in source).

| Verdict | Meaning |
|---|---|
| **adopt** | Build it into the default design |
| **opt-in** | Offer as a policy or variant, off by default |
| **experiment** | Plausible. Needs the named measurement or proof first |
| **reject** | Not for this library. Reason given |

## Patterns that recur across domains

Seven mechanisms show up independently in three or more domains. Treat these as the strongest signals in this doc.

| # | Pattern | Seen in | Consequence for us |
|---|---|---|---|
| P1 | **One writer per cache line**: private state stays private, shared state gets one owner | Disruptor, mimalloc, Seastar, per-CPU kernel data, Chase-Lev owner end | Handle caches what it can. Count contended RMWs per op ([01-vision.md](01-vision.md) metric) |
| P2 | **Batch the contended step**: one claim covers n items | DPDK burst, io_uring submit, SLUB sheaves, snmalloc, Tokio steal-half, aggregating funnels | Batch push and pop claim n tickets with one RMW ([04-api.md](04-api.md)) |
| P3 | **Failure writes nothing shared** | Optimistic lock coupling, RCU readers, scalable commutativity rule | `try_pop` on empty and `try_push` on full must not dirty the head or tail line |
| P4 | **Claim, write, then commit with a per-record word** | Aeron frame length, BPF ringbuf busy bit, our slot sequence | The commit word is the only thing a reader may trust (I4) |
| P5 | **The waiter may not be an OS thread** | Naughty Dog fibers, Java virtual threads, Go goroutines, Seastar reactors | Waiting is a policy with a park hook, never a hard-wired futex ([07-waiting.md](07-waiting.md)) |
| P6 | **Seeded deterministic simulation finds what stress misses** | FoundationDB, TigerBeetle VOPR, loom | Atomics go behind a shim so a checker can drive every schedule |
| P7 | **Adapt only after contention is observed** | qspinlock pending bit, Striped64, Erlang signal buffers, Go `runnext` | Uncontended path stays one RMW. Heavier machinery arms itself on failure counts |

## HFT and low latency

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| Mechanical sympathy, [Disruptor paper](https://lmax-exchange.github.io/disruptor/disruptor.html) | Preallocated ring entries, padded sequence counters, consumers take everything up to the published cursor in one pass | Batch pop to the visible limit, P2. Wait strategy as a compile-time policy | Disruptor is a broadcast log: each consumer sees every entry. Copying its consumer model into a work queue duplicates work | **adopt** batching and policy. **reject** broadcast semantics |
| [Single-writer principle](https://mechanical-sympathy.blogspot.com/2011/09/single-writer-principle.html) | One thread owns each mutable datum, so no contended RMW at all | Ship SPSC and MPSC specialisations. Tell users to pick the weakest role set | User lies about roles, queue corrupts silently. Check: debug-build role assertion in the handle | **adopt** |
| Aeron log buffer, [`LogBufferDescriptor`](https://github.com/aeron-io/aeron/blob/master/aeron-client/src/main/java/io/aeron/logbuffer/LogBufferDescriptor.java) | Three term buffers in rotation. Producer claims bytes with one atomic add on the tail, writes the frame, stores the frame length last as the commit. A claim past the term end writes padding and rotates | Variable-length byte queue. Claim by add never retries, P4 | Producer stalls between claim and commit and blocks every reader behind it. Same hazard as our claim-then-publish window | **reject** for v1 (fixed-size `T`). **experiment** as a byte-ring variant later |
| Seqlock, [Boehm 2012](https://doi.org/10.1145/2247684.2247688) | Writer bumps a counter to odd, writes, bumps to even. Reader copies, then validates the counter | Snapshot of stats or config that never blocks a writer. Not a slot protocol: readers do not consume | Racing plain reads are UB: payload must be atomics read relaxed, and `T` trivially copyable. Fence-based form defeats TSan ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)) | **opt-in** for stats. **reject** on the push/pop path |
| Kernel bypass (DPDK, SPDK, AF_XDP below) | Poll, never trap. No syscall on the hot path | Uncontended push and pop make zero syscalls. Wake only when a waiter flag is set | A missed wake hangs a consumer. Check: model-check the waiter flag protocol | **adopt** |
| Warm hot path, [Carl Cook, CppCon 2017](https://www.youtube.com/watch?v=NH1Tta7purM) | Run the full hot path often with dummy input and stop short of the side effect, so instruction cache, data cache and predictors stay trained | Benchmarks must report cold-start separately. Offer `prefault()` for the ring. Keep cold paths out of line | Warming inside the library costs every user. Dummy traffic can skew predictors if it differs from real traffic | **reject** in library. **adopt** in bench method ([19-benchmarking.md](19-benchmarking.md)) |

A seqlock that is defined behaviour in C++ (single writer shown, add a lock for more):

```cpp
// check: run
#include <atomic>
#include <cstdint>
#include <thread>

// Single-writer seqlock over two words. Payload words are atomics read with
// relaxed loads: a plain racing read would be a data race, so UB.
struct SeqPair {
    std::atomic<std::uint64_t> seq{0};
    std::atomic<std::uint64_t> a{0};
    std::atomic<std::uint64_t> b{0};

    void write(std::uint64_t x, std::uint64_t y) noexcept {
        const std::uint64_t s = seq.load(std::memory_order_relaxed);  // sole writer
        seq.store(s + 1, std::memory_order_relaxed);                  // odd: write in flight
        std::atomic_thread_fence(std::memory_order_release);          // orders the odd store before the payload stores
        a.store(x, std::memory_order_relaxed);
        b.store(y, std::memory_order_relaxed);
        seq.store(s + 2, std::memory_order_release);                  // even: publishes the payload
    }

    [[nodiscard]] bool try_read(std::uint64_t& x, std::uint64_t& y) const noexcept {
        const std::uint64_t s0 = seq.load(std::memory_order_acquire);  // pairs with the even store
        if ((s0 & 1U) != 0U) { return false; }
        x = a.load(std::memory_order_relaxed);
        y = b.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);           // pairs with the writer's release fence
        return seq.load(std::memory_order_relaxed) == s0;              // unchanged: x and y are one snapshot
    }
};

int main() {
    SeqPair p;
    std::atomic<bool> stop{false};
    std::atomic<int> torn{0};
    std::thread reader([&] {
        std::uint64_t x = 0;
        std::uint64_t y = 0;
        while (!stop.load(std::memory_order_acquire)) {
            if (p.try_read(x, y) && y != 2 * x) { torn.fetch_add(1, std::memory_order_relaxed); }
        }
    });
    for (std::uint64_t i = 1; i <= 200000; ++i) { p.write(i, 2 * i); }
    stop.store(true, std::memory_order_release);
    reader.join();
    return torn.load(std::memory_order_relaxed) == 0 ? 0 : 1;
}
```

Why the fences: a reader that loads a payload word written after the release fence, and then passes its acquire fence, is ordered after the odd store ([atomics.fences]), so its second `seq` load cannot return the old even value. Dropping either fence lets a torn snapshot validate on Arm and POWER. x86 hides the bug.

## Game engines

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| Fiber jobs, [Gyrling, GDC 2015](https://gdcvault.com/play/1022186/Parallelizing-the-Naughty-Dog-Engine) | Jobs run on fibers. A job that must wait yields its fiber and the worker thread, locked to a core, runs another | P5: blocking pop takes a park/unpark policy so a fiber scheduler can suspend the fiber, not the thread | A futex park inside a fiber stalls the whole worker. Thread-local handle state breaks when a fiber migrates threads. Check: test with a toy fiber scheduler | **adopt** the policy hook |
| Job graph, [Genova, GDC 2015](https://gdcvault.com/play/1022164/Multithreading-the-Entire-Destiny-Engine) | Frame work is a graph with declared dependencies and declared resource access, validated in debug builds (details unverified, from memory of the talk) | When order is static, a graph beats a queue. Borrow the validation: debug builds check each handle's declared role | Validation left on in release costs the hot path | **reject** as a feature. **adopt** debug role checks |
| Chase-Lev deque, [SPAA 2005](https://doi.org/10.1145/1073970.1073974), C11 version [Lê et al. 2013](https://doi.org/10.1145/2442516.2442524) | Owner pushes and pops one end with plain stores, CAS only on the last element. Thieves CAS the other end | Asymmetric roles remove the contended RMW, P1. A handle-local buffer flushed in batches is the queue analogue | Local buffering hides elements from other consumers and weakens I2 visibility. The published C11 code had a resize bug found by [CDSChecker](http://plrg.eecs.uci.edu/publications/c11modelcheck.pdf): peer review did not catch it | **experiment**: handle-local batch buffer, with the ordering contract written down |
| Frame arenas (same Gyrling talk: allocators tagged by frame) | Bump allocate, free everything at frame end, no per-object destructor | Queue of handles or indices into an arena. Trivially destructible `T` must cost zero destructor work in pop and in `~queue` (I6) | Element outlives its arena: use-after-free. Check: ASan with arena poisoning ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) | **adopt** the trivial-type fast path |
| Data-oriented design, [Acton, CppCon 2014](https://www.youtube.com/watch?v=rX0ItVEVjHc) | Lay data out for the access pattern, not the object model | Question the slot as `{sequence, T}`. Alternative: a dense sequence array plus a payload array | A dense sequence array puts 8 sequences per 64-byte line: neighbours false-share exactly where producers and consumers meet. Check: `perf c2c` ([20-profiling.md](20-profiling.md)) | **experiment**, owner [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |

## Linux kernel

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| [RCU](https://docs.kernel.org/RCU/whatisRCU.html), userspace [liburcu](https://liburcu.org/) | Readers write nothing shared. Writers publish a new version and free the old one after a grace period | Segment reclamation in the unbounded variant. Bounded ring has nothing to reclaim | One reader that never passes a quiescent state stops all reclamation: memory grows without bound | **reject** for bounded. **experiment** for segments ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| qspinlock and MCS, [LWN](https://lwn.net/Articles/590243/) | First contender spins on a pending bit. Later ones queue on per-CPU nodes and each spins on its own line | P7. Under saturation, queueing waiters on private lines beats all threads retrying one CAS | It is a lock: holder preemption stalls everyone. Do not call the result lock-free | **experiment** as a contention fallback, never the default |
| io_uring rings, [Axboe](https://kernel.dk/io_uring.pdf) | Two SPSC rings shared by mmap. Free-running indices, power-of-two mask, head and tail written by opposite sides, many entries per syscall | Shared state holds offsets and indices, never pointers, so the layout does not rule out inter-process use (a [01-vision.md](01-vision.md) non-goal that must stay possible) | 32-bit free-running indices are safe there because only `tail - head` matters. A per-slot sequence compared for equality needs 64 bits | **adopt** offsets-only layout |
| [Restartable sequences](https://docs.kernel.org/userspace-api/rseq.html) | Kernel aborts a short user critical section on preemption or migration, giving per-CPU data with no atomics. `mm_cid` gives a dense per-process CPU slot id | Per-CPU (not per-thread) shards and caches bound the shard count by CPUs, not threads | Linux only. Critical section must end in one commit instruction. Debuggers single-stepping inside one loop forever | **experiment** ([13-numa-and-topology.md](13-numa-and-topology.md)) |
| rseq time-slice extension, same doc, Linux 7.0+ | Thread sets `rseq::slice_ctrl::request`. Kernel may defer preemption by a short grant (default 5 µs, per the doc) | Directly targets our worst case: producer preempted between ticket claim and sequence publish | Needs `prctl(PR_RSEQ_SLICE_EXTENSION, ...)`, kernel 7.0+, Kconfig. A grant is a hint, not a guarantee: correctness must not depend on it | **experiment**: tail latency with oversubscription, on and off |
| SLUB, [mm/slub.c](https://github.com/torvalds/linux/blob/master/mm/slub.c), [sheaves update, FOSDEM 2026](https://fosdem.org/2026/schedule/event/DPXVYJ-slub-sheaves-update/) | Per-CPU pointer arrays ("sheaves", the [magazine](https://www.usenix.org/conference/2001-usenix-annual-technical-conference/magazines-and-vmem-extending-slab-allocator-many) idea) replaced the per-CPU freelist: opt-in in 6.18, all caches in 7.0 | Arrays beat linked freelists for batch refill and flush. Use per-handle magazines for the segment pool | Magazines strand memory in idle handles. Check: peak RSS with many idle handles | **adopt** for segment pools ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) |
| `cmpxchg128`, same `slub.c` | Slab freelist pointer and counters updated together by a double-width CAS, the counter acting as the ABA tag. Kept for remote frees after sheaves | Pointer plus tag in one CAS, as LCRQ needs ([03-algorithms.md](03-algorithms.md)) | `std::atomic` of 16 bytes: GCC calls libatomic even with `-mcx16` ([PR 80878](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=80878)) and reports not lock-free. Check: `is_always_lock_free` in a `static_assert` | **reject** on the default path. **opt-in** per algorithm |
| Folios and [THP](https://docs.kernel.org/admin-guide/mm/transhuge.html) | Kernel manages memory in multi-page units. `madvise(MADV_HUGEPAGE)` asks for huge pages on a range | Fewer TLB misses across a large ring | Compaction stalls show up as latency spikes. Conflicts with lazy commit (vision goal 5) | **opt-in**, owner [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |
| [kfifo](https://github.com/torvalds/linux/blob/master/include/linux/kfifo.h) | SPSC ring, free-running unsigned `in` and `out`, mask on access, length is `in - out` across wrap | Our ticket convention: never store a wrapped index, mask at the last moment | Capacity not a power of two breaks the subtraction | **adopt** (already vocabulary) |
| [llist](https://github.com/torvalds/linux/blob/master/include/linux/llist.h) | Lock-less stack: push by CAS, take the whole list by one exchange. Header table states which pairs need a lock | Take-all by exchange has no ABA. Use for waiter lists and retire lists | `del_first` with two consumers is an ABA bug, stated in the header. Take-all returns newest first: reverse for FIFO | **adopt** for side lists. **reject** for the data path |

## Networking and storage

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| DPDK burst, [ring library guide](https://doc.dpdk.org/guides/prog_guide/ring_lib.html) | Bulk is all-or-nothing, burst takes up to n. One CAS claims n slots. HTS and RTS modes serialise or relax tail sync for overcommitted threads | Both batch contracts in the API, P2. A mode for oversubscribed hosts | In-order tail update makes a preempted thread block all later ones. Check: run with threads > cores | **adopt** bulk and burst ([04-api.md](04-api.md)). **experiment** an overcommit mode |
| [SPDK](https://spdk.io/doc/concurrency.html) | Run to completion on one core, no locks on the I/O path, cross-thread work sent as messages | Baseline shape: N threads with message rings instead of one shared queue | Skewed load: one core saturates while others idle | **experiment** as a benchmark baseline |
| [AF_XDP](https://docs.kernel.org/networking/af_xdp.html) | Four SPSC rings carry descriptors (offsets into a shared buffer area), not packets. A `need_wakeup` flag tells the peer when a syscall is required | Move indices, not payloads, for large `T`. The waiter-present flag is `need_wakeup` | Flag set and checked in the wrong order loses a wake | **adopt** the flag, owner [07-waiting.md](07-waiting.md) |
| [BPF ring buffer](https://docs.kernel.org/bpf/ringbuf.html) | MPSC. Reserve under a spinlock, commit by clearing a busy bit in the record header. Data area mapped twice back to back so a record never wraps. Consumer stops at the first busy record | Double mapping gives contiguous batch copies across the wrap | Two mappings per ring cost TLB entries and need `memfd` plus `mmap` tricks. Not portable. A stalled reserver blocks the consumer | **experiment** for batch moves, owner [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |

## Databases

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| [LMAX architecture](https://martinfowler.com/articles/lmax.html) | All business logic on one thread. Concurrency only at the edges | First question for a user: do you need MPMC at all? | Nothing to fail. Guidance | **adopt** in docs |
| Share-nothing, [Seastar](https://seastar.io/shared-nothing/) | One thread per core, explicit message passing between cores | An N×N mesh of SPSC rings is the strongest alternative to one MPMC ring | Mesh needs N² rings and loses global FIFO. Check: same workload, both shapes | **experiment** as baseline. **opt-in** sharded front end |
| Silo epochs, [Tu et al., SOSP 2013](https://doi.org/10.1145/2517349.2522713) | A global epoch advances on a timer. Workers read it and keep all other state local, so commits avoid shared writes | Our ticket counter is exactly the shared write Silo removes. Epochs fit reclamation and coarse stats | Epoch granularity bounds how fresh anything derived from it is | **experiment** ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| Optimistic lock coupling, [Leis et al. 2019](http://sites.computer.org/debull/A19mar/p73.pdf), [Böttcher et al. 2020](https://doi.org/10.1145/3399666.3399908) | Readers load a version, read, re-check the version. No store, so the line stays shared | P3: emptiness and fullness checks are loads only | An algorithm that claims by `fetch_add` and then discovers empty has already written. Check: count stores on the failure path in the disassembly | **adopt** as a design test for every algorithm in [03-algorithms.md](03-algorithms.md) |
| Deterministic simulation, [FoundationDB testing](https://apple.github.io/foundationdb/testing.html) | Whole system runs single-threaded under a seeded scheduler with injected faults. A failing seed replays exactly | Seeded schedule exploration. Debug-only yield points between claim and publish | Simulation tests the model of the scheduler, not real weak memory. Pair with a memory-model checker | **adopt** ([17-testing-and-verification.md](17-testing-and-verification.md)) |
| Static allocation and VOPR, [TIGER_STYLE](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) | All memory allocated at startup. Dense assertions. A seeded simulator runs the real code under faults | Matches I5. Assert invariants I1 to I6 in debug builds | Assertions that read a slot outside its window are themselves races (I4) | **adopt** |

## Language runtimes

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| Go channels, [`chan.go`](https://github.com/golang/go/blob/master/src/runtime/chan.go) | One mutex per channel. A send that finds a parked receiver copies straight to it and skips the buffer | Mutex plus ring is the honest baseline. Direct hand-off to a parked consumer | Hand-off on a non-empty queue breaks FIFO. Only legal when empty | **adopt** the baseline in benchmarks. **experiment** hand-off |
| Go scheduler, [`runtime2.go`](https://github.com/golang/go/blob/master/src/runtime/runtime2.go) | Per-P ring of 256 plus a `runnext` slot, global queue behind a lock | A one-element LIFO slot keeps hot work local, P7 | LIFO slot starves the ring unless bounded. Not FIFO | **reject** for a FIFO queue. Note for scheduler builders |
| crossbeam-epoch, [`internal.rs`](https://github.com/crossbeam-rs/crossbeam/blob/master/crossbeam-epoch/src/internal.rs) | Threads pin an epoch. Garbage goes in bags of 64 and collection runs every 128 pins | Amortised reclamation with constants to start from | A thread that stays pinned blocks all reclamation | **experiment** against hazard pointers ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| [loom](https://github.com/tokio-rs/loom), [Miri](https://github.com/rust-lang/miri) | loom swaps the atomics types and runs every interleaving within a bound. Miri interprets the program and reports UB. Miri's GenMC mode is documented as work in progress | P6: route every atomic through one alias so a checker build can swap it. Tokio does this with `crate::loom::sync::atomic` | A shim that changes layout or inlining hides bugs. Check: shim is a pure alias in release builds | **adopt** the shim |
| Tokio local queue, [`queue.rs`](https://github.com/tokio-rs/tokio/blob/master/tokio/src/runtime/scheduler/multi_thread/queue.rs) | 256-slot ring. Head word packs two indices (steal position, real head) so a thief claims a batch without blocking the owner. Overflow moves half to a shared queue | Pack two positions in one atomic to make a batch claim two-phase | Halves the index width: 32-bit halves wrap, so the ABA argument must be redone (tickets are 64-bit here) | **experiment** for batch pop |
| [JCTools](https://github.com/JCTools/JCTools) `MessagePassingQueue` | `relaxedOffer` and `relaxedPoll` may fail spuriously in exchange for a cheaper path | Name the weaker contract in the API instead of weakening `try_pop` silently | Callers treat a relaxed empty as real empty and stop draining | **adopt** the naming split ([04-api.md](04-api.md)) |
| `@Contended`, [JEP 142](https://openjdk.org/jeps/142) | JVM pads annotated fields. Default padding width is 128 bytes | Independent confirmation of the "do not hard-code 64" rule | None | **adopt** (already a rule) |
| `LongAdder`, [`Striped64.java`](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/concurrent/atomic/Striped64.java) | Starts as one cell. On CAS failure, grows a table of padded cells indexed by a per-thread hash. Read sums the cells | Statistics counters and `size_approx()` (I7) | A sum of cells is not a snapshot and has no order: useless for tickets | **adopt** for counters. **reject** for tickets |
| Virtual threads, [JEP 444](https://openjdk.org/jeps/444), [JEP 491](https://openjdk.org/jeps/491) | Blocking parks the virtual thread, not the carrier. JDK 24 removed pinning inside `synchronized` | Same as fibers, P5 | Same as fibers | **adopt** the policy hook |
| .NET [`ConcurrentQueue`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Collections/Concurrent/ConcurrentQueue.cs) | Linked segments, each a bounded ring with per-slot sequence numbers. Segments start at 32 slots and double up to 1,048,576. A segment can be frozen so enqueues fail and move on | Shape of our segment variant: doubling sizes, freeze instead of a closed flag per op | Doubling makes memory use depend on burst history. A frozen, part-empty segment wastes its tail | **experiment**, owner [03-algorithms.md](03-algorithms.md) |
| Erlang signal queues, [OTP 25 blog](https://www.erlang.org/blog/parallel-signal-sending-optimization/) | Mailbox lock counts contention. Past a threshold the runtime installs 64 buffers, senders hash to one, receiver flushes. Turns itself off when traffic drops. Same sender always maps to the same buffer, so per-sender order holds | P7, and proof that sharding can keep per-producer FIFO (I2) while dropping global FIFO | Receiver must scan all buffers: cost moves to the consumer | **experiment** as an MPSC front end |

## Allocators

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| mimalloc, [Leijen et al.](https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/) | Free lists sharded per page. Owner uses a private list. Other threads push to a separate atomic list that the owner collects in one exchange | P1 and P2 for the segment pool: local list plus remote list, never one shared list | Collection deferred too long strands memory | **adopt** for segment pools |
| snmalloc, [Liétar et al., ISMM 2019](https://doi.org/10.1145/3315573.3329980) | A free from another thread is batched and sent to the owning allocator as a message | Producer allocates, consumer frees is the pattern that stresses allocators. The allocator is a benchmark axis | Reporting queue throughput with payload `new`/`delete` measures the allocator | **adopt** in method ([19-benchmarking.md](19-benchmarking.md)) |
| tcmalloc, [rseq design](https://google.github.io/tcmalloc/rseq.html) | Per-CPU caches updated inside restartable sequences | Per-CPU handle caches without atomics | Linux only. Falls back to per-thread elsewhere, so two code paths to test | **experiment** |
| jemalloc decay, [man page](https://jemalloc.net/jemalloc.3.html) (`dirty_decay_ms`, `muzzy_decay_ms`) | Unused pages return to the OS on a time decay, not at once | Unbounded variant: retire empty segments with hysteresis | Immediate `madvise` on every empty segment thrashes under bursty load. Check: syscall count per million ops | **experiment** |

## Academic

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| Flat combining, [Hendler et al. 2010](https://doi.org/10.1145/1810479.1810540) | Threads publish requests. One takes a lock and applies everyone's against a sequential structure | The data stays in one core's cache. A high-contention variant | Blocking: a preempted combiner stalls all. Low contention pays the publication overhead | **experiment** |
| CC-Synch and DSM-Synch, [Fatourou and Kallimanis 2012](https://doi.org/10.1145/2145816.2145849) | Combining over a queue of request nodes built with exchange. Combiner serves a bounded number, then hands over | Bounded combining work fixes flat combining's unfair combiner | Still blocking | **experiment**, together with flat combining |
| Delegation, [ffwd, SOSP 2017](https://doi.org/10.1145/3132747.3132771) | A dedicated server thread owns the structure. Clients write requests to private lines, responses come back batched | Upper bound to compare against: what one core owning the queue can do | Burns a core. A library cannot spawn hidden threads (vision goal 4) | **reject** in library. **experiment** as baseline |
| Elimination for FIFO, [Moir et al. 2005](https://doi.org/10.1145/1073970.1074013) | Enqueue and dequeue pair off outside the queue, valid only once the enqueue has "aged" to the front | Hand-off on empty is the only cheap legal case | Eliminating on a non-empty queue breaks linearizability. Check: linearizability tester | **experiment**, empty case only |
| Lock cohorting, [Dice et al. 2012](https://doi.org/10.1145/2145816.2145848) | Global lock plus per-node locks. Ownership passes within a NUMA node for a bounded run | Prefer same-node hand-off for a bounded run before crossing sockets | Unbounded local preference starves remote nodes | **opt-in**, owner [13-numa-and-topology.md](13-numa-and-topology.md) |
| k-FIFO, [Kirsch et al. 2013](https://doi.org/10.1007/978-3-642-39958-9_18) | Segments of k slots. Any slot in the head segment may be taken, so order is off by at most k−1 | A relaxed variant with a stated bound | Users assume FIFO. The bound must be in the type name | **opt-in** |
| MultiQueues, [Rihani et al. 2015](https://arxiv.org/abs/1411.1209) | Many sequential queues behind try-locks. Insert at random, remove the better of two random picks | Sharded front end with power-of-two-choices | Order guarantee is probabilistic. Emptiness check must scan every shard | **opt-in** |
| Aggregating funnels, [Roh et al., PPoPP 2025](https://doi.org/10.1145/3710848.3710873) | Threads batch their fetch-and-adds through aggregator objects, so few threads touch the main counter | Attacks our one contended RMW, the ticket counter, without changing the ring | Adds latency at low contention. Arm it adaptively (P7) | **experiment**: first candidate if the ticket line is the bottleneck in `perf c2c` |
| Scalable commutativity rule, [Clements et al. 2015](https://doi.org/10.1145/2699681) | If two operations commute, an implementation exists where they share no written line | Audit the API: exact `size()` commutes with nothing. Push to non-full and pop from non-empty commute only when the queue is neither near empty nor near full | The rule proves existence, not that a given design achieves it | **adopt** as an API review test |
| Wait-free constructions, [Herlihy 1991](https://doi.org/10.1145/114005.102808), [Kogan and Petrank 2012](https://doi.org/10.1145/2145816.2145835) | Helping: slow operations announce themselves and others finish them. Fast-path/slow-path limits the cost | A wait-free variant is possible on top of a lock-free fast path | Helping adds shared writes. Vision non-goal unless opt-in | **opt-in** variant, after the default is proven |

## GPU and accelerators

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| [Broker queue, ICS 2018](https://doi.org/10.1145/3205289.3205291) | Bounded ring plus a counter that settles whether an operation will succeed before it claims a position, for thousands of threads that cannot block. Details beyond the abstract: reread the paper before implementing | A pre-check counter makes full and empty explicit without ticket overshoot | The counter is a second contended RMW per op | **experiment** against sequence-only checks |
| [CUDA unified memory](https://docs.nvidia.com/cuda/cuda-c-programming-guide/index.html) | One address space. Pages migrate between host and device on fault | A CPU-GPU ring on unified memory would migrate pages on every hand-off (hypothesis, not measured) | C++ atomics give no guarantee across host and device code | **reject**, out of scope |

## Formal methods

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| TLA+ at AWS, [Newcombe et al., CACM 2015](https://cacm.acm.org/research/how-amazon-web-services-uses-formal-methods/) | Specify the design, model-check it, before code | Write the slot protocol and the waiter protocol as specs first | A spec assumes sequential consistency unless weak memory is modelled | **adopt** ([17-testing-and-verification.md](17-testing-and-verification.md)) |
| [GenMC](https://github.com/MPI-SWS/genmc), [CAV 2021](https://doi.org/10.1007/978-3-030-81685-8_20) | Stateless model checking of C under RC11 and other weak models | Check the protocol core under weak memory, not just interleavings | Test harness must be small and bounded. C++ library code may need a C-like shim | **adopt** |
| [VSync, ASPLOS 2021](https://doi.org/10.1145/3445814.3446748) | Model-check a primitive, then try weakening each barrier and re-check | Ordering mutation: weaken or strengthen each `memory_order`, a checker must notice | A mutation that survives means a test gap or a needlessly strong ordering | **adopt** |
| [Compass, PLDI 2022](https://doi.org/10.1145/3519939.3523451) | Machine-checked specs for queues and stacks in a relaxed-memory separation logic | Shows what a proved queue spec looks like under weak memory | Proof effort is large. Not a CI tool | **reject** for now, cite as the bar |
| [CDSChecker](https://doi.org/10.1145/2509136.2509514) | Exhaustive C++11 memory-model exploration of unit tests | Found a bug in a peer-reviewed C11 Chase-Lev port, confirmed by its authors | Tool is old. Check it still builds before planning on it | **experiment**, owner [17-testing-and-verification.md](17-testing-and-verification.md) |

## Compiler and binary work

| Idea and source | Mechanism | Suggests for our queue | Fails when / how to check | Verdict |
|---|---|---|---|---|
| [BOLT](https://github.com/llvm/llvm-project/tree/main/bolt), [CGO 2019](https://doi.org/10.1109/CGO.2019.8661201) | Post-link reordering of blocks and functions from a profile | Header-only code lands in the user's binary: we cannot ship layout. We can keep the fast path small and the slow path out of line | A benchmark binary tuned with BOLT flatters us. Report with and without | **opt-in**, owner [21-build-and-toolchain.md](21-build-and-toolchain.md) |
| [Propeller](https://github.com/google/llvm-propeller), [ASPLOS 2023](https://doi.org/10.1145/3575693.3575727) | Same goal by relinking with basic-block sections | Same as BOLT | Same as BOLT | **opt-in** |
| Superoptimisers, [Souper](https://arxiv.org/abs/1711.04422), [STOKE](https://github.com/StanfordPL/stoke) | Search for a shorter equivalent instruction sequence | Fast path is a handful of instructions: read the assembly, run `llvm-mca` ([20-profiling.md](20-profiling.md)) | They reason about sequential semantics. A rewrite that is equal single-threaded can break an atomic protocol | **reject** as a tool. Hand-inspect instead |

## Hardware features

Status as of 2026-11. Re-check before relying on any row.

| Feature | What it is | Status | Suggests | Verdict |
|---|---|---|---|---|
| Intel TSX (RTM) | Hardware transactions | Intel only. Disabled by microcode on many client parts in 2021 ([report](https://www.theregister.com/2021/06/29/intel_tsx_disabled)). Linux has an `auto` mode that enables it only on CPUs without the TAA bug ([`tsx.c`](https://github.com/torvalds/linux/blob/master/arch/x86/kernel/cpu/tsx.c)) | Elide the claim-publish pair | **reject**: not portable, can vanish with a microcode update |
| UINTR (`SENDUIPI`) | Interrupt sent thread to thread without the kernel | Posted as an [RFC in 2021](https://lwn.net/Articles/871113/). No UINTR feature bit in mainline [`cpufeatures.h`](https://github.com/torvalds/linux/blob/master/arch/x86/include/asm/cpufeatures.h) at 7.4-rc4 | Wake a spinning consumer without a futex | **reject** until mainline |
| WAITPKG ([`UMWAIT`](https://www.felixcloutier.com/x86/umwait), `TPAUSE`), AMD `MWAITX` | User-mode wait on a monitored line, with a timeout | Both have feature bits in `cpufeatures.h`. Linux caps `UMWAIT` time via `/sys/devices/system/cpu/umwait_control` | Replace part of the spin phase: sleep until the slot's sequence line is written | **experiment** ([07-waiting.md](07-waiting.md)): wake latency against `PAUSE` |
| [`CLDEMOTE`](https://www.felixcloutier.com/x86/cldemote) | Hint: move a line to a shared cache level. Executes as a NOP where unsupported | Feature bit in `cpufeatures.h` | Producer demotes a slot after publishing so the consumer's miss is cheaper | **experiment** ([12-cpu-and-cache.md](12-cpu-and-cache.md)) |
| [`ENQCMD`](https://www.felixcloutier.com/x86/enqcmd), [`MOVDIR64B`](https://www.felixcloutier.com/x86/movdir64b) | 64-byte command written to a device work queue. `ENQCMD` reports "not accepted" in ZF | Intel. We found no AMD documentation for `ENQCMD` (unverified) | Device queues only. The contract (status flag, caller retries) matches `try_push` | **reject**: not a memory queue |
| Arm FEAT_LSE128 | 128-bit atomic swap, set and clear (`SWPP`, `LDSETP`, `LDCLRP`). Not a 128-bit add | Optional from Armv9.4. GCC libatomic uses it when present ([commit](https://gcc.gnu.org/pipermail/gcc-cvs/2024-January/397906.html)). No named core in LLVM's [`AArch64Processors.td`](https://github.com/llvm/llvm-project/blob/main/llvm/lib/Target/AArch64/AArch64Processors.td) lists it | Nothing yet | **reject**, re-check yearly |
| Arm FEAT_LRCPC3 | Load-acquire and store-release pairs (`LDIAPP`, `STILP`) | Listed for Arm C1 cores and HiSilicon HIP12 in the same LLVM file | Compiler's job. Build with the right `-mcpu` | **reject** as a code change |
| CXL memory | Memory expanders that Linux exposes as NUMA nodes without CPUs ([docs](https://docs.kernel.org/driver-api/cxl/index.html)) | Shipping | A ring must never land there by accident. Check `numa_maps` | **adopt** the placement check ([13-numa-and-topology.md](13-numa-and-topology.md)) |

## How to re-check this doc

| Claim type | Command or place |
|---|---|
| Kernel feature present | `gh api repos/torvalds/linux/contents/arch/x86/include/asm/cpufeatures.h --jq .content \| base64 -d \| grep -i <feature>` |
| Arm core feature | `grep -n LSE128 llvm/lib/Target/AArch64/AArch64Processors.td` in llvm-project |
| Constants quoted from runtimes (256, 64, 128, 32) | Open the linked source file, search the constant name |
| Paper identity | `curl -sLH 'Accept: application/vnd.citationstyles.csl+json' https://doi.org/<doi>` |
| Seqlock snippet | `bun scripts/check-snippets.ts docs/idea/24-inspiration.md` |
