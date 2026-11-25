# 🔬 Profiling

**Pick the tool from the symptom, then confirm the mechanism before changing code.** For an MPMC queue the first suspect is always a contended cache line, and a CPU-time flame graph cannot see one.

As of 2026-11. Option names checked against `perf` 7.0.14 (`perf <cmd> -h`); nothing here was run under load. Benchmark method: [19-benchmarking.md](19-benchmarking.md). Cachegrind and Callgrind: [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md).

## Rules

- Profile the `bench` preset build: optimised, `-g`, `-fno-omit-frame-pointer` ([21-build-and-toolchain.md](21-build-and-toolchain.md)). Never a debug build.
- Pin threads before profiling. Unpinned samples mix cores and hide which line bounces.
- Count first (`perf stat`), sample second (`perf record`), then explain with a contention tool (`perf c2c`) or a model (`llvm-mca`).
- A profile of a spinning thread shows the spin loop. Hot is not the same as slow: the waiter burns cycles because the *other* thread is slow.
- Sampling skids. Attribute to an instruction only with precise events (PEBS, IBS).
- Every finding names its mechanism: instructions, branch misses, cache misses, HITMs, or off-CPU time. "The flame graph got narrower" is not a finding.

## Symptom to tool

| Symptom | First tool | Then |
|---|---|---|
| Throughput drops as threads are added | `perf c2c` (HITM) | `pahole` on the hot struct, [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| Fast alone, slow next to an unrelated object | `perf c2c report --double-cl` | Alignment and adjacent-line prefetch, [12-cpu-and-cache.md](12-cpu-and-cache.md) |
| Single-thread path slower after a change | `perf stat -e instructions,branches,branch-misses`, `perf annotate` | optimisation remarks, `llvm-mca` |
| Low IPC, no obvious hot spot | top-down (`toplev`, `perf stat --topdown`, `-M PipelineL1`) | `perf mem` for back-end bound, `perf annotate` for front-end |
| Cache misses on the ring | `perf mem record`, `perf report --mem-mode` | Capacity against cache size, prefetch, huge pages ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) |
| High dTLB misses | `perf stat -e dTLB-load-misses` | Huge pages |
| Rare latency spikes | harness logs slow ops; `perf sched timehist`; `rtla osnoise` | `magic-trace` or `perf record --switch-output` snapshot |
| Threads asleep when they should work | `perf trace -e futex -s`, `offcputime-bpfcc` | [07-waiting.md](07-waiting.md): lost wake-up or thundering herd |
| Allocation on the hot path (breaks I5) | `heaptrack` | `perf record -e syscalls:sys_enter_mmap,syscalls:sys_enter_brk` |
| "Why is this function not inlined / vectorised" | `-Rpass-missed=`, `-fopt-info-missed` | [11-cpp23-craft.md](11-cpp23-craft.md) |
| Binary grew | `bloaty` | template instantiations per policy ([04-api.md](04-api.md)) |
| Struct has holes or straddles lines | `pahole -C` | `static_assert` on `sizeof` and `offsetof` |
| "Which stage is worth optimising at all" | `coz` | |

## Setup

```bash
cat /proc/sys/kernel/perf_event_paranoid          # 4 on Ubuntu: no unprivileged perf at all
sudo sysctl kernel.perf_event_paranoid=1          # user-space profiling; -1 for kernel and system-wide
sudo sysctl kernel.kptr_restrict=0                # kernel symbols
perf version --build-options                      # which features this perf was built with
```

- Frame pointers give cheap, reliable stacks. `--call-graph dwarf` works without them but copies stack memory per sample: large files, and it truncates deep stacks. `--call-graph lbr` is Intel only.
- Distribution `perf` builds differ. On the checked box `bpf_skeletons` is off, so `perf record --off-cpu` and `perf lock contention -b` are listed in help and will not work. Read the build options before trusting a recipe.
- In containers and VMs the PMU is often absent. `perf stat` printing `<not supported>` means go to bare metal.

## Counting: perf stat

```bash
perf stat -r 5 -e cycles,instructions,branches,branch-misses,cache-references,cache-misses \
          -e context-switches,cpu-migrations,page-faults -- taskset -c 2-9 ./bench <args>
perf stat --per-thread -e cycles,instructions -p <pid> -- sleep 5   # one row per thread
perf stat -d -d -- ./bench <args>                                   # adds L1d, LLC, dTLB, iTLB
perf stat -I 1000 -x, -e instructions,cycles -- ./bench <args>      # time series, CSV
perf stat -a -e power/energy-pkg/ -- ./bench <args>                 # energy, root, system-wide
```

- `cpu-migrations` MUST be 0 for a pinned run, `page-faults` near 0 in steady state.
- Use `:u` (`instructions:u`) to exclude the kernel when comparing code paths.
- Pitfall: more than about 4 to 8 hardware events at once are multiplexed and scaled. The percentage in the last column shows it. Fewer events, more runs.
- Pitfall: `cache-misses` means different things per vendor. Use named events from `perf list` when it matters.
- Pitfall: instructions per op for a contended run includes spin iterations. Divide by completed ops and report both.

## Sampling: perf record, report, annotate

```bash
perf record -F 999 -g -- ./bench <args>                      # frame-pointer stacks
perf record -F 999 --call-graph dwarf,16384 -- ./bench <args>
perf report --no-children --sort dso,symbol
perf report --no-children --sort comm,symbol                 # per thread role, if threads are named
perf annotate --stdio -M intel -s <symbol>                   # per-instruction cost
perf annotate --stdio -l -s <symbol>                         # with source lines
perf diff -c ratio base.data new.data
```

- Name threads (`pthread_setname_np`) in the harness: producers and consumers then separate in every report.
- `-F 999`, not 1000, avoids locking to periodic work.
- Skid: a normal sample lands a few instructions after the one that caused it. In a CAS loop that moves the blame from the `lock cmpxchg` to the branch after it. Use precise events:

| Vendor | Mechanism | Command |
|---|---|---|
| Intel | PEBS | `perf record -e cycles:pp -- ./bench` (`:ppp` for the most precise form available) |
| AMD | IBS | `perf record -e ibs_op// -c 100000 -- ./bench`; `ibs_fetch//` for front-end. `cpu-cycles:p` is translated to `ibs_op//` |
| Arm | SPE | `perf record -e arm_spe_0// -- ./bench`, where the core has it |

- IBS samples everything on the CPU unless filtered: user-only is `ibs_op/swfilt=1/u` up to Zen 5 and `ibs_op//u` from Zen 6; `l3missonly=1` needs Zen 4 ([perf-amd-ibs](https://github.com/torvalds/linux/blob/master/tools/perf/Documentation/perf-amd-ibs.txt)).
- Pitfall: after a `lock`-prefixed instruction the next instruction often takes the samples even with precise events, because the locked op is where the pipeline waits. Read annotate output as "this region", then confirm with HITM data.
- Pitfall: inlining. Everything is in `push` and `pop`'s caller. Use `perf report --inline` (default with DWARF) or `perf annotate` on the caller.

## False sharing and contention: perf c2c

The tool for this project. It samples loads and stores with data addresses and groups them by cache line. A **HITM** is a load that hit a line held Modified in another core's cache: a line transfer.

```bash
perf c2c record -u -- ./bench <args>              # options after `--` go to perf record
perf c2c record -u --ldlat 30 -- ./bench <args>   # Intel: only loads slower than 30 cycles
perf c2c report --stdio -NN --stats               # totals: how many HITMs at all
perf c2c report --stdio -NN -c pid,iaddr --full-symbols
perf c2c report --stdio --double-cl               # treat adjacent lines as one (adjacent-line prefetch)
```

Read the report in this order:

1. "Shared Data Cache Line Table": lines sorted by HITM count. One line with most of the HITMs is the finding.
2. "Shared Cache Line Distribution Pareto": for each line, the offsets touched, the code address, and which CPUs. Two different offsets written by different threads is **false sharing**. The same offset is **true sharing** (the head or tail counter): expected, and the goal is fewer accesses, not zero.
3. Map offset to field with `pahole`.

| Support | Detail |
|---|---|
| Intel | PEBS load latency and data source. Full support |
| AMD | IBS op. **Not supported on Zen 3** ([perf-c2c](https://github.com/torvalds/linux/blob/master/tools/perf/Documentation/perf-c2c.txt)). `--ldlat` only where `/sys/bus/event_source/devices/ibs_op/caps/ldlat` is 1 |
| Arm64 | SPE; uses "peer" snooping display (`-d peer`) instead of HITM |

- The dev box for this repo is Zen 3: `perf c2c` cannot be used there. Use `perf mem` for miss locations and a Zen 4+, Intel, or SPE machine for HITM work.
- Pitfall: HITM counts are samples, not totals. Compare runs with the same sampling setup and duration.
- Pitfall: a clean c2c report at low thread counts proves nothing. Record at the thread count where throughput bends.
- Pitfall: heap addresses change per run. Identify lines by symbol and offset, not by address.
- Check after a fix: HITMs on that line fall, *and* throughput rises ([19-benchmarking.md](19-benchmarking.md)). One without the other means the wrong line.

## Memory access: perf mem

```bash
perf mem record -t load -- ./bench <args>
perf mem report --sort mem,symbol_daddr,symbol
perf report --mem-mode --sort symbol_daddr,mem --stdio
perf mem record --data-page-size -- ./bench <args>      # page size per sample: are huge pages used?
```

- Shows which data symbols miss and at which cache level. For the ring: slot loads served from L3 or DRAM mean the ring outran the cache or the prefetcher.
- `perf mem record -e list` shows what the machine supports.

## Top-down

Splits pipeline slots into front-end bound, bad speculation, back-end bound, retiring ([Yasin, ISPASS 2014](https://ieeexplore.ieee.org/document/6844459)).

```bash
toplev -l3 --no-desc -- taskset -c 2-9 ./bench <args>   # Intel, pmu-tools
perf stat --topdown -- ./bench <args>                   # Intel, kernel-supported cores
perf stat -M PipelineL1,PipelineL2 -- ./bench <args>    # AMD Zen 4 and later
perf list metricgroup                                   # what this machine offers
```

- [`toplev`](https://github.com/andikleen/pmu-tools) is Intel only. AMD's `PipelineL1`/`PipelineL2` metric groups exist in the Zen 4+ event files ([amdzen4/pipeline.json](https://github.com/torvalds/linux/blob/master/tools/perf/pmu-events/arch/x86/amdzen4/pipeline.json)); the Zen 3 dev box does not list them.
- Expected shape for a contended queue: back-end bound, memory. Top-down says "memory"; `perf c2c` says which line.
- Pitfall: top-down on a multi-threaded process averages producers, consumers and spinners. Use `--per-thread` or pin and use `-C`.
- High "retiring" on a slow queue means it executes many useful-looking instructions: usually spinning. Check `pause` counts.

## Branch records: LBR, AutoFDO

```bash
perf record -b -e cycles:u -- ./bench <args>            # sample with branch stacks
perf report --branch-history --stdio
perf report -b --sort symbol_from,symbol_to
```

- Uses: mispredicted branch pairs, hot-path basic-block frequencies, and input for sample PGO and BOLT. Build side: [21-build-and-toolchain.md](21-build-and-toolchain.md).
- Intel: LBR. AMD: LBR v2 from Zen 4 (`amd_lbr_v2` in `/proc/cpuinfo`); some Zen 3 parts have the more limited Branch Sampling (`brs`). The dev box lists neither flag, so `perf record -b` is not available there: BOLT and sample PGO profiles must come from another machine or from instrumentation.
- Convert for the compiler: `llvm-profgen --binary=./bench --perfdata=perf.data --output=bench.prof` or [`create_llvm_prof`](https://github.com/google/autofdo).

## Static pipeline models: llvm-mca, uiCA

```bash
clang++ -O2 -march=x86-64-v3 -S -o - hot.cpp | llvm-mca -mcpu=znver3 -timeline -bottleneck-analysis
```

Mark a region in the source with `__asm volatile("# LLVM-MCA-BEGIN push");` and `"# LLVM-MCA-END"`. Checked: `llvm-mca` 22 accepts `-mcpu=znver3`.

| Tool | Models | Does not model |
|---|---|---|
| [`llvm-mca`](https://llvm.org/docs/CommandGuide/llvm-mca.html) | Ports, uops, dependencies, from LLVM scheduling tables | Caches, coherence, branch prediction, front-end. It treats code as a loop of straight-line instructions |
| [uiCA](https://github.com/andreas-abel/uiCA) | Intel cores (SNB to RKL) including front-end; more accurate than llvm-mca on those per its [paper](https://dl.acm.org/doi/pdf/10.1145/3524059.3532396) | AMD, Arm, anything after Rocket Lake, caches |

- Use for: comparing two encodings of the uncontended fast path (dependency chain length, port pressure).
- Do NOT use for: anything involving `lock` instructions under contention. The model gives the uncontended latency; the real cost is the line transfer.
- Markers can change code generation. Compare assembly with and without.

## Size and layout: pahole, bloaty

```bash
pahole -C 'basic_queue<int, ...>' ./bench          # field offsets, holes, cache-line boundaries
pahole --cacheline_size=128 -C <type> ./bench      # Apple silicon, or adjacent-line pairs
bloaty -d compileunits ./bench
bloaty -d symbols -n 30 ./bench -- ./bench.base    # size diff against a baseline
```

- `pahole` (package `dwarves`) reads DWARF. Template names must match exactly: list candidates with `pahole --sizes ./bench | grep queue`.
- It marks cache-line boundaries assuming 64 bytes. That is not the destructive size ([09-cache-friendly-allocation.md](09-cache-friendly-allocation.md)).
- Turn every layout fact you rely on into a `static_assert`; `pahole` finds it, the assert keeps it.
- [`bloaty`](https://github.com/google/bloaty): each policy combination is a separate instantiation. Watch for growth when adding a policy.

## Compiler remarks

```bash
clang++ -O2 -Rpass=inline -Rpass-missed=inline -c hot.cpp
clang++ -O2 -Rpass=loop-vectorize -Rpass-missed=loop-vectorize -Rpass-analysis=loop-vectorize -c hot.cpp
clang++ -O2 -fsave-optimization-record -c hot.cpp      # writes hot.opt.yaml
g++ -O2 -fopt-info-inline-missed -fopt-info-vec-optimized-missed -c hot.cpp
```

- Checked on Clang 22 and GCC 16: flags accepted, vectoriser remarks printed for a sum loop.
- First use: confirm `try_push` and `try_pop` inline into the caller, and that the slow path does not.
- A missed remark gives the reason ("cost", "noinline", "unsafe dependence"). Fix the reason; do not reach for `always_inline` first.
- Remarks differ between compilers and versions. A fix for one may not help the other. Check both.

## Off-CPU, futex and scheduler

```bash
perf trace -s -e futex -- ./bench <args>                 # futex call counts and time per thread
perf trace -e futex --call-graph dwarf --max-stack 8 -p <pid>
sudo offcputime-bpfcc -df -p <pid> 10 > off.stacks       # blocked time by stack (bcc)
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_futex /comm == "bench"/ { @[tid, args->op & 127] = count(); }'
perf sched record -- ./bench <args>
perf sched latency --sort max                            # worst wake-to-run delay per task
perf sched timehist -w -M -V                             # wake-ups, migrations, per-CPU picture
```

- `op & 127` strips `FUTEX_PRIVATE_FLAG` (128): 0 is `FUTEX_WAIT`, 1 is `FUTEX_WAKE`.
- Healthy parked queue: wakes roughly equal waits, and few of either at high load (waiters should spin first). Many wakes that wake nobody is wasted syscalls on the push path; see [07-waiting.md](07-waiting.md).
- `perf sched latency` separates "the wake-up was late" (scheduler) from "the wake-up was never sent" (our bug).
- Pitfall: off-CPU profiles need stacks at the switch-out point. Without frame pointers they are empty or wrong.
- Pitfall: tracing every futex call slows the path it measures. Use it to count and locate, never for latency numbers.

## Latency outliers

Averages and flame graphs erase the one slow op in ten million. Hunt it directly:

1. Harness records, per slow op: timestamp, thread, CPU (`sched_getcpu`), ticket.
2. Correlate with the system on the same clock:

```bash
perf sched timehist --state -C 2-9                      # was the thread descheduled then?
sudo rtla osnoise top -c 2-9 -d 30s                     # OS noise per CPU: IRQs, softirqs, threads
sudo perf record -e 'irq:*' -e sched:sched_switch -C 2-9 -- sleep 10
perf stat -e page-faults,dTLB-load-misses -I 100 -- ./bench <args>
```

3. Capture what led up to it. Snapshot mode keeps a ring buffer and dumps on demand:

```bash
perf record --overwrite --switch-output=signal -g -- ./bench <args> &   # then: kill -USR2 <perf pid>
magic-trace attach -pid <pid>                                            # Intel PT; Ctrl-C to snapshot
magic-trace attach -pid <pid> -trigger <mangled symbol>                  # snapshot when that function is called
```

- [`magic-trace`](https://github.com/janestreet/magic-trace) needs Intel PT; no AMD support. Put a no-inline marker function on the harness's "slow op seen" branch and trigger on it.
- Usual culprits, in rough order of frequency (hypothesis; rank them on your machine): preempted slot holder, page fault on first touch, timer tick or IRQ on a non-isolated CPU, frequency transition, THP compaction, SMT sibling activity.
- A preempted holder shows as: one thread off-CPU in `sched timehist` while others spin. That is the algorithm's progress property, not noise ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)).

## Other profilers

| Tool | Use it for | Limits |
|---|---|---|
| [Coz](https://github.com/plasma-umass/coz) | Causal profiling: "if this line were x% faster, throughput changes by y%". `coz run --- ./bench`, with `COZ_PROGRESS` at each completed pop, `-g`, link `-ldl` ([Curtsinger and Berger, SOSP 2015](https://dl.acm.org/doi/10.1145/2815400.2815409)) | Needs a progress point; several runs to converge |
| [heaptrack](https://github.com/KDE/heaptrack) | Prove I5: `heaptrack ./bench`, then `heaptrack_print <file>`; allocations after construction MUST be zero | Sees `malloc`, not direct `mmap` |
| [Hotspot](https://github.com/KDAB/hotspot) | GUI for `perf.data`: flame graphs, per-thread timeline, off-CPU view | Needs the sched switch events recorded for off-CPU |
| Flame graphs | `perf script \| stackcollapse-perf.pl \| flamegraph.pl > out.svg` ([FlameGraph](https://github.com/brendangregg/FlameGraph)) | CPU time only; blind to coherence |
| [Tracy](https://github.com/wolfpld/tracy) | Instrumented timeline of the *application* around the queue | Zones inside `push`/`pop` cost more than the operation. Instrument callers |
| [AMD uProf](https://www.amd.com/en/developer/uprof.html) | IBS-based hot spots and cache analysis on AMD, GUI and CLI | AMD only |
| [Intel VTune](https://www.intel.com/content/www/us/en/developer/tools/oneapi/vtune-profiler.html) | `vtune -collect hotspots`, `-collect uarch-exploration`, `-collect memory-access`, `-collect threading` | Hardware modes are Intel only |

## Pitfalls that cost days

- Optimising the hottest function when it is a victim. The consumer's `try_pop` is hot because the producer's store keeps taking the line.
- Profiling with the profiler's own threads on the benchmark's cores. Pin `perf` elsewhere: `taskset -c 0 perf record ... -- taskset -c 2-9 ./bench`.
- Trusting a 10-second profile of a run whose first 5 seconds are page faults.
- Reading `perf annotate` percentages across a `lock` instruction as exact.
- Comparing profiles from different thread counts or placements.
- Forgetting the build: a profile of `-O0` or of a sanitizer build describes a different program.
