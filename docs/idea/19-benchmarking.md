# ⏱️ Benchmarking

**A number counts only with its machine, pinning, compiler, flags, payload, capacity, occupancy and spread, and only if the difference it claims is larger than run-to-run noise.** Everything else is a hypothesis ([01-vision.md](01-vision.md)).

Nothing in this file was measured. Commands that only read system state were checked on Linux 7.0, AMD Zen 3. Do not run benchmarks on a shared box.

## Rules

- State the question first: throughput at saturation, or latency at a fixed arrival rate. They need different harnesses.
- Latency MUST come from an open-loop load with latency taken from the intended start time.
- Report the distribution (p50, p99, p99.9, p99.99, max), never a mean alone.
- The unit of replication is a fresh process, not an iteration inside one.
- Interleave variants (A B A B), never A A B B. Machines drift.
- Every competitor gets its authors' recommended configuration, the same flags, and a pinned commit.
- Publish the cells we lose.

## Workload matrix

One cell = one value per axis. A result names its cell.

| Axis | Values | Why |
|---|---|---|
| Producers x consumers | 1x1, 1xN, Nx1, NxN, and threads > cores | Contention moves between the two counters; oversubscription exposes preempted-holder stalls ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)) |
| Payload | 8 bytes, one cache line, several lines, `unique_ptr` | Copy cost against coherence cost; non-trivial move |
| Capacity | ring fits L1d, fits L2, exceeds L3 (computed from the machine, not hard-coded) | Slot misses dominate once the ring leaves the cache |
| Occupancy | near empty, near full, balanced, bursty | Empty and full are the paths where producers and consumers collide on the same lines |
| Batch | 1, 8, 64 | One contended RMW per batch ([04-api.md](04-api.md)) |
| Placement | SMT siblings, same L3, different L3, different socket | Line transfer cost changes by an order of magnitude across these ([13-numa-and-topology.md](13-numa-and-topology.md)) |
| Wait policy | busy poll, spin then park | Parking adds wake latency; spinning adds power ([07-waiting.md](07-waiting.md)) |
| Memory | prefaulted, lazy first touch; 4 KiB, huge pages | Vision goal 5 is lazy commit, so the cold cost is part of the product ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) |

The full cross product is too large. Run a base cell, sweep one axis at a time, then spot-check interactions (payload x capacity, P x C x placement).

Occupancy is controlled, not hoped for: set it by rate (open loop) or by a producer:consumer work ratio, and record what happened (see [What to measure](#what-to-measure)).

## Open loop and closed loop

| | Closed loop | Open loop |
|---|---|---|
| Next operation starts | when the previous one finishes | at a scheduled time, whatever happened before |
| Measures | saturation throughput | latency at a given rate |
| Hides | stalls: a slow op delays the next one, so the load drops exactly when the system is slow | nothing, if latency is taken from the intended time |
| Use for | "how many ops/s at most" | "what is p99.99 at 50% of saturation" |

- Schroeder, Wierman and Harchol-Balter show that closed and open models give different conclusions for the same system ([NSDI 2006](https://www.usenix.org/conference/nsdi-06/open-versus-closed-cautionary-tale)).
- **Coordinated omission**: a load generator that waits for a stalled operation before sending the next one records one slow sample instead of all the samples that stall delayed. Named by Gil Tene; explained with a worked example in the [wrk2 README](https://github.com/giltene/wrk2#acknowledgements) and his talk ["How NOT to Measure Latency"](https://www.youtube.com/watch?v=lJ8ydIuPFeU).
- Fix, in order of preference: schedule sends and measure from the intended time (below); or back-fill with `hdr_record_corrected_value(h, value, expected_interval)` from [HdrHistogram_c](https://github.com/HdrHistogram/HdrHistogram_c/blob/main/include/hdr/hdr_histogram.h). Back-filling invents samples, so say when it was used.
- Procedure for the vision's "p99.99 at 50% of saturation": measure saturation throughput closed-loop, then run open-loop at 50% of it.
- Pitfall: at rates near saturation an open-loop generator falls behind forever and latency grows without bound. That is the correct result. Report the rate where it starts.

```cpp
// check: run
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <latch>
#include <thread>
#include <vector>
#if defined(__x86_64__)
#include <x86intrin.h>
#endif

// Keep `v` alive in a register or memory and make the optimiser assume memory changed.
template <class T>
inline void do_not_optimize(const T& v) noexcept {
#if defined(__GNUC__) || defined(__clang__)
  __asm__ __volatile__("" : : "r,m"(v) : "memory");
#else
  static_cast<void>(*static_cast<const volatile char*>(static_cast<const void*>(&v)));
#endif
}

// Raw ticks for interval ends. Convert to ns offline against steady_clock.
inline std::uint64_t ticks_begin() noexcept {
#if defined(__x86_64__)
  _mm_lfence();  // earlier instructions retire before the read
  return __rdtsc();
#else
  return static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
#endif
}
inline std::uint64_t ticks_end() noexcept {
#if defined(__x86_64__)
  unsigned aux = 0;
  const std::uint64_t t = __rdtscp(&aux);  // waits for earlier instructions
  _mm_lfence();                            // later instructions do not start early
  return t;
#else
  return static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
#endif
}

int main() {
  using clock = std::chrono::steady_clock;
  constexpr std::size_t ops = 2000;
  constexpr auto period = std::chrono::microseconds(10);  // open loop: the schedule sets the rate
  constexpr int workers = 2;

  std::vector<std::vector<std::int64_t>> latency_ns(workers);
  for (auto& v : latency_ns) v.reserve(ops);  // no allocation inside the timed region
  std::latch ready(workers);
  std::atomic<bool> go{false};
  std::atomic<std::uint64_t> work{0};

  std::vector<std::jthread> threads;
  for (int w = 0; w < workers; ++w) {
    threads.emplace_back([&, w] {
      auto& out = latency_ns[static_cast<std::size_t>(w)];
      ready.count_down();
      while (!go.load(std::memory_order_acquire)) {}  // acquire: pairs with the release store in main
      const auto start = clock::now();
      for (std::size_t i = 0; i < ops; ++i) {
        const auto intended = start + period * static_cast<std::int64_t>(i);
        while (clock::now() < intended) {}  // never re-base the schedule when late
        work.fetch_add(1, std::memory_order_relaxed);  // stand-in for the queue operation
        const auto done = clock::now();
        // Latency from the intended start, not the actual start: a stall is charged
        // to every operation it delayed (no coordinated omission).
        out.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(done - intended).count());
      }
    });
  }
  ready.wait();                              // every thread exists and is spinning
  go.store(true, std::memory_order_release);  // release: publishes the start to all workers
  threads.clear();                           // join

  const std::uint64_t t0 = ticks_begin();
  do_not_optimize(work);
  const std::uint64_t t1 = ticks_end();

  std::vector<std::int64_t> all;
  for (const auto& v : latency_ns) all.insert(all.end(), v.begin(), v.end());
  std::sort(all.begin(), all.end());
  const auto pct = [&](double p) { return all[static_cast<std::size_t>(p * static_cast<double>(all.size() - 1))]; };
  std::printf("n=%zu p50=%lldns p99=%lldns max=%lldns timer_ticks=%llu\n", all.size(),
              static_cast<long long>(pct(0.50)), static_cast<long long>(pct(0.99)),
              static_cast<long long>(all.back()), static_cast<unsigned long long>(t1 - t0));
  return (all.size() == ops * workers && work.load(std::memory_order_relaxed) == ops * workers) ? 0 : 1;
}
```

The `work.fetch_add` line is where the queue operation goes. Run it pinned; unpinned output is noise.

## What to measure

| Metric | How | Pitfall |
|---|---|---|
| Throughput | Completed pops over a fixed interval shared by all threads | Fixed op counts per thread let the last threads finish alone, uncontended. Use a fixed duration and a stop flag on its own read-mostly line |
| Latency | Open loop, enqueue-intent to dequeue-complete, [HdrHistogram](https://hdrhistogram.github.io/HdrHistogram/) per thread, merged after | A timestamp in the payload forces payload at least 8 bytes and adds a clock read to the producer |
| Fairness | Ops per thread; report min/max ratio and [Jain's index](https://www.cs.wustl.edu/~jain/papers/ftp/fairness.pdf) | A queue can win throughput by letting one thread on a hot line do all the work |
| Empty-poll cost | `try_pop` on an empty queue, 1 poller and N pollers | N pollers reading the producer counter is a coherence test, not a branch test |
| Full-push cost | `try_push` on a full queue, same way | Often forgotten; back-pressure paths run hot in overload |
| Occupancy distribution | Histogram of `size_approx()` sampled by a separate, slow thread in a separate run | Sampling in the measured run adds a reader on both counters |
| Cold cost | First lap over a lazily committed ring, timed separately | Page faults inside the steady-state window; exclude them or report them, never mix |
| Hardware counters | `perf stat` around the run ([20-profiling.md](20-profiling.md)) | Counters without pinning mix cores |
| Energy | joules per op, below | Spinning consumers look great on latency and terrible here |

Histogram rule: one histogram per thread, preallocated, merged after the threads join. A shared histogram is a contended line inside the thing you measure.

Timing every operation perturbs it when the clock read costs about as much as the operation. Options: sample one operation in N at random (not every Nth: that aliases with ring laps), or time batches. State which.

## Clocks

| Source | Use | Pitfall |
|---|---|---|
| `std::chrono::steady_clock` | Default. `clock_gettime(CLOCK_MONOTONIC)` through the vDSO, no syscall when the clocksource is `tsc` | Check `cat /sys/devices/system/clocksource/clocksource0/current_clocksource`. Under `hpet` or in some VMs every read is slow |
| `rdtsc` / `rdtscp` | Short intervals, raw ticks | See below |
| `system_clock` | Never | Steps under NTP |

TSC rules:

- Require `constant_tsc` and `nonstop_tsc` in `/proc/cpuinfo`. Without them ticks follow frequency or stop in deep idle.
- TSC counts reference cycles, not core cycles. Ticks are a time unit; do not call them "cycles per op". Core cycles come from `perf stat -e cycles`.
- `rdtsc` does not wait for earlier instructions. Intel's method: `lfence; rdtsc` to start, `rdtscp; lfence` to stop ([Paoloni, 2010](https://www.intel.com/content/dam/www/public/us/en/documents/white-papers/ia-32-ia-64-benchmark-code-execution-paper.pdf)). The serialisation costs time itself; measure the empty interval and report it.
- Cross-thread deltas (stamp on producer, read on consumer) assume synchronised TSCs. True on one modern socket; check the kernel did not mark it unstable: `dmesg | grep -i tsc`.
- Convert ticks to nanoseconds by calibrating against `steady_clock` over a long window at start and end of the run. Never use the nominal frequency from the model name.
- Arm has no `rdtsc`; `cntvct_el0` is coarser on some cores. Guard with `#if`, as the snippet does.

## Harness hygiene

| Do | Because | Check |
|---|---|---|
| Start barrier: all threads created, pinned and spinning before a release store | Thread creation is slower than the test | First-op timestamps of all threads within a few microseconds |
| Warm up, then measure | Page faults, branch history, frequency ramp, lazy binding | Split the run in halves; they must agree |
| Preallocate everything | Otherwise the allocator is the benchmark | `perf stat -e page-faults` near zero in the window; heaptrack shows no allocations ([20-profiling.md](20-profiling.md)) |
| Per-thread counters padded to the destructive size | Harness false sharing is the classic self-inflicted wound | `perf c2c` on the harness |
| Consume results: `do_not_optimize` on popped values | Dead-code elimination deletes the pop | Read the disassembly of the loop |
| Fresh process per repetition | In-process repetitions share heap layout, ASLR slide and page colouring | Variance between processes exceeds variance within |
| Random order, interleaved variants | Thermal and frequency drift, background work | Plot results against wall time; no trend |

Dead-code barriers: `benchmark::DoNotOptimize` and `ClobberMemory` ([google/benchmark user guide](https://github.com/google/benchmark/blob/main/docs/user_guide.md#preventing-optimization)), `ankerl::nanobench::doNotOptimizeAway`. An empty `asm` with the value as input and a `memory` clobber is the usual implementation. Pitfall: applied to an lvalue it can force a store to the stack, adding a store-forwarding hop to the loop. Look at the disassembly.

## Machine setup

Checklist for a dedicated Linux box. The LLVM project keeps a similar list ([Benchmarking tips](https://llvm.org/docs/Benchmarking.html)).

| Knob | Command | Notes |
|---|---|---|
| Governor | `sudo cpupower frequency-set -g performance` | Check: `cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor` |
| Turbo / boost | `echo 0 \| sudo tee /sys/devices/system/cpu/cpufreq/boost` (acpi-cpufreq, amd-pstate) or `echo 1 \| sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo` | Turbo frequency depends on how many cores are active, so 1x1 and 8x8 runs get different clocks. Off for comparisons; on for "what users see", stated |
| SMT | `echo off \| sudo tee /sys/devices/system/cpu/smt/control`, or pin using `/sys/devices/system/cpu/cpu*/topology/thread_siblings_list` | Two "cores" that are siblings share L1, L2 and execution ports. Know which you measured |
| Isolation | boot with `isolcpus=<list> nohz_full=<list> rcu_nocbs=<list> irqaffinity=<housekeeping>` | [Kernel parameters](https://docs.kernel.org/admin-guide/kernel-parameters.html), [NO_HZ](https://docs.kernel.org/timers/no_hz.html). `nohz_full` stops the tick only with one runnable task on the CPU. Check: `cat /sys/devices/system/cpu/isolated /sys/devices/system/cpu/nohz_full` |
| Isolation without reboot | cgroup v2 cpuset with `cpuset.cpus.partition = isolated` | [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpuset) |
| IRQs | stop `irqbalance`; write masks to `/proc/irq/*/smp_affinity_list` | Check: diff `/proc/interrupts` before and after; isolated CPUs unchanged |
| Pinning | `taskset -c`, `numactl --cpunodebind --membind`, or `pthread_setaffinity_np` in the harness | Harness pinning is better: it records what it did |
| THP | `cat /sys/kernel/mm/transparent_hugepage/enabled`; record it | `always` vs `madvise` changes TLB behaviour and adds khugepaged noise |
| ASLR | per process: `setarch -R ./bench` | Do not disable system-wide. See the next section before using it at all |
| Verify quiet | `perf stat -e context-switches,cpu-migrations,page-faults -- ./bench` | Migrations MUST be 0 when pinned |

Pitfalls:

- `isolcpus` removes CPUs from the scheduler's load balancing. Threads placed there without explicit per-thread pinning all land on one CPU.
- Mitigations (`mitigations=off`) change syscall and context-switch cost, so they change park and wake numbers. Record `/sys/devices/system/cpu/vulnerabilities/*`; do not turn them off to look fast.
- A laptop or desktop with a browser open is not a benchmark machine. Neither is a cloud VM with shared cores: steal time shows up as tail latency.
- Hybrid CPUs (P and E cores): pin by core type or the result is a mix.

## Layout noise

- Link order and environment size change performance without any code change. Mytkowicz et al. measured this bias and found it large enough to flip an "is O3 better than O2" conclusion ([ASPLOS 2009, "Producing Wrong Data Without Doing Anything Obviously Wrong!"](https://dl.acm.org/doi/10.1145/1508244.1508275)).
- Causes: code alignment relative to cache lines and branch-predictor indexing, stack start address (moved by environment variables and `argv`), heap addresses.
- Stabilizer re-randomises code, stack and heap layout during the run so layout becomes a random variable to average over ([Curtsinger and Berger, ASPLOS 2013](https://dl.acm.org/doi/10.1145/2451116.2451141)). The [repository](https://github.com/ccurtsinger/stabilizer) was last pushed in 2021 and targets an old LLVM; treat it as the idea, not a tool to install (as of 2026-11).
- What to do instead: keep ASLR on and use many process runs, so layout is sampled; vary link order or function alignment (`-falign-functions`, [21-build-and-toolchain.md](21-build-and-toolchain.md)) as an extra axis for any win under a few percent; confirm with a mechanism (fewer instructions, fewer misses, fewer HITMs).
- Disabling ASLR picks one layout and measures it precisely. That is lower variance and the same bias. Use it for debugging a result, not for publishing one.
- A change with no mechanism and a small speedup is layout noise until shown otherwise.

## Statistics

| Question | Tool | Notes |
|---|---|---|
| Central value | median of per-process results | Mean is pulled by outliers |
| Interval | bootstrap CI of the median, 95% | No normality assumption. [`scipy.stats.bootstrap`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html) |
| "Is B different from A" | Mann-Whitney U | Rank test. It tests whether one sample tends to be larger, not a difference of medians. [`scipy.stats.mannwhitneyu`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.mannwhitneyu.html) |
| "By how much" | ratio of medians with a bootstrap CI | A p-value without an effect size is not a result |
| How many runs | add runs until the CI is narrower than the effect claimed | Kalibera and Jones give a method for choosing repetition counts per level ([ISMM 2013](https://dl.acm.org/doi/10.1145/2491894.2464160)) |

- **Min or median?** The minimum estimates the noise-free time when noise only ever adds delay, which holds for deterministic single-thread code ([Chen and Revels, 2016](https://arxiv.org/abs/1608.04295)). It is wrong for contended runs, where the interleaving is part of the workload and the fastest run is the one where threads happened not to collide. Rule: min for single-thread instruction-path microbenchmarks, median with CI for anything multi-threaded.
- Samples inside one process are correlated. Ten million op latencies from one run are one observation of that run's layout and schedule, for the purpose of comparing builds.
- Tail percentiles need samples: p99.99 from 10,000 samples is one data point. Pool across runs or run longer, and report the sample count.
- Never average percentiles across threads or runs. Merge the histograms, then read the percentile.
- Many cells, many tests: at a 0.05 threshold a 200-cell matrix yields about 10 false "wins" by chance. Require replication on a second machine or apply a correction (Holm).
- Georges et al. is the standard reference for why single-number comparisons mislead ([OOPSLA 2007](https://dl.acm.org/doi/10.1145/1297027.1297033)).

## Fair comparison

| Rule | Detail |
|---|---|
| Same contract or say so | moodycamel is not linearizable and has no cross-producer FIFO ([README](https://github.com/cameron314/concurrentqueue#reasons-not-to-use)); folly and rigtorp are bounded and blocking. Label each competitor's guarantees next to its number |
| Same effective capacity | Libraries round differently. Print each queue's real capacity |
| Same wait behaviour | All `try_*` in the same retry loop with the same backoff, or all blocking. Never spin-ours against park-theirs |
| Their best configuration | moodycamel with and without tokens; folly `MPMCQueue` vs `DynamicBoundedQueue`; report both |
| Same build | One compiler, one flag set, same LTO and `-march`, same allocator |
| Pinned versions | Commit hash per competitor in the report |
| Same harness code path | One templated driver; per-queue adapters are trivial and inlined. Check the disassembly |
| Invite correction | Publish the harness; a competitor's author should be able to rerun it |

Pitfall: unbounded queues look fast in a producer-heavy test because they never push back. Memory growth is the cost. Report peak RSS.

## Reporting template

```text
cell:        P=4 C=4 payload=8B capacity=1024 occupancy=balanced batch=1 wait=busy
placement:   producers cpu 2-5, consumers cpu 6-9, one L3, SMT siblings idle
machine:     <CPU model>, <sockets>x<cores>x<threads>, L1d/L2/L3 sizes, RAM, NUMA nodes
kernel:      <uname -r>, governor, boost on/off, isolcpus/nohz_full, THP mode, mitigations
toolchain:   <compiler version>, flags, linker, stdlib, LTO/PGO/BOLT state
versions:    ours <commit>, competitor <name>@<commit>
load:        closed loop | open loop at <rate> ops/s (<x>% of saturation)
runs:        <n> processes, <duration> each, <warmup>, interleaved order
throughput:  median <x> ops/s, 95% CI [<lo>, <hi>]
latency:     p50 p99 p99.9 p99.99 max, <samples> samples, CO-safe: intended-time | corrected | no
fairness:    min/max ops per thread
counters:    instructions/op, cycles/op, L1d/LLC misses/op, HITM count
command:     <the one command that reruns this>
```

## Regression gates in CI

| Gate | Signal | Where | Catches | Misses |
|---|---|---|---|---|
| Instruction count | `perf stat -e instructions:u -x, -- ./micro` or `valgrind --tool=cachegrind` ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)) | Every PR | Lost inlining, extra branches, accidental copies on the uncontended path | Everything about coherence: the cost that matters most for MPMC |
| Binary and layout | `sizeof`/`alignof` static asserts, `bloaty` diff ([20-profiling.md](20-profiling.md)) | Every PR | Padding regressions | Run-time effects |
| Threaded throughput and tail | The matrix base cells, Mann-Whitney against the stored baseline plus an effect threshold | Nightly, dedicated runner | Real regressions | Small ones below noise |

- Instruction counts repeat to a fraction of a percent, which is why SQLite steers its optimisation work with Cachegrind ([sqlite.org/cpu.html](https://sqlite.org/cpu.html)). They are a proxy. A change that removes instructions and adds a contended line is a regression the gate will applaud.
- Hosted CI VMs often expose no PMU, so `perf stat -e instructions` reports `<not supported>`. Cachegrind works anywhere. Hypothesis to check per runner type.
- Gate on single-thread binaries only. Instruction counts of spinning threads measure how long they spun.
- Thresholds are set from the measured run-to-run spread of the gate itself, not picked. Record the spread first.
- Never gate PRs on wall-clock time from shared runners.

## Harness choice

| Tool | Good at | Limits here |
|---|---|---|
| [google/benchmark](https://github.com/google/benchmark) | Microbenchmarks, `->Threads(n)`, repetitions, `--benchmark_enable_random_interleaving`, `--benchmark_perf_counters` (needs libpfm) | Every thread runs the same function, closed loop; no latency histograms; no per-thread pinning or P != C roles without fighting it |
| [nanobench](https://nanobench.ankerl.com/) | Single header, single-thread, reports instructions and branch misses via `perf_event` on Linux | No threads |
| Custom harness | Open loop, roles, pinning, start barrier, HdrHistogram, machine capture | We own its bugs. Test it: a queue with an injected 1 ms stall MUST show up in p99.99 |

Decision: custom harness for the matrix; nanobench or google/benchmark for single-thread path costs and the instruction gate. Either is acceptable; which one is an open question of taste, settled by whichever needs fewer workarounds for the gate.

## Energy

- Spin-waiting trades watts for latency. A wait-policy comparison without energy is half a result ([07-waiting.md](07-waiting.md)).
- Measure: `sudo perf stat -a -e power/energy-pkg/ -- ./bench` (RAPL; system-wide only, hence `-a`). Check the event exists: `perf list | grep energy`. AMD exposes package and per-core energy; Intel adds DRAM on servers.
- Since the PLATYPUS attack, unprivileged RAPL reads are blocked on Linux ([platypusattack.com](https://platypusattack.com/)). Needs root.
- RAPL covers the whole package. Subtract an idle baseline of the same duration, and keep the machine otherwise idle.
- Report joules per million ops, and idle-queue power per waiting consumer.
