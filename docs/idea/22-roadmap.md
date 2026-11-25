# 🗺️ Roadmap

Order of work. A phase is done when its exit checks pass in CI, not when the code exists.

| Phase | Builds | Exit checks |
|---|---|---|
| 0 Design (now) | Docs, agent setup, doc gate | Marked snippets compile on GCC and Clang, on x86-64 and Arm |
| 1 Skeleton | CMake + Ninja presets, ccache, warnings, clang-tidy, sanitizer presets, CI | Empty target builds in every preset; a seeded bug is caught by each tool |
| 2 Verification first | Stress harness, linearizability checker, model-checker harness, ordering mutation | A deliberately broken ring fails every harness |
| 3 Default ring | Bounded MPMC ring, RAII handles, close and drain | I1-I7 checked; TSan, ASan, UBSan, Valgrind clean; every ordering mutant killed |
| 4 Benchmarks | Workload matrix, competitors, report generator | One command reproduces a report that names its machine; losses published |
| 5 Memory | Lazy commit, huge pages, prefault, arena and allocator injection | Zero hot-path allocations proved; fault count measured with and without prefault |
| 6 Waiting and batching | Wait policies, batch claim | No lost wakeup under the model checker; batch beats single beyond noise or is dropped |
| 7 Topology and SIMD | Sharding, NUMA placement, vectorised batch moves | Scalar and vector results identical; each win shown by counters |
| 8 Unbounded variant | Segments plus reclamation | Memory bound under a stalled thread measured |
| 9 Release | Packaging, docs site, v1.0 API freeze | Consumers build through find_package, FetchContent and a package manager |

Verification comes before the queue on purpose: a harness that has never failed proves nothing.
