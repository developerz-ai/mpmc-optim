# 🎯 Vision

**The fastest MPMC queue you can prove correct, plus the notes that let anyone rebuild it.** C++23, header-only core, every memory ordering justified, every performance claim reproducible.

Status: design stage. No library code yet. Every number here is a target.

## Problem

- MPMC queues are easy to write, hard to get right. A wrong ordering passes every test on x86 and fails on Arm.
- Published numbers rarely compare: different capacity, pinning, payload, idle behaviour, and no latency tail.
- The tricks (slot layout, ticket order, arenas, huge pages, SIMD, PGO) are scattered over papers, talks and code comments.

## Users

| User | Core job |
|---|---|
| Engine, trading, telemetry and database engineers | Hand work between threads with a bounded tail |
| Library authors | Pick an algorithm from evidence |
| Coding agents | Write correct lock-free C++ from rules, not folklore |

## Goals

1. **Correct first.** Linearizable (or a documented weaker contract), model checked, TSan clean, race-free on weak memory.
2. **Bounded by default.** Fixed capacity, explicit full and empty results, no allocation after construction.
3. **Mechanical sympathy.** Cost counted in contended cache lines per operation, not in lines of code.
4. **Pay for what you use.** Policies resolve at compile time. No virtual calls, no hidden threads, no hidden allocation.
5. **Lazy by default.** Reserve address space eagerly, commit pages only when touched, with an opt-in prefault for latency-critical users.
6. **Reproducible.** One command reruns each published number and prints the machine it ran on.

## Non-goals

- Inter-process queues in the first release. The layout must not rule them out.
- Priority, delay, persistence, networking.
- A task scheduler or thread pool. This is a building block for one.
- Exotic progress guarantees that slow the common path, unless an opt-in variant.

## Vocabulary

Use these words, with these meanings, in every doc.

| Term | Meaning |
|---|---|
| **Ring** | Fixed, power-of-two array of slots |
| **Slot** | One element's storage plus its sequence word |
| **Sequence** | Per-slot atomic that says who may act on the slot next |
| **Ticket** | Monotonic 64-bit position claimed from a counter |
| **Head / tail** | Consumer counter / producer counter |
| **Lap** | One full pass over the ring: `ticket / capacity` |
| **Segment** | One ring in a linked chain of rings (unbounded variant) |
| **Handle** | Per-thread RAII object holding cached state for one queue |
| **Cache line** | Coherence unit. **Destructive size**: minimum spacing that avoids false sharing |
| **Contended RMW** | Atomic read-modify-write on a line other cores also write |

Three words that are not synonyms:

| Term | Means |
|---|---|
| **Lock-free** | Some thread always finishes in a finite number of steps |
| **Wait-free** | Every thread finishes in a bounded number of steps |
| **Obstruction-free** | A thread running alone finishes |

A ring where a stalled producer can block consumers is **not lock-free**, even with no mutex. Say "mutex-free" or "blocking" instead.

## Invariants

| # | Invariant |
|---|---|
| I1 | Each pushed element is popped at most once, and exactly once if drained |
| I2 | Elements pushed by one thread are popped in push order (per-producer FIFO), where the variant promises FIFO |
| I3 | A pop that returns an element happens-after the push that wrote it |
| I4 | No access to a slot's element outside the window its sequence grants |
| I5 | No heap allocation on the push or pop path of a bounded queue |
| I6 | Destruction runs each remaining element's destructor exactly once |
| I7 | `size_approx()` is a hint. No correctness decision depends on it |

## Success metrics

Targets, to be replaced by measurements.

| Metric | Target |
|---|---|
| Contended RMWs per uncontended push or pop | at most 1 on a shared counter, plus the slot hand-off |
| Heap allocations per operation, bounded | 0 |
| Throughput against the fastest comparable open-source queue, same machine and workload | at least equal in half the matrix cells, and the losses published |
| p99.99 latency at 50% of saturation | reported for every result |
| Checks that must be green | TSan, ASan, UBSan, Valgrind, model checker, linearizability tester |

## Definition of done for any claim

A performance claim needs a benchmark that beats noise ([19-benchmarking.md](19-benchmarking.md)). A correctness claim needs a checker run ([17-testing-and-verification.md](17-testing-and-verification.md)). Otherwise call it a hypothesis.
