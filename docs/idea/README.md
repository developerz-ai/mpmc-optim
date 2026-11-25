# 💡 Idea docs

One topic per file. One owning doc per fact; everywhere else links to it. Design stage: numbers are targets unless a source is cited.

## 🧭 Direction

| Doc | Owns |
|---|---|
| [01-vision.md](01-vision.md) | Problem, goals, non-goals, vocabulary, success metrics |
| [02-prior-art.md](02-prior-art.md) | How others build MPMC queues, what to keep, what to avoid |
| [24-inspiration.md](24-inspiration.md) | Ideas from outside queues: HFT, engines, kernels, databases, runtimes, networking |
| [25-tricks.md](25-tricks.md) | Every trick on one page: when it pays, when it hurts, owning doc |
| [26-papers.md](26-papers.md) | Annotated research papers: claim, evidence, what we use |

## 🔀 The queue

| Doc | Owns |
|---|---|
| [03-algorithms.md](03-algorithms.md) | Candidate algorithms: slot protocol, proofs, trade-offs |
| [04-api.md](04-api.md) | Public API, concepts, error and close semantics, batching |
| [05-memory-model.md](05-memory-model.md) | C++ atomics, orderings, fences, per-operation justification |
| [06-progress-and-reclamation.md](06-progress-and-reclamation.md) | Progress guarantees, ABA, hazard pointers, epochs |
| [07-waiting.md](07-waiting.md) | Spin, backoff, park, futex, eventcount |

## 🧱 Memory and lifetime

| Doc | Owns |
|---|---|
| [08-arenas-and-allocators.md](08-arenas-and-allocators.md) | Arenas, pools, slabs, pmr, lazy commit, huge pages, allocator choice |
| [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) | Where bytes land: alignment, false sharing, colouring, hot/cold split, first touch |
| [10-raii-and-lifetime.md](10-raii-and-lifetime.md) | Ownership, object lifetime in raw storage, exception safety, shutdown |
| [11-cpp23-craft.md](11-cpp23-craft.md) | Language techniques and code hygiene |

## 🔩 Hardware

| Doc | Owns |
|---|---|
| [12-cpu-and-cache.md](12-cpu-and-cache.md) | Coherence, store buffers, branches, prefetch, SMT, x86 and Arm instructions |
| [13-numa-and-topology.md](13-numa-and-topology.md) | Sockets, CCXs, pinning, sharding, placement |
| [14-simd.md](14-simd.md) | SIMD for slot scans, batch moves and payloads; dispatch; atomicity limits |

## ✅ Correctness

| Doc | Owns |
|---|---|
| [15-static-analysis.md](15-static-analysis.md) | Warnings, clang-tidy, GCC analyzer, cppcheck, CodeQL, thread-safety annotations |
| [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md) | ASan, UBSan, TSan, MSan, Valgrind tools, what each one misses |
| [17-testing-and-verification.md](17-testing-and-verification.md) | Linearizability, model checking, TLA+, stress, fuzzing |
| [18-hardening.md](18-hardening.md) | UB budget, integer rules, compiler hardening, supply chain |

## 🚀 Performance and shipping

| Doc | Owns |
|---|---|
| [19-benchmarking.md](19-benchmarking.md) | Method, workloads, statistics, fair comparison |
| [20-profiling.md](20-profiling.md) | perf, perf c2c, top-down, llvm-mca, heap and latency tools |
| [21-build-and-toolchain.md](21-build-and-toolchain.md) | CMake presets, flags, LTO, PGO, BOLT, CI matrix, packaging |

## 📍 Plan

| Doc | Owns |
|---|---|
| [22-roadmap.md](22-roadmap.md) | Phases with observable exit checks |
| [23-open-questions.md](23-open-questions.md) | Undecided choices and the experiment that settles each |
