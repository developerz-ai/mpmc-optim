# ❓ Open questions

Undecided. Settle with the experiment, move the answer to the owning doc, delete the row.

| Question | Owner | Settled by |
|---|---|---|
| CAS or fetch-add tickets for the default ring | [03-algorithms.md](03-algorithms.md) | Both under the workload matrix, including oversubscription and near-empty |
| Pad every slot or pack and remap indices | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) | `perf c2c` and throughput, payload 8 to 256 bytes |
| Which unbounded algorithm | [06-progress-and-reclamation.md](06-progress-and-reclamation.md) | Memory bound and throughput with a stalled thread |
| Prefault default on or off | [08-arenas-and-allocators.md](08-arenas-and-allocators.md) | Fault cost in the p99.99 tail against resident memory |
| What to do when a constructor throws in a claimed slot | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) | Require nothrow, or a tombstone; compare hot-path cost |
| Where SIMD pays, if anywhere | [14-simd.md](14-simd.md) | Batch move by payload size against `memcpy` |
| Primary model checker | [17-testing-and-verification.md](17-testing-and-verification.md) | Which finds every seeded ordering bug within budget |
| 128 or 64 byte spacing on x86-64 | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) | Two-thread increment test at both spacings, prefetcher on and off |
| Encode sequences so zero pages read as empty (lazy commit needs no init pass) | [03-algorithms.md](03-algorithms.md) | Model check the encoding; measure construction cost |
| `atomic_ref` or `start_lifetime_as` for mapped slots | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) | Compiler support matrix |
| AoS or SoA slots for large elements | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) | Payload sweep, 8 to 1024 bytes |
| Bulk push: all-or-nothing or partial | [04-api.md](04-api.md) | Cost of each against the claim protocol |
| Oldest supported compilers | [21-build-and-toolchain.md](21-build-and-toolchain.md) | CI matrix over the features used |
| `try_pop` contract: "not ready" or exact empty | [04-api.md](04-api.md) | Cost of the `seq_cst` CAS on AArch64 |
| CAS ring or SCQ when threads exceed cores | [03-algorithms.md](03-algorithms.md) | p99.99 under oversubscription |
| Hazard pointers per handle or crossbeam-style slot bits | [06-progress-and-reclamation.md](06-progress-and-reclamation.md) | Prototype both, stalled-thread memory bound |
| Load-only notify with a `seq_cst` publish, or an RMW notify | [07-waiting.md](07-waiting.md) | Push cost with zero waiters |
| Shard key (LLC group or NUMA node) and steal batch | [13-numa-and-topology.md](13-numa-and-topology.md) | Sweep on a multi-CCX machine |
| rseq per-CPU buffers or a `fetch_add(k)` batch claim | [13-numa-and-topology.md](13-numa-and-topology.md) | Throughput and p99.99 under migration |
| Snapshot then SIMD, or scalar early exit | [14-simd.md](14-simd.md) | 64 to 1024 flags |
| rseq time-slice extension for tail latency | [24-inspiration.md](24-inspiration.md) | On and off with threads above cores |
| Dense sequence array or in-slot sequence | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) | `perf c2c` HITM counts |
