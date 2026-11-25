# Tricks on one page

**Rule: a trick is a hypothesis until its "how to check" column has been run on your machine.** This page is an index. The owning doc holds the detail, the proof and the numbers. Words follow [01-vision.md](01-vision.md). Nothing here is measured by us yet.

## Try these first

Ordered by expected return per hour of work (ordering is a hypothesis, to be confirmed in [19-benchmarking.md](19-benchmarking.md)). Stop at the first rung that is not yet done.

| # | Step | Why first |
|---|---|---|
| 1 | Pick the weakest role set: SPSC, MPSC, then MPMC | Removes contended RMWs entirely. No tuning beats not sharing |
| 2 | Prove the protocol: model checker, TSan, linearizability test | A fast wrong queue is worth nothing |
| 3 | Measure correctly: pinned, spread reported, tail latency | Every later rung depends on trusting a delta |
| 4 | Separate head, tail and slots by destructive size | False sharing is the largest common loss and is cheap to fix |
| 5 | Batch push and pop | One ticket RMW covers n elements |
| 6 | Failure paths write nothing shared | Empty and full polling stops invalidating lines |
| 7 | Wait policy: bounded spin, then park, wake only if a waiter is flagged | Removes syscalls from the uncontended path |
| 8 | Memory placement: first touch, huge pages, prefault opt-in | Removes TLB and page-fault tails |
| 9 | Build: `-O2`, LTO, PGO | Free once benchmarks are trustworthy |
| 10 | Everything else on this page | Only with a profile that points at it |

## Contention

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Weakest role set | No CAS where one writer exists | Roles are fixed by design | A second producer appears later | Debug role assertion | [04-api.md](04-api.md) |
| Batch claim of n tickets | One contended RMW per batch | Bursty producers | Batch held while others starve | Ops per ticket RMW | [04-api.md](04-api.md) |
| Load-only empty and full checks | Line stays in shared state | Polling consumers | Never, if the algorithm allows it | Count stores on the failure path in disassembly | [03-algorithms.md](03-algorithms.md) |
| Handle-cached copy of the opposite counter | Avoids reading a line the other side writes | Queue is neither empty nor full | Stale cache hides progress: must refresh before reporting failure | `perf c2c` on head and tail | [12-cpu-and-cache.md](12-cpu-and-cache.md) |
| Shard into several rings | Divides the ticket line's traffic | Global FIFO not required | Emptiness needs a scan of all shards | Throughput against shard count | [13-numa-and-topology.md](13-numa-and-topology.md) |
| Backoff after a failed CAS | Fewer threads retry at once | Threads exceed cores on the line | Low contention: pure added latency | Tail latency with and without | [07-waiting.md](07-waiting.md) |
| Adaptive machinery armed by failure count | Uncontended path stays minimal | Load varies | Thresholds tuned on one machine | Step-load benchmark | [24-inspiration.md](24-inspiration.md) |
| Combining or funnels on the ticket counter | Few threads touch the hot line | Saturated many-core | Low contention | `perf c2c` shows the ticket line dominant | [24-inspiration.md](24-inspiration.md) |

## Layout

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Align head and tail to destructive size | Producers and consumers stop invalidating each other | Always for MPMC | Thousands of tiny queues: padding dominates memory | `perf c2c` HITM count | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| Use the destructive-size constant, not 64 | Adjacent-line prefetch and 128-byte lines exist | Portable builds | ABI: the constant can differ between TUs and flags | `static_assert` on layout | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| Sequence and element in one slot | One miss serves both | Small `T` | `T` larger than a line | Cache misses per op | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| Hot and cold split of queue fields | Hot line holds only what each op reads | Queue has config, stats, names | Over-splitting adds misses | `pahole` | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| Power-of-two capacity, mask at last moment | Mask replaces division, tickets stay monotonic | Always | User wanted an exact odd capacity | Disassembly has no `div` | [03-algorithms.md](03-algorithms.md) |
| Offsets, not pointers, in shared state | Layout stays position independent | Future shared-memory use | Slight address arithmetic | Review | [24-inspiration.md](24-inspiration.md) |
| Store indices for large `T` | Slot stays one line | `T` over a line, or not nothrow-movable | Extra indirection for small `T` | Bytes moved per op | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |

## Atomics

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Explicit `memory_order` with the edge commented | Reviewer can pair every release with its acquire | Always | Never | Ordering audit, ordering mutation | [05-memory-model.md](05-memory-model.md) |
| 64-bit tickets | Wrap is out of reach, so no ABA by wrap | Always | 32-bit targets pay for wide atomics | `static_assert` on width | [06-progress-and-reclamation.md](06-progress-and-reclamation.md) |
| `static_assert(is_always_lock_free)` | Catches silent libatomic fallback | Always | Never | Compile | [05-memory-model.md](05-memory-model.md) |
| Avoid 16-byte atomics on the default path | GCC routes them through libatomic | Portable builds | An algorithm truly needs double-width CAS | `objdump` for `__atomic_` calls | [24-inspiration.md](24-inspiration.md) |
| Atomics behind one alias | A checker build can swap the type | Model checking | Shim changes layout in release | `sizeof` equality assert | [17-testing-and-verification.md](17-testing-and-verification.md) |
| Never read a slot before its sequence allows | Otherwise a data race, so UB | Always | Never | TSan, model checker | [05-memory-model.md](05-memory-model.md) |

## Waiting

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Spin briefly, then park | Short waits avoid a syscall, long waits free the core | Wait times are bimodal | Oversubscribed: spinning burns the holder's time slice | Tail latency against spin limit | [07-waiting.md](07-waiting.md) |
| Wake only if a waiter flag is set | No syscall when nobody sleeps | Mostly-busy queues | Flag protocol wrong: lost wake, hang | Model-check the flag | [07-waiting.md](07-waiting.md) |
| Park policy as a template parameter | Fibers and coroutines can suspend themselves | Any scheduler that is not one thread per task | More API surface | Toy fiber test | [07-waiting.md](07-waiting.md) |
| User-mode monitor wait (`UMWAIT`, `MWAITX`) | Waits on a line write without the kernel | Experiment only | Wake latency, feature not present | CPUID gate, tail latency | [24-inspiration.md](24-inspiration.md) |

## Memory and lazy allocation

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Reserve address space, commit on touch | Large capacity costs nothing until used | Capacity sized for the worst case | First touch faults on the hot path | Page-fault count | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |
| Opt-in prefault | Moves faults to construction | Latency-critical users | Wastes memory for sparse use | Zero faults after start | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |
| Huge pages for the ring | Fewer TLB misses | Ring far larger than TLB reach | Compaction stalls, conflicts with lazy commit | dTLB miss counters | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |
| No allocation after construction | Invariant I5 | Bounded queue | Not possible for unbounded: pool segments instead | Allocation hook in tests | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) |
| Local list plus remote list for segment pools | Owner path has no atomics | Unbounded variant | Deferred collection strands memory | Peak RSS | [24-inspiration.md](24-inspiration.md) |
| Name the allocator in every payload benchmark | Producer-allocates, consumer-frees stresses allocators | Any heap payload | Never | Rerun with a second allocator | [19-benchmarking.md](19-benchmarking.md) |

## RAII and lifetime

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Construct in raw storage, destroy on pop | Element lifetime equals its time in the queue | Always | Never | ASan, lifetime-counting test type | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |
| Skip destructor work for trivially destructible `T` | Nothing to run | POD payloads | Never | Disassembly of pop | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |
| Require nothrow move, or store indices | A throw mid-publish leaves a claimed slot unpublished | Always | Rejects some types | Concept check, throwing test type | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |
| Destructor drains remaining elements once | Invariant I6 | Always | Destroying while another thread still uses the queue is UB | Lifetime-counting test type | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |

## C++23 language

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Policies as template parameters | Resolved at compile time, no virtual call | Always | Error messages, build time | Disassembly has no indirect call | [11-cpp23-craft.md](11-cpp23-craft.md) |
| Concepts on `T` and on policies | Misuse fails at the call site | Always | Over-constraining | Negative compile tests | [11-cpp23-craft.md](11-cpp23-craft.md) |
| `[[nodiscard]]` on every `try_` result | An ignored failure is a lost element | Always | Never | Warnings as errors | [04-api.md](04-api.md) |
| `std::expected` or an enum for full, empty, closed | Callers must distinguish them | Close semantics exist | Wider return than `bool` | API review | [04-api.md](04-api.md) |

## SIMD and SWAR

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Vector copy for batch moves of trivial `T` | Moves many elements per instruction | Large batches inside a claimed window | Small batches: setup cost | Bytes per cycle | [14-simd.md](14-simd.md) |
| Never vector-load unclaimed slots | A racing vector load is a data race | Always | Never | TSan, review | [14-simd.md](14-simd.md) |
| Runtime dispatch outside the hot loop | One indirect branch per batch, not per element | Mixed fleet | Per-op dispatch costs more than it saves | Disassembly | [14-simd.md](14-simd.md) |

## Branch and front end

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| Slow path out of line and cold | Fast path stays short and inlinable | Always | Slow path is actually common | `perf annotate`, `llvm-mca` | [12-cpu-and-cache.md](12-cpu-and-cache.md) |
| Prefetch the next slot only inside your claimed window | Hides one miss | Large `T`, batch ops | Prefetch-and-inspect before the sequence allows is UB | Miss counters with and without | [12-cpu-and-cache.md](12-cpu-and-cache.md) |
| Likelihood hints only from a profile | Guessing wrong pessimises layout | PGO not available | PGO available: let it decide | Branch-miss counters | [21-build-and-toolchain.md](21-build-and-toolchain.md) |

## NUMA

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| First-touch the ring on the node that uses it | Pages land near their users | Multi-socket | Users on both sockets: no good node | `numa_maps` | [13-numa-and-topology.md](13-numa-and-topology.md) |
| Pin threads in benchmarks and say how | Migration noise swamps deltas | Always when measuring | Production pinning can starve under load | Printed affinity in results | [19-benchmarking.md](19-benchmarking.md) |
| Keep the ring off CPU-less nodes | Expander memory is slower than local DRAM | CXL or tiered hosts | Never | `numa_maps` | [13-numa-and-topology.md](13-numa-and-topology.md) |

## Build, testing, measuring, debugging

| Trick | Why it works | Pays when | Hurts when | How to check | Owner |
|---|---|---|---|---|---|
| PGO, then LTO | Layout and inlining from real behaviour | Stable workload | Training profile unlike production | A/B benchmark | [21-build-and-toolchain.md](21-build-and-toolchain.md) |
| Report BOLT results separately | Post-link layout belongs to the user's binary | Publishing numbers | Mixing them flatters the library | Two columns | [21-build-and-toolchain.md](21-build-and-toolchain.md) |
| Model-check under weak memory | x86 hides missing orderings | Always | Harness too large to finish | Checker finds a planted bug | [17-testing-and-verification.md](17-testing-and-verification.md) |
| Ordering mutation | Finds untested and over-strong orderings | After tests exist | Slow: one run per mutant | Every mutant killed or explained | [17-testing-and-verification.md](17-testing-and-verification.md) |
| Seeded schedule fuzzing with debug yield points | A failing seed replays | Always | Yield points left in release | Seed in failure output | [17-testing-and-verification.md](17-testing-and-verification.md) |
| Run tests on Arm too | Weak ordering exposes what x86 hides | Always | CI cost | CI matrix | [21-build-and-toolchain.md](21-build-and-toolchain.md) |
| TSan plus ASan plus UBSan as separate jobs | Each sees a different bug class | Always | TSan misreads fence-based code | Planted bug per sanitizer | [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md) |
| Latency percentiles at a fixed fraction of saturation | Throughput alone hides stalls | Always | Coordinated omission if the load generator waits | Open-loop generator | [19-benchmarking.md](19-benchmarking.md) |
| Mutex-plus-ring baseline in every chart | Shows when lock-free does not pay | Always | Never | Baseline present | [19-benchmarking.md](19-benchmarking.md) |
| `perf c2c` before any layout change | Names the contended line and the offsets | Suspected false sharing | VMs without the needed PMU events | HITM report | [20-profiling.md](20-profiling.md) |
| Lifetime-counting element type in tests | Catches double pop, lost element, double destroy (I1, I6) | Always | Never | Counter is zero at exit | [17-testing-and-verification.md](17-testing-and-verification.md) |

## Anti-tricks

Popular advice that is wrong or harmful.

| Folklore | Why it is wrong | Source |
|---|---|---|
| "x86 is strongly ordered, so orderings do not matter" | The compiler, not the CPU, is bound by the C++ model. The same code fails on Arm | [05-memory-model.md](05-memory-model.md) |
| "Cache lines are 64 bytes" | The JVM pads by 128 by default. Adjacent-line prefetch and 128-byte lines exist | [JEP 142](https://openjdk.org/jeps/142), [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| "Lock-free means faster" | It is a progress property. A mutex and a ring wins at low contention in many runtimes | [`chan.go`](https://github.com/golang/go/blob/master/src/runtime/chan.go), [01-vision.md](01-vision.md) |
| "No mutex means lock-free" | A stalled producer between claim and publish blocks consumers | [01-vision.md](01-vision.md) |
| "TSan clean means correct" | TSan sees only executed schedules and does not model fences | [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md) |
| "`-mcx16` makes a 16-byte atomic lock-free" | GCC still calls libatomic | [GCC PR 80878](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=80878) |
| "A seqlock reader can read plain fields and validate after" | The racing read is UB before validation runs | [Boehm 2012](https://doi.org/10.1145/2247684.2247688) |
| "Peer-reviewed lock-free code is safe to copy" | A published C11 Chase-Lev port had a bug found by a model checker | [CDSChecker](http://plrg.eecs.uci.edu/publications/c11modelcheck.pdf) |
| "Prefetch the slot and peek while waiting" | Reading before the sequence allows is a data race | [05-memory-model.md](05-memory-model.md) |
| "Mean throughput is the result" | Without spread, pinning and tail it cannot be compared | [19-benchmarking.md](19-benchmarking.md) |
| "TSX will elide the contention" | Intel only, and removable by microcode | [24-inspiration.md](24-inspiration.md) |
