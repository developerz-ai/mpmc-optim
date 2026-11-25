# Prior art

**Borrow ideas, not code. Trust the source file over the README.** Every row below was checked against the repository or the paper. As of 2026-11.

Rules for this doc:

- A repo's own progress word ("lock-free", "wait-free") is recorded as **claimed**. The **reading** column applies the definitions in [01-vision.md](01-vision.md).
- "Last activity" is the newest commit on the default branch, read with `gh api repos/<r>/commits?per_page=1` on 2026-11-25.
- No benchmark numbers are repeated here unless the hardware is named. Method: [19-benchmarking.md](19-benchmarking.md).
- GPL sources are described, never copied. This repo is MIT.

## Naming trap

"Head" and "tail" swap meaning between projects. Translate before comparing code.

| Project | Producer side is called | Consumer side is called |
|---|---|---|
| This repo ([01-vision.md](01-vision.md)) | tail | head |
| crossbeam `ArrayQueue`, Vyukov | tail / `enqueue_pos_` | head / `dequeue_pos_` |
| rigtorp `MPMCQueue` | `head_` | `tail_` |
| atomic_queue | `end_` (README says head) | `beg_` (README says tail) |
| DPDK `rte_ring` | `prod.head` and `prod.tail` | `cons.head` and `cons.tail` |
| folly | `pushTicket_` | `popTicket_` |

## Families

Seven designs cover everything below. [03-algorithms.md](03-algorithms.md) owns the protocols.

| Family | Idea | Members |
|---|---|---|
| Per-slot sequence ring | Counter claims a ticket, slot sequence hands the slot over | Vyukov, crossbeam `ArrayQueue`, xenium `vyukov_bounded_queue`, rigtorp, folly `MPMCQueue`, WFMPMC |
| Slot-value-as-state ring | The element itself (or a state byte) is the hand-off flag | atomic_queue, FAAArrayQueue cells |
| Head/tail-pair ring | Each side has a claim index and a publish index | DPDK `rte_ring`, Disruptor, BBQ (per block) |
| Cycle-tagged index ring | FAA counters, entries carry a cycle, payload reached by index | CRQ, PRQ, SCQ, wCQ, xenium `nikolaev_*` |
| Segmented FAA list | Linked list of small arrays, each cell used once | FAAArrayQueue, LCRQ, LPRQ, Yang and Mellor-Crummey, folly `UnboundedQueue`, crossbeam `SegQueue` |
| Linked node | One node per element | Michael-Scott, boost.lockfree `queue` |
| Sharded | Many sub-queues, relaxed global order | moodycamel, oneTBB (8 micro-queues) |

## Facts

RMW column: atomic read-modify-writes on shared lines for one uncontended successful operation. `+S` is the plain release store that hands the slot over. Counted from source, not measured.

| Design | Bounded | Progress: claimed / reading | FIFO strength | Contended RMWs per op | Memory | Licence | Last activity |
|---|---|---|---|---|---|---|---|
| [Vyukov bounded MPMC](https://web.archive.org/web/2022/https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) | yes | "not lockfree in the official meaning" / mutex-free, blocking | successes FIFO, "causal FIFO"; failed `try` not linearizable | 1 CAS +S | `cap × (T + 8 B)` | BSD-2-Clause and Apache-2.0 | article, 2010 |
| [rigtorp/MPMCQueue](https://github.com/rigtorp/MPMCQueue) | yes | none claimed / blocking | FIFO by ticket | 1 FAA (`push`) or 1 CAS (`try_push`) +S | one slot per 128 B on x86-64 and AArch64 | MIT | 2026-11-18 |
| [cameron314/concurrentqueue](https://github.com/cameron314/concurrentqueue) | no (can preallocate) | lock-free / not audited here | per-producer only; README: "not linearizable" | producer 0, consumer 2 FAA | blocks of 32, per-producer sub-queues | BSD-2-Clause or BSL-1.0 | 2026-10-26 |
| [max0x7ba/atomic_queue](https://github.com/max0x7ba/atomic_queue) | yes | lock-free / mutex-free, blocking | FIFO for `push`/`pop`; `try_` loop "is not FIFO" (source comment) | 1 FAA or CAS + 1 slot `exchange`/CAS | `cap × sizeof(T)` for atomic `T`, no sequence word | MIT | 2026-10-23 |
| [folly `MPMCQueue`](https://github.com/facebook/folly/blob/main/folly/MPMCQueue.h) | yes (`Dynamic` grows) | blocking / blocking | "linearizable" (header) | 1 FAA + slot turn CAS | `cap` single-element queues, strided | Apache-2.0 | active |
| [folly `UnboundedQueue`](https://github.com/facebook/folly/blob/main/folly/concurrency/UnboundedQueue.h) | no | producers "never wait or fail" / lock-free producers, consumers may wait | "linearizable" (header) | MP 1 FAA, MC 1 FAA or CAS | segments of 256, one or two spare | Apache-2.0 | active |
| [folly `DynamicBoundedQueue`](https://github.com/facebook/folly/blob/main/folly/concurrency/DynamicBoundedQueue.h) | soft (about 10% slack) | blocking | FIFO | `UnboundedQueue` + credit counter | grows and shrinks | Apache-2.0 | active |
| [boost.lockfree `queue`](https://github.com/boostorg/lockfree) | optional (`fixed_sized`) | lock-free if no allocation / same | linearizable (Michael-Scott) | push 2 CAS + freelist CAS, pop 1 CAS + freelist CAS | node per element, never returned before destruction | BSL-1.0 | 2026-10-25 |
| [oneTBB `concurrent_queue`](https://github.com/uxlfoundation/oneTBB) | no | none / blocking (spin-wait per micro-queue, `spin_mutex` on page change) | per-thread pairs | 1 FAA ticket + micro-queue counter | pages, 8 micro-queues | Apache-2.0 | 2026-11-24 |
| oneTBB `concurrent_bounded_queue` | yes (soft, `set_capacity`) | blocking | per-thread pairs | as above + wait machinery | pages | Apache-2.0 | 2026-11-24 |
| [xenium](https://github.com/mpoeter/xenium) | both | per algorithm | per algorithm | per algorithm | reclaimer is a policy | MIT | 2025-07-29 |
| [erez-strauss/lockfree_mpmc_queue](https://github.com/erez-strauss/lockfree_mpmc_queue) | yes | lock-free / plausible, helping on indices, not audited | FIFO | 1 CAS on a 16 B entry + 1 CAS index | one line per entry | MIT | 2023-10-28 |
| [MengRao/WFMPMC](https://github.com/MengRao/WFMPMC) | yes | "wait-free (almost)" / blocking | FIFO by ticket | 1 FAA +S | `cap × (T + 8 B)` | MIT | 2018-11-04 |
| [LCRQ](https://dl.acm.org/doi/10.1145/2442516.2442527) | no | lock-free | linearizable | 1 FAA + 1 CAS2 | closed rings wasted; needs SMR | paper; [MIT port](https://github.com/pramalhe/ConcurrencyFreaks) | 2013 |
| [LPRQ](https://dl.acm.org/doi/10.1145/3572848.3577485) | no | lock-free | linearizable | 1 FAA + single-width CAS | as LCRQ | paper; [artifact](https://zenodo.org/records/7337237) | 2023 |
| [SCQ](https://arxiv.org/abs/1908.04511) | yes | lock-free | linearizable | 2 FAA + 2 CAS/OR (two index rings) | `2n` entries per ring, two rings, data array | BSD-2-Clause or MIT ([code](https://github.com/rusnikola/lfqueue)) | 2026-02-27 |
| [wCQ](https://arxiv.org/abs/2201.02179) | yes | wait-free | linearizable | as SCQ on the fast path | bounded | BSD-2-Clause or MIT | 2026-02-27 |
| [FAAArrayQueue](http://concurrencyfreaks.blogspot.com/2016/11/faaarrayqueue-mpmc-lock-free-queue-part.html) | no | lock-free | linearizable | 1 FAA + 1 CAS or `exchange` | node of 1024 cells, each used once | MIT ([code](https://github.com/pramalhe/ConcurrencyFreaks)) | 2025-10-25 |
| [BBQ](https://www.usenix.org/conference/atc22/presentation/wang-jiawei) | yes | "deadlock-free ... depend on a fair scheduler" / blocking | FIFO; drop-old mode overwrites | FAA + MAX on block cursors | blocks, variable-size entries | paper; no licence found | 2022 |
| [Michael-Scott](https://www.cs.rochester.edu/~scott/papers/1996_PODC_queues.pdf) | no | lock-free | linearizable | push 2 CAS, pop 1 CAS | node per element; needs SMR | paper | 1996 |
| [Yang and Mellor-Crummey](https://dl.acm.org/doi/10.1145/2851141.2851168) | no | wait-free / disputed, see below | linearizable | 1 FAA + 1 CAS fast path | segments, own reclamation | MIT ([code](https://github.com/chaoran/fast-wait-free-queue)) | 2020-03-12 |
| [crossbeam `ArrayQueue`](https://github.com/crossbeam-rs/crossbeam/blob/main/crossbeam-queue/src/array_queue.rs) | yes | none / blocking | linearizable full and empty, by waiting | 1 CAS (`SeqCst`) +S | `cap × (T + 8 B)`, any capacity | MIT or Apache-2.0 | 2026-11-21 |
| [crossbeam `SegQueue`](https://github.com/crossbeam-rs/crossbeam/blob/main/crossbeam-queue/src/seg_queue.rs) | no | none / blocking pop on in-flight push | FIFO | 1 CAS + slot state `fetch_or` | blocks of 31, no epoch GC | MIT or Apache-2.0 | 2026-11-21 |
| [LMAX Disruptor](https://github.com/LMAX-Exchange/disruptor) | yes | blocking (parks when full) | total order, every consumer sees every event | 1 `getAndAdd` or CAS + per-slot flag store | preallocated entries | Apache-2.0 | 2025-04-02 |
| [DPDK `rte_ring`](https://github.com/DPDK/dpdk/tree/main/lib/ring) MP/MC | yes (`size − 1` usable) | blocking | strict FIFO | 1 CAS (32-bit) + ordered tail store | pointer or fixed-size element array | BSD-3-Clause | active |
| DPDK RTS / HTS | yes | blocking, preemption-tolerant | RTS: BBQ paper says it trades linearizability; HTS: strict | RTS 2 × 64-bit CAS; HTS 1 × 64-bit CAS, fully serialized | same | BSD-3-Clause | active |
| [Linux `ptr_ring`](https://github.com/torvalds/linux/blob/master/include/linux/ptr_ring.h) | yes | lock-based (`producer_lock`, `consumer_lock`) | FIFO | spinlock per side | pointer array, `NULL` is empty | GPL-2.0-or-later | active |
| [Linux BPF ringbuf](https://github.com/torvalds/linux/blob/master/kernel/bpf/ringbuf.c) | yes | MPSC; producers take a spinlock to reserve | FIFO by reserve order | lock + header busy bit | byte ring, variable records, mmap to user | GPL-2.0 | active |
| moodycamel blocking variants | no | blocking by design | as base queue | base + semaphore count | as base | BSD-2-Clause or BSL-1.0; semaphore zlib | 2026-10-26 |

Unverified cells: folly, DPDK and Linux "active" (monorepos, not dated per file). BBQ licence: none stated in the paper. moodycamel lock-freedom: not audited.

## What the sources say that the READMEs do not

| Design | Finding | Source |
|---|---|---|
| Vyukov | Relaxed load and relaxed CAS on the counters, acquire load and release store on the slot sequence. Author: "The cost of enqueue/dequeue is 1 CAS per operation" | archived article, linked above |
| Vyukov | `try_pop` returns false while an earlier producer is between claim and publish, even though a later push already returned. Not linearizable; SCQ paper lists it among queues that "fail to achieve linearizable lock-free behavior" | [SCQ paper](https://arxiv.org/abs/1908.04511), section 1 |
| crossbeam `ArrayQueue` | Fixes that: on a stale stamp it runs `atomic::fence(SeqCst)`, re-reads the other counter, and reports empty only if `tail == head`. Otherwise it spins. Price: `SeqCst` CAS, and a pop that waits for a stalled producer | `array_queue.rs`, `push_or_else` and `pop` |
| rigtorp | `fetch_add` and `compare_exchange_strong` on the counters use the default `seq_cst`. Blocking `push` cannot be abandoned after the FAA | `MPMCQueue.h` |
| rigtorp | Slot spacing is 128 B on x86-64, AArch64 and POWER, 256 B on s390x. One element per slot, so a queue of `int` spends 128 B per element | `MPMCQueue.h`, `kFalseSharingRange` |
| atomic_queue | The README states that a thread that dies between claim and store "deadlocks the next thread" on that slot. That is blocking under the vision definitions | README, "Lock-free guarantees" |
| atomic_queue | Counters are `unsigned`. Safe there because slots carry no lap, so wrap is invisible when capacity is a power of two. Not safe for a sequence ring | `atomic_queue.h`, `GetCounterType` |
| atomic_queue | Index remap swaps cache-line index and in-line index so consecutive tickets land on different lines without padding each element | README, "Ring-buffer capacity" |
| folly `MPMCQueue` | Element constructor must be `noexcept`, enforced by `static_assert`: a ticket cannot be handed back after a throw | `MPMCQueue.h` header comment |
| folly `UnboundedQueue` | Hazard pointers protect segments. SPSC path has "no read-modify-write atomic operations, full fences, or system calls" | `UnboundedQueue.h` header comment |
| crossbeam `SegQueue` | No epoch reclamation. A block is freed by the last reader through `READ` and `DESTROY` bits in each slot's state | `seg_queue.rs` |
| moodycamel | Consumer dequeue does `dequeueOptimisticCount.fetch_add` then `headIndex.fetch_add`, and `dequeueOvercommit.fetch_add` on a miss. Producer publishes with a plain `tailIndex.store` | `concurrentqueue.h` |
| oneTBB | Ticket `k` picks micro-queue `k * 3 % 8`. Each micro-queue serialises with `spin_wait_until_eq` on a counter. A comment calls it "A queue using simple locking" | `_concurrent_queue_base.h` |
| boost.lockfree | `T` needs trivial copy assignment and trivial destructor. `fixed_sized` indexes nodes by 16-bit index, so about 65 k elements | `queue.hpp` |
| WFMPMC | Each step is wait-free, the operation is not. README: a writer that crashes holding an index means "the corresponding reader will never succeed" | README, "A Pitfall" |
| DPDK | Default MP/MC "can perform quite pure on some overcommitted scenarios". RTS lets the last finisher move the tail. HTS serialises and enables peek | [ring_lib.rst](https://github.com/DPDK/dpdk/blob/main/doc/guides/prog_guide/ring_lib.rst) |
| DPDK | 32-bit indices are safe: ring size is capped at `0x7fffffff` and all comparisons are modulo-2^32 distances, not laps | `rte_ring_core.h` |
| Disruptor | Multi-producer publish sets a per-slot `availableBuffer` flag with `setRelease`. A full ring parks with `LockSupport.parkNanos(1)` | `MultiProducerSequencer.java` |
| SCQ | `2n` entries for capacity `n`, livelock prevented by a threshold of `3n − 1` | SCQ paper, Figure 8 |
| wCQ | "wCQ requires double-width CAS", with an LL/SC emulation for other machines | [wCQ paper](https://arxiv.org/abs/2201.02179), section 2 |
| Yang and Mellor-Crummey | wCQ paper, citing Ramalhete and Correia: its reclamation "forfeits wait-freedom" | wCQ paper, section 1 |
| BBQ | Verified with VSync on top of GenMC; three bugs found in drop-old mode by the model checker | BBQ paper, section 5 |

## Keep and avoid

| Design | Keep | Avoid |
|---|---|---|
| Vyukov | Slot sequence encodes lap and state in one word. Relaxed counters, acquire/release slot | Presenting failed `try` as "empty". One slot of `int` per cache line |
| rigtorp | One slot protocol serving both FAA (`push`) and CAS (`try_push`). `noexcept` constraints in `requires`. MC/DC coverage gate | Default `seq_cst`. 128 B per small element. Unpublished benchmarks |
| moodycamel | Producer tokens, bulk operations, block recycling, honest "reasons not to use" section, CDSChecker and Relacy runs | Implicit thread-local producers. Order weaker than users assume |
| atomic_queue | No sequence word for atomic payloads. Index remap. Pinned, repeated, documented benchmarks. CI on ppc64le, riscv64, s390x under QEMU | Calling a per-slot spinlock lock-free. Sentinel `NIL` value stolen from `T` |
| folly `MPMCQueue` | Futex per slot for blocking. Stride instead of padding. Adaptive spin cutoff | Dependence on the rest of folly |
| folly `UnboundedQueue` | One template for SPSC, MPSC, SPMC, MPMC. Tickets map to segment and slot. Hazard pointers only on segment change | `LgAlign` 7 default costs memory for small `T` |
| boost.lockfree | Tagged index instead of tagged pointer on targets without DWCAS | Node per element. Trivial-type restriction |
| oneTBB | `abort()` to wake blocked threads at shutdown | Spin-wait serialisation inside a "non-blocking" API |
| xenium | Reclaimer as a template policy. One test suite across reclaimers | No GitHub Actions workflow found (CircleCI config only) |
| erez-strauss | Success defined by a single CAS on the entry, index update is cooperative | 16 B payload limit. `cmpxchg16b` through libatomic on GCC ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| WFMPMC | Claim, write in place, commit as three calls: zero-copy API | "Wait-free" label. Thread-local hash table for retry state |
| LCRQ, LPRQ | Close a starving ring and append a new one. LPRQ shows CAS2 is not required | Unbounded memory under a stalled thread. Full SMR dependency |
| SCQ, wCQ | True lock-free bounded ring with single-width atomics. Threshold for livelock. Index indirection decouples payload size from entry | Four shared RMWs per element. Proof assumes sequential consistency |
| FAAArrayQueue | Smallest correct lock-free unbounded design. Good teaching baseline | Allocation every 1024 elements. A slow consumer burns cells |
| BBQ | Block-level cursors cut producer-consumer interference. Model checking on weak memory as part of the paper | Fair-scheduler progress. No published licence |
| Michael-Scott | Reference for linearizability tests | Two contended lines per push, allocation per element |
| Yang and Mellor-Crummey | FAA fast path with a helping slow path | Reclamation that can block |
| crossbeam | Fence-then-recheck before reporting empty. `force_push` overwrite mode. loom, Miri and TSan in CI | `SeqCst` on every claim |
| Disruptor | Batch claim `next(n)`. Cached gating sequence (cached opposite index). Wait strategy as a policy | Broadcast semantics are not a work queue |
| DPDK | Bulk and burst as the primary API. Sync mode per side chosen at creation. Peek under HTS | Tail-order wait under preemption in default mode |
| `ptr_ring`, BPF ringbuf | Consumer batches its invalidations. Reserve/commit with a busy bit. Positions on separate pages for mmap | Any code: GPL |
| moodycamel blocking | Semaphore count as the wake token, spin before sleeping | Destroying a queue while a thread is blocked on it (README caveat) |

## How the repositories present themselves

| Practice | Who does it well | Take |
|---|---|---|
| Says what it is not | moodycamel ("Reasons not to use"), atomic_queue (limitations list), WFMPMC ("A Pitfall") | README section: contract, non-goals, known weak cases |
| States the contract precisely | folly headers (linearizable, when to use, when not), crossbeam docs | Contract block at the top of each public header |
| Benchmarks with method | atomic_queue: pinning, huge pages, several runs, mean/stdev/min/max, hardware named, charts | [19-benchmarking.md](19-benchmarking.md) |
| Benchmarks absent or stale | rigtorp (TODO in README), WFMPMC (one machine, 2018) | Publish losses too |
| Model checking in the story | moodycamel (CDSChecker, Relacy), crossbeam (loom, Miri), BBQ (VSync/GenMC) | [17-testing-and-verification.md](17-testing-and-verification.md) |
| CI across architectures | atomic_queue (x86-64, Arm, ppc64le, riscv64, s390x via QEMU), moodycamel (riscv64 via QEMU) | [21-build-and-toolchain.md](21-build-and-toolchain.md) |
| Coverage as a gate | rigtorp (MC/DC with GCC 14+) | Consider for the core header |
| Single header, copy to use | rigtorp, moodycamel, WFMPMC | Header-only core, per the vision |
| Standardisation track | [P0260](https://wg21.link/p0260) C++ concurrent queues | Read before naming the API. Owner: [04-api.md](04-api.md) |

Common weaknesses across the field:

- "Lock-free" used for "no mutex". Most bounded rings above block on a stalled thread.
- Benchmarks without tail latency, without pinning details, or against a default-configured competitor.
- Weak-memory testing rarely stated. Among the small libraries checked, only atomic_queue and moodycamel run non-x86 CI.
- FIFO promise often left vague. folly, moodycamel and atomic_queue state theirs.

## How to re-check this doc

```bash
gh api repos/<owner>/<repo> --jq '[.license.spdx_id, .pushed_at] | @tsv'
gh api "repos/<owner>/<repo>/commits?per_page=1" --jq '.[0].commit.committer.date'
gh api repos/<owner>/<repo>/contents/<path> -H "Accept: application/vnd.github.raw" | grep -n "memory_order\|fetch_add\|compare_exchange"
```

`1024cores.net` redirected to an unrelated domain on 2026-11-25. Use the archive link.
