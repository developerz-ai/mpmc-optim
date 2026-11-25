# 🧮 CPU and cache

**Count an operation in cache-line ownership transfers, not instructions.** An uncontended atomic RMW costs 8 to 23 cycles; the same RMW on a line another core just wrote costs 100 to 400. Everything else on this page is a second-order effect.

Status: design. Cycle counts are cited from public measurements with their hardware. Nothing here was measured on this project's code. As of 2026-11.

Owned elsewhere: orderings and fences ([05-memory-model.md](05-memory-model.md)), layout, false sharing, destructive size and 4K aliasing ([09-cache-friendly-allocation.md](09-cache-friendly-allocation.md)), spin and park policy ([07-waiting.md](07-waiting.md)), sockets and CCXs ([13-numa-and-topology.md](13-numa-and-topology.md)), `perf c2c` and top-down ([20-profiling.md](20-profiling.md)).

## Rules

- A push or pop budget is **one contended RMW on a shared counter plus the slot hand-off** ([01-vision.md](01-vision.md)). Every extra shared line written needs a written reason.
- Prefer an RMW that always succeeds (`fetch_add`, `exchange`) over a CAS loop on a contended word. A failed CAS pays the full line transfer and does no work.
- Never load a shared word and then RMW it without a reason: that is two coherence transactions (Shared, then upgrade). Use the RMW alone, or prefetch for write first.
- Cache remote counters in the handle. Re-read the shared line only when the cached value says "full" or "empty".
- Batch: one `fetch_add(k)` claims k tickets.
- Spin-loop bodies MUST contain a pause hint ([07-waiting.md](07-waiting.md)). Reason: [memory-ordering machine clears](#store-buffer-forwarding-and-machine-clears).
- Every `std::atomic` MUST be naturally aligned and inside one cache line. A lock-prefixed op that straddles two lines is a [split lock](#split-locks).
- No claim about any item on this page without a counter reading: [How to check](#how-to-check).

## Coherence protocols

A line is owned by at most one core in a writable state. Writing a line someone else holds means a request for ownership (RFO): the other copies are invalidated and the data travels.

| State | Meaning | Local read | Local write |
|---|---|---|---|
| **M** Modified | Only copy, dirty | Free | Free |
| **E** Exclusive | Only copy, clean | Free | Free, silent upgrade to M |
| **S** Shared | Clean, others may hold it | Free | RFO: invalidate all sharers first |
| **I** Invalid | Not here | Miss: fetch from owner or memory | Miss plus RFO |
| **O** Owned (MOESI) | Dirty, but shared with readers | Free | RFO to the sharers |
| **F** Forward (MESIF) | The one Shared copy that answers requests | Free | RFO |

| Vendor | Protocol | Source |
|---|---|---|
| AMD | MOESI | AMD64 Architecture Programmer's Manual vol. 2 (doc 24593), "Memory Coherency and Protocol" |
| Intel | MESIF | [David et al., SOSP 2013](https://sigops.org/s/conferences/sosp/2013/papers/p33-david.pdf) §3: the Xeon "extends the MESI protocol with the forward state" |
| Arm | Implementation defined per core and interconnect (AMBA ACE/CHI) | Check the core's TRM. Do not assume |

Consequences for a queue:

- A **reader** of a line another core writes forces M to S (or O) there, and the next write by the owner pays an RFO. A "read-only" peek at head or tail is not free for the writer.
- A line bouncing between N writers costs one transfer per write. No protocol state fixes this. Only fewer shared writes do.
- Protocol names do not predict cost. Topology does: see the next table.

## What a contended RMW costs

Published measurements. Old hardware, but the only public table that separates state from distance.

[David, Guerraoui, Trigonakis, SOSP 2013](https://sigops.org/s/conferences/sosp/2013/papers/p33-david.pdf), Table 2, cycles, line last touched by another core:

| Machine | Operation, previous state | Same die | Next socket (one hop) | Two hops |
|---|---|---|---|---|
| 8x Xeon E7-8867L (Westmere-EX) | Load, Modified | 109 | 289 | 400 |
| same | Load, Shared | 44 | 223 | 334 |
| same | Store, Shared | 116 | 318 | 428 |
| same | Atomic RMW, Modified | 120 | 324 | 430 |
| 4x Opteron 6172 (Magny-Cours) | Load, Modified | 81 | 172 | 252 |
| same | Store, Shared | 246 | 286 | 296 |
| same | Atomic RMW, Modified | 110 | 216 | 296 |
| same | Atomic RMW, Shared | 272 | 312 | 332 |

Same paper, Table 3: an L1 hit is 3 to 5 cycles on those machines. One contended RMW is worth 20 to 100 L1 hits.

The uncontended floor, from [uops.info `LOCK XADD m64, r64`](https://uops.info/html-instr/XADD_LOCK_M64_R64.html), measured latency in cycles (line already Modified in L1):

| Core | Cycles | Core | Cycles |
|---|---|---|---|
| Haswell | 19 | Zen+ | 8 |
| Skylake, Skylake-X, Cascade Lake | 18 | Zen 2 | 15 |
| Ice Lake, Tiger Lake, Rocket Lake | 20 | Zen 3, Zen 4 | 8 |
| Alder Lake-P, Emerald Rapids | 18 | Zen 5 | 15 |
| Arrow Lake-P | 20 | Alder Lake-E | 18 |

Modern single-socket figures in nanoseconds, by CAS ping-pong between two pinned cores ([nviennot/core-to-core-latency](https://github.com/nviennot/core-to-core-latency), README, medians): about 20 ns on small Intel desktop parts, 44 to 51 ns on Xeon servers, 17 to 24 ns inside an AMD CCX and 84 to 110 ns across CCXs, 4 to 10 ns between SMT siblings on x86. Cross-socket is 2 to 3 times the same-socket figure. Topology detail: [13-numa-and-topology.md](13-numa-and-topology.md).

How it goes wrong: a benchmark thread that runs many consecutive operations keeps the line in M and reports the uncontended floor (the SOSP paper calls these "long runs" and inserts a pause to prevent them). Method: [19-benchmarking.md](19-benchmarking.md).

## Store buffer, forwarding and machine clears

| Fact | Source | Consequence |
|---|---|---|
| Stores retire into a per-core store buffer and reach the cache later. Loads may pass older stores to other addresses | [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) vol. 3A, "Memory Ordering" | On x86 the only visible reordering is store then load. Dekker-style code needs a full barrier ([05-memory-model.md](05-memory-model.md), [07-waiting.md](07-waiting.md)) |
| A locked instruction drains the store buffer and acts as a full barrier | Intel SDM vol. 3A, "Locked Atomic Operations" | A `seq_cst` store compiles to `xchg`. `atomic_thread_fence(seq_cst)` compiles to `lock or $0,(%rsp)` on GCC 16 and Clang 22 (checked with `-O3 -S`), not `mfence` |
| A load fully covered by one earlier store forwards from the buffer. A load wider than the store, or spanning two stores, stalls until the store commits | [Agner Fog, microarchitecture manual](https://www.agner.org/optimize/microarchitecture.pdf), store forwarding sections per core | Write a slot's sequence word with one full-width store. Never write its bytes separately and then load the whole word |
| A speculative load whose line is written by another core before the load retires is replayed: a memory-ordering machine clear, which flushes the pipeline | [SDM `PAUSE`](https://www.felixcloutier.com/x86/pause): spin-wait loops "suffer a severe performance penalty when exiting the loop because it detects a possible memory order violation"; `PAUSE` avoids it "in most situations" | Any loop polling a word another core will write takes the clear exactly when the wait ends, on the latency-critical iteration |

When this matters: consumers polling a slot sequence, producers polling head. When it does not: the uncontended fast path.

How to check: `perf stat -e machine_clears.memory_ordering` (Intel event name; list yours with `perf list | grep -i clear`). A count that scales with wake-ups, not with operations, is the spin-exit clear.

## LOCK, XADD, CMPXCHG

x86. A locked instruction takes the line exclusive, holds it for the read-modify-write, and is a full barrier.

| Instruction | C++ | On contention |
|---|---|---|
| `lock xadd` | `fetch_add` | Always succeeds. One line transfer buys one completed operation |
| `xchg` (implicit lock) | `exchange`, `seq_cst` store | Always succeeds |
| `lock cmpxchg` | `compare_exchange_*` | May fail. The transfer is paid either way |
| `lock bts`, `lock or`, `lock and` | `fetch_or`, `fetch_and` when the result is unused or one bit is tested | Always succeeds |

Why a failed CAS is not cheap: `CMPXCHG` writes on every execution. [SDM `CMPXCHG`](https://www.felixcloutier.com/x86/cmpxchg): "the destination operand receives a write cycle without regard to the result of the comparison". The line arrives exclusive, the comparison fails, the thread retries, and the line has already left.

Evidence:

- [Dice, Hendler, Mirsky, "Lightweight Contention Management for Efficient Compare-and-Swap Operations"](https://arxiv.org/abs/1305.5800) (Euro-Par 2013): software backoff after a failed CAS greatly improves throughput under medium and high contention, small cost at low contention.
- The SOSP 2013 paper §5.4 compares hardware fetch-and-increment against a CAS loop that implements the same increment, to show "the costs of spinning until the CAS is successful".
- Queue designs built on this: [03-algorithms.md](03-algorithms.md), [02-prior-art.md](02-prior-art.md).

| Technique | When to use | When NOT to | How it goes wrong | How to check |
|---|---|---|---|---|
| `fetch_add` ticket claim | Many producers or consumers on one counter | The claim can overshoot and needs undo logic the algorithm cannot express | Overshoot past full or empty: tickets claimed that nobody can serve | Model check the full and empty paths ([17-testing-and-verification.md](17-testing-and-verification.md)) |
| CAS claim | Conditional claim (only if not full) | High contention with no backoff | Throughput falls as threads rise: retries multiply transfers | Count failures per success. Above 1 at target load: redesign or back off |
| Load, test, then CAS | The test usually fails, so the CAS is usually skipped | The test usually passes | Two transactions per success (S then upgrade to M) | `perf c2c` shows the line under both load and store HITMs |
| Backoff after failed CAS | CAS is unavoidable | Latency-critical single retry | Backoff tuned on one machine is wrong on the next: `PAUSE` length varies 50x | Sweep the constant per machine ([07-waiting.md](07-waiting.md)) |

Pitfall: `compare_exchange_weak` in a loop and `compare_exchange_strong` once compile to the same `lock cmpxchg` on x86. They differ on Arm without LSE, where weak can fail spuriously.

## Arm: LL/SC, LSE and outline atomics

| Mechanism | Instructions | Behaviour under contention |
|---|---|---|
| LL/SC (Armv8.0) | `LDXR` / `STXR` loop | The store-exclusive fails if the exclusive monitor was cleared. The loop retries. Progress is not guaranteed by the architecture for an arbitrary loop body |
| LSE (Armv8.1, `FEAT_LSE`) | `CAS`, `LDADD`, `SWP`, `LDSET`, `LDCLR` | One instruction, no retry loop for `LDADD` and `SWP` |
| Outline atomics | Call to `__aarch64_ldadd8_acq_rel` and friends in libgcc or compiler-rt, which test a flag set at start-up from `AT_HWCAP` and branch to LSE or LL/SC | One extra call and branch per atomic op |

- `-moutline-atomics` is on by default since GCC 10.1 when the target lacks `+lse` ([GCC bug 95128](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=95128), [AArch64 options](https://gcc.gnu.org/onlinedocs/gcc/AArch64-Options.html)). Clang does the same on Linux ([D93585](https://reviews.llvm.org/D93585)).
- To inline LSE: `-march=armv8.1-a` or later, or an `-mcpu=` that implies it. Then the binary faults on Armv8.0 cores.
- When NOT to: a distributed binary that must run on Armv8.0. Keep outline atomics and accept the call.
- How it goes wrong: a benchmark built with the distro default compares an x86 inline `lock xadd` against an Arm function call and blames the core.
- How to check: `objdump -d | grep -c __aarch64_` must be 0 on a build meant to inline. Flags: [21-build-and-toolchain.md](21-build-and-toolchain.md).
- Memory orderings are visible in the instruction choice on Arm (`LDADDA`, `LDADDAL`, plain `LDADD`). A missing acquire or release is a real bug there, not a style issue ([05-memory-model.md](05-memory-model.md)).

## Prefetch for write, demote, non-temporal

| Hint | x86 | AArch64 | Effect |
|---|---|---|---|
| Prefetch for write | [`PREFETCHW`](https://www.felixcloutier.com/x86/prefetchw) | `PRFM PSTL1KEEP` | Fetches the line and invalidates other copies: the RFO starts early |
| Demote | [`CLDEMOTE`](https://www.felixcloutier.com/x86/cldemote) (`-mcldemote`, `_mm_cldemote`) | None | Hint to move the line to a more distant cache level, which "may accelerate subsequent accesses to the line by other cores" |
| Non-temporal store | [`MOVNTI`](https://www.felixcloutier.com/x86/movnti), `MOVNTDQ` | `STNP` (hint only) | Bypasses the cache through write-combining buffers. Weakly ordered: needs `SFENCE` before publishing |

| Technique | When to use | When NOT to | How it goes wrong | How to check |
|---|---|---|---|---|
| Prefetch for write before load-then-RMW | The slot line is known a few operations ahead, or a load must precede the RMW | The line is usually already Modified locally | Steals the line from a core that was about to use it: more transfers, not fewer | A/B on throughput and on HITM counts. The SOSP 2013 paper reports up to 2x on a 48-core ticket lock from `prefetchw` before the load, on Opteron |
| `CLDEMOTE` after writing a payload the consumer reads on another core | Hand-off latency dominates and the CPU has it (check the `cldemote` flag in `/proc/cpuinfo`; GCC enables it for `-march=tremont` and `sapphirerapids`) | Producer touches the line again soon | Demotes a line the producer still needs. Decodes as a NOP on CPUs without it, so tests pass and nothing changes | Hypothesis until measured: p99 hand-off latency with and without, pinned |
| Non-temporal payload copy | Payload far larger than a cache level, consumer does not read it soon | Normal queue payloads: the consumer reads it next and now misses to DRAM | Forgetting `SFENCE`: the sequence store is ordinary, the data is not there yet | Rules and snippet policy: [14-simd.md](14-simd.md) |

Pitfall checked on this toolchain: `__builtin_prefetch(p, 1, 3)` emits `prefetcht0`, a read prefetch, on x86-64 unless `-mprfchw` (or an `-march` that implies it) is set. With `-mprfchw` both GCC 16 and Clang 22 emit `prefetchw`. Inspect the assembly.

Pitfall: prefetching a slot is fine. Prefetching and then **inspecting** it before the sequence grants access is a data race (invariant I4, [01-vision.md](01-vision.md)).

```cpp
// check: compile
#include <atomic>
#include <cstdint>

// Remote counter cached in the handle: the common case touches no shared line.
struct ProducerHandle {
    std::uint64_t cached_head = 0;   // stale is safe: head only grows
};

[[nodiscard]] inline bool has_room(const std::atomic<std::uint64_t>& head, ProducerHandle& h,
                                   std::uint64_t tail, std::uint64_t capacity) noexcept {
    if (tail - h.cached_head < capacity) return true;        // 0 shared lines read
    h.cached_head = head.load(std::memory_order_acquire);    // 1 miss: pairs with consumer's release
    return tail - h.cached_head < capacity;
}

// Batching: one contended RMW claims k tickets instead of k RMWs.
[[nodiscard]] inline std::uint64_t claim(std::atomic<std::uint64_t>& tail, std::uint64_t k) noexcept {
    return tail.fetch_add(k, std::memory_order_relaxed);     // ticket only; data is published by the slot sequence
}

// Ask for the line in Modified state before a load-then-RMW sequence.
inline void prefetch_for_write(const void* p) noexcept {
#if defined(__GNUC__) || defined(__clang__)
    __builtin_prefetch(p, 1, 3);   // x86: PREFETCHW only with -mprfchw; AArch64: PRFM PSTL1KEEP
#else
    (void)p;
#endif
}
```

## PAUSE and SMT

`PAUSE` length is not a constant. [uops.info `PAUSE`](https://uops.info/html-instr/PAUSE.html), measured cycles per instruction:

| Core | Cycles | Core | Cycles |
|---|---|---|---|
| Nehalem to Broadwell | 9 to 11 | Zen+ | 3 |
| Skylake, Kaby Lake, Skylake-X | 140 | Zen 2, 3, 4, 5 | 65 |
| Coffee Lake | 152 | Alder Lake-E | 62 |
| Cascade Lake | 40 | Meteor Lake-E | 81 |
| Ice Lake, Tiger Lake, Rocket Lake | 138 to 145 | Arrow Lake-E | 76 |
| Alder Lake-P, Meteor Lake-P | 160 to 165 | Tremont | 176 |
| Emerald Rapids | 34 | Arrow Lake-P | 43 |

The Skylake change is documented in the Intel optimization manual ("as many as 140 cycles", quoted in [this LKML thread](https://lkml.iu.edu/2107.2/07415.html)). A loop of "100 pauses" is 300 cycles on Zen+ and 16 000 on Alder Lake-P. Budget spins in time: [07-waiting.md](07-waiting.md).

SMT (two hardware threads per core):

| Effect | Consequence |
|---|---|
| Siblings share L1 and L2, so a line "moves" between them in 4 to 10 ns (nviennot README) | Producer and consumer on siblings: lowest hand-off latency |
| Siblings share one core's execution resources | Same pair: each runs slower. Report throughput per core, not per thread |
| A spinning sibling without `PAUSE` takes resources from the working sibling | `PAUSE` in every spin loop, even "short" ones |

When to pin to siblings: latency of a single producer-consumer pair. When NOT to: throughput benchmarks, which should use one thread per core and say so. How to check: `thread_siblings_list` in sysfs ([13-numa-and-topology.md](13-numa-and-topology.md)).

## Branches, code layout

| Topic | Rule | How it goes wrong | How to check |
|---|---|---|---|
| Full and empty checks | Leave them as branches with the common outcome on the fall-through path. They are almost always predicted | Converting to `cmov` puts the comparison on the data-dependency chain of every operation | `perf stat -e branch-misses` per operation |
| Mispredict cost | Roughly a pipeline refill, 10 to 20 or more cycles depending on the core ([Agner Fog, microarchitecture manual](https://www.agner.org/optimize/microarchitecture.pdf), branch prediction chapters). Small next to one line transfer | Optimising branches while the profile is dominated by HITMs | Top-down "bad speculation" ([20-profiling.md](20-profiling.md)) |
| Index wrap | Mask with `capacity - 1` (power-of-two ring). No branch, no division | A non-power-of-two capacity sneaks in a `div` | Read the assembly |
| Branchless select | Use when the outcome is data dependent and near 50/50 (for example which shard to try) | The compiler turns the source `?:` back into a branch, or the reverse | Read the assembly. Do not trust the source shape |
| CAS retry loops | Retry is the cold path. Mark with `[[unlikely]]` only after a profile says so | Wrong hint moves the hot path out of line | PGO beats hand hints ([21-build-and-toolchain.md](21-build-and-toolchain.md)) |
| Alignment of hot loops | Unrelated edits shift code across 32 and 64-byte boundaries and change the result | On Skylake-family cores with the JCC erratum microcode, a jump that crosses or ends on a 32-byte boundary is not cached in the uop cache. Assembler mitigation: `-Wa,-mbranches-within-32B-boundaries` | Rerun with a different link order or alignment before believing a small delta ([19-benchmarking.md](19-benchmarking.md)) |
| Inlining of the fast path | Fast path inline, slow path (`full`, `empty`, park) out of line and `[[gnu::cold]]` | A large inlined slow path evicts the caller's hot code from the uop cache | `perf stat -e idq.dsb_uops,idq.mite_uops` on Intel |

4K aliasing between a store and a later load at the same page offset: owned by [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md).

## Split locks

A locked operation whose operand crosses a cache-line boundary cannot use a line lock. The CPU locks the bus: every core stalls.

| Fact | Source |
|---|---|
| Linux detects them (`#AC` for split locks, `#DB` for bus locks) and by default warns and slows the offending task. `split_lock_detect=fatal` sends `SIGBUS`; `ratelimit:N` caps bus locks system-wide | [Kernel docs: bus lock detection and handling](https://docs.kernel.org/arch/x86/buslock.html) |
| `#AC` split-lock detection starts with Intel Tremont | same |

- How it happens: `#pragma pack`, `alignas(1)` wrappers, an atomic placement-constructed at an unaligned offset inside arena memory, a 16-byte CAS (`cmpxchg16b`) on an object aligned to 8.
- When to care: always. A library that split-locks slows every tenant on the host and may be killed for it.
- How to check: `static_assert(alignof(T) >= sizeof(T))` for every atomic word type, UBSan `-fsanitize=alignment` ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)), `dmesg | grep -i 'split lock'`, `perf stat -e sq_misc.split_lock` on Intel.
- Arm: keep the same rule. Atomic instructions there expect naturally aligned operands; check the Arm ARM for the fault behaviour of your target.

## Fewer RMWs: cache, batch, combine

| Technique | Idea | When to use | When NOT to | How it goes wrong |
|---|---|---|---|---|
| Cached remote counter | Keep the last-seen head (or tail) in the handle. Refresh on apparent full or empty | Always, where the algorithm reads the opposite counter | The algorithm never reads it | Treating the stale value as truth for a decision other than "retry with a fresh read" (I7) |
| Batch claim | `fetch_add(k)` for k elements, then k slot hand-offs | Producers or consumers that have several items in hand ([04-api.md](04-api.md)) | Single-item latency paths | A claimed-but-unpublished ticket range blocks consumers behind it for the whole batch: the blocking window grows with k ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| Sharding | N independent rings, each with its own counters | Contention on one counter is the measured bottleneck | Global FIFO is required | Order and fairness change. Owned by [13-numa-and-topology.md](13-numa-and-topology.md) |
| Flat combining | Threads publish requests; whoever holds a lock applies all of them, keeping the data structure in one cache | Very high contention where the structure is otherwise sequential | Low contention: the publication list costs more than the CAS it replaces | The combiner is a lock holder: preempt it and everyone waits. Mutex-free claims no longer hold |
| Aggregating funnels | Spread `fetch_add` callers over several aggregator words so one hardware RMW on the main counter serves a batch | Counter contention at high thread counts | Few threads | Extra indirection on the uncontended path |

Sources: [Hendler, Incze, Shavit, Tzafrir, "Flat Combining and the Synchronization-Parallelism Tradeoff"](https://people.csail.mit.edu/shanir/publications/Flat%20Combining%20SPAA%2010.pdf) (SPAA 2010). [Roh et al., "Aggregating Funnels for Faster Fetch&Add and Queues"](https://arxiv.org/abs/2411.14420) (PPoPP 2025) reports up to 2.5x for a fetch-and-add queue with the counter replaced.

## Counting cost per operation

Count per successful push or pop, at steady state, with every other thread active. Write the table in the design doc before writing code.

| # | Count | Weight | Why |
|---|---|---|---|
| 1 | Contended RMWs (locked ops on lines other cores write) | Highest | One line transfer each, 100+ cycles, serialises the store buffer |
| 2 | Lines **written** that another core reads or writes later | High | Each is an invalidation now and a miss for them later |
| 3 | Lines **read** that another core wrote last | High | A miss served from another core's cache |
| 4 | Failed attempts per success (CAS failures, retries) | Multiplies 1 to 3 | A failure pays the transfer and repeats it |
| 5 | Full barriers that are not already a locked RMW | Medium | About the uncontended RMW floor |
| 6 | Mispredicted branches | Low | 10 to 20 cycles |
| 7 | Uncontended instructions, L1 hits | Ignore until 1 to 6 are minimal | A few cycles in total |

Rules for counting:

- Count **lines**, not variables. Two atomics on one line are one transfer if written by the same core in the same operation, and false sharing if written by different roles ([09-cache-friendly-allocation.md](09-cache-friendly-allocation.md)).
- A slot's sequence word and its payload on the same line: one transfer for the hand-off. On different lines: two.
- A line written by a producer and later read by a consumer costs one transfer per element at minimum. That is the hand-off; it cannot be removed, only batched (several elements per line).
- A read of a counter cached in the handle counts as zero. Count the refresh rate instead.
- Waiting counts separately: a notify that is "one load" is one line read (row 3) on a line waiters write ([07-waiting.md](07-waiting.md)).
- State the count for the uncontended case and for the contended case. They differ by row 4.

Worked shape, not a design decision: a ring that claims with one RMW on a shared counter and hands off through a per-slot sequence costs one row-1 item, plus the slot line (rows 2 and 3 on the same line), plus an occasional refresh of the cached opposite counter. That is the target in [01-vision.md](01-vision.md). Which algorithm meets it: [03-algorithms.md](03-algorithms.md).

## How to check

| Question | Tool |
|---|---|
| Which lines bounce, and who writes them | `perf c2c record` / `perf c2c report`: HITM counts per line and per symbol ([20-profiling.md](20-profiling.md)) |
| Is a spin exit paying a clear | `perf stat -e machine_clears.memory_ordering` |
| Did the compiler emit the RMW I think | `objdump -d`, or `-S`: look for `lock xadd`, `lock cmpxchg`, `xchg`, `prefetchw`, `__aarch64_*` |
| Static cost of a straight-line path | `llvm-mca`. It models no cache misses: use it for rows 5 to 7 only |
| Split locks | `dmesg`, `perf stat -e sq_misc.split_lock` |
| Failed CAS per success | A debug-build counter in the handle, compiled out of release builds |
| Core-to-core floor of this machine | [nviennot/core-to-core-latency](https://github.com/nviennot/core-to-core-latency), on an idle box |

A cycle count from a table on this page is a prior, not a result. A performance claim needs the benchmark in [19-benchmarking.md](19-benchmarking.md).
