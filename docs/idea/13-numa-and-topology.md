# 🗺️ NUMA and topology

**The unit of locality is the set of cores that share a last-level cache, not the socket and not the NUMA node.** Discover it at run time, shard on it only when one ring's counters are the measured bottleneck, and say what ordering the shards give up.

Status: design. Latencies are cited from public measurements with their hardware. As of 2026-11.

Owned elsewhere: what a line transfer costs ([12-cpu-and-cache.md](12-cpu-and-cache.md)), first touch, page placement and huge pages ([09-cache-friendly-allocation.md](09-cache-friendly-allocation.md), [08-arenas-and-allocators.md](08-arenas-and-allocators.md)), pinning for benchmarks ([19-benchmarking.md](19-benchmarking.md)), algorithms ([03-algorithms.md](03-algorithms.md)).

## Rules

- The core library MUST NOT pin threads, read sysfs, or call `mbind`. Topology is the caller's policy. The library offers a shard count and a shard-selection hook, nothing hidden ([01-vision.md](01-vision.md), goal 4).
- Never size anything from `std::thread::hardware_concurrency()` alone. It ignores affinity masks and cgroup quotas.
- Never hard-code a topology ("8 cores per CCX", "node 0 is socket 0"). Read it.
- A sharded queue MUST document its ordering contract. It is not the same queue.
- A shard is chosen once per handle, not per operation, wherever per-producer FIFO (I2) is promised.
- `sched_getcpu()` and `rseq` CPU ids are hints. The thread can migrate on the next instruction.
- No NUMA work before a measurement shows cross-node traffic is the bottleneck: [When not to care](#when-not-to-care).

## Layers of locality

| Layer | What is shared | Typical boundary | Crossing costs |
|---|---|---|---|
| SMT siblings | L1, L2, execution resources | 2 threads per core (x86), 1 on most Arm servers | Cheapest transfer, shared throughput |
| Core cluster | L2 on some designs (Intel E-core clusters of 4, some Arm) | 2 to 4 cores | Small |
| **LLC group** | L3 | Intel: usually the whole socket. AMD: one CCX, up to 8 cores. Arm servers: often the whole socket | The step that matters on AMD |
| Die / CCD | Package-internal link | AMD: one or two CCXs per CCD | Same as leaving the LLC group |
| NUMA node | Memory controller | Socket, or part of one (SNC, NPS) | Memory latency too, not only cache transfers |
| Socket | Inter-socket link | 1, 2, 4, 8 | 2 to 3 times the same-socket transfer |

Measured core-to-core transfer medians, CAS ping-pong between two pinned cores ([nviennot/core-to-core-latency](https://github.com/nviennot/core-to-core-latency) README):

| CPU | Inside the group | Across groups | Across sockets |
|---|---|---|---|
| Ryzen 9 5950X (2 CCXs of 8) | 17 ns | 85 ns | n/a |
| Threadripper 3960X | 24 ns | 94 ns | n/a |
| EPYC 7R13 | 23 ns | 107 ns | 197 ns |
| Xeon Platinum 8375C | 51 ns | same LLC | 108 ns |
| Xeon Gold 6242 | 48 ns | same LLC | 136 ns |
| Core i9-12900K (P+E) | 35 ns | 44 to 50 ns between core types | n/a |
| Apple M1 Pro | 40 to 53 ns | 145 ns between P clusters | n/a |
| AWS Graviton3 | 46 ns | uniform | n/a |

Reading: on AMD the CCX boundary inside one socket costs about what a socket boundary costs on Intel. A "single-socket, NUMA-free" EPYC is not flat.

## Vendor specifics

| Feature | What it does | Consequence |
|---|---|---|
| **AMD CCX / CCD** | Each CCX has a private L3. No L3 sharing between CCXs | Producer and consumer in different CCXs pay the cross-group cost on every hand-off |
| **X3D, single-cache parts** (7950X3D, 9950X3D) | 3D V-Cache on one CCD only: the two CCDs have different L3 sizes | L3 groups are not equal. A benchmark's result depends on which CCD it landed on |
| **X3D, dual-cache** (9950X3D2, released 2026-04, [AMD](https://www.amd.com/en/products/processors/desktops/ryzen/9000-series/amd-ryzen-9-9950x3d2-dual-edition.html)) | V-Cache on both CCDs | Symmetric caches, still two L3 groups |
| **AMD NPS** (NUMA nodes per socket: 0, 1, 2, 4) | BIOS setting that splits a socket into NUMA nodes by memory-channel group ([AMD EPYC 9005 BIOS and workload tuning guide](https://www.amd.com/content/dam/amd/en/documents/epyc-technical-docs/tuning-guides/58467_amd-epyc-9005-tg-bios-and-workload.pdf)) | The same hardware reports 1, 2 or 4 nodes per socket. Node count is configuration, not hardware |
| **Intel SNC** (sub-NUMA clustering) | BIOS setting that splits one socket's cores, LLC and memory into 2 or more NUMA nodes | A NUMA node is smaller than a socket. LLC sharing follows the cluster |
| **Hybrid P/E cores** (Intel Alder Lake and later, Arm big.LITTLE) | Core types differ in speed, `PAUSE` length (62 vs 160 cycles on Alder Lake, [12-cpu-and-cache.md](12-cpu-and-cache.md)), SMT and ISA extensions | A spin budget counted in iterations is wrong on half the cores. A consumer on an E-core cannot keep up with a P-core producer |

Pitfalls:

- NUMA node id is not socket id. Under SNC or NPS4 one socket is several nodes. With NPS0 two sockets are one node.
- CPU numbering is arbitrary. SMT siblings are `n` and `n + N/2` on many x86 Linux boxes and `2n`, `2n+1` on others. Read `thread_siblings_list`.
- The OS may park or deprioritise cores (X3D core parking, Intel Thread Director hints). A pinned benchmark thread on a parked core measures the wake-up.

## Discovering topology

| Source | Gives | Notes |
|---|---|---|
| `/sys/devices/system/cpu/cpuN/topology/` | `physical_package_id`, `core_id`, `thread_siblings_list`, `core_cpus_list`, `cluster_cpus_list`, `die_id` | [Kernel docs: cputopology](https://docs.kernel.org/admin-guide/cputopology.html). No library needed |
| `/sys/devices/system/cpu/cpuN/cache/indexK/` | `level`, `type`, `size`, `shared_cpu_list`, `coherency_line_size` | `shared_cpu_list` of the highest level is the LLC group. Use this for shards |
| `/sys/devices/system/node/nodeN/` | `cpulist`, `meminfo`, `distance` | NUMA nodes as configured by BIOS |
| `/sys/devices/system/cpu/cpuN/cpu_capacity` | Relative capacity | Arm asymmetric systems |
| `/sys/devices/cpu_core/cpus`, `/sys/devices/cpu_atom/cpus` | P-core and E-core lists | Intel hybrid, when both PMUs exist |
| `CPUID` leaf `0x1F` / `0x0B` (Intel), `0x8000001E` / `0x80000026` (AMD), `0x1A` (hybrid core type) | Same facts without an OS | [Intel SDM](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html) vol. 2, `CPUID`. Must run pinned on each CPU in turn. Wrong inside VMs that synthesise CPUID |
| [hwloc](https://www.open-mpi.org/projects/hwloc/) (`lstopo`, `hwloc_topology_load`) | Portable tree: package, NUMA node, L3, L2, core, PU | BSD licence. Right choice for a benchmark harness or an application. A dependency the header-only core does not take |
| `lscpu -e`, `numactl -H` | Human-readable | For the benchmark report header |
| Windows: `GetLogicalProcessorInformationEx`. macOS: `sysctl hw.perflevelN.*` | Cache and core-type groups | macOS exposes no affinity API that pins to a core |

Linux, no dependencies. Prints one line per allowed CPU and the number of L3 groups:

```cpp
// check: run
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <string>
#include <thread>
#include <vector>
#if defined(__linux__)
#include <sched.h>
#endif

static std::string read_line(const std::string& path) {
    std::ifstream f(path);
    std::string s;
    if (f) std::getline(f, s);
    return s;   // empty on any failure: callers treat that as "unknown"
}

// CPUs this thread may run on. NOT hardware_concurrency(): that ignores affinity.
static std::vector<int> allowed_cpus() {
    std::vector<int> cpus;
#if defined(__linux__)
    cpu_set_t set;
    CPU_ZERO(&set);
    if (sched_getaffinity(0, sizeof set, &set) == 0)   // fails with EINVAL above CPU_SETSIZE cpus
        for (int c = 0; c < CPU_SETSIZE; ++c)
            if (CPU_ISSET(c, &set)) cpus.push_back(c);
#endif
    if (cpus.empty())
        for (unsigned c = 0; c < std::max(1u, std::thread::hardware_concurrency()); ++c)
            cpus.push_back(static_cast<int>(c));
    return cpus;
}

// cgroup v2 CPU quota in whole CPUs, rounded up; 0 means "no limit found".
static unsigned cgroup_cpu_limit() {
    // Path as seen inside a container; on a host, resolve the group via /proc/self/cgroup.
    std::ifstream f("/sys/fs/cgroup/cpu.max");
    std::string quota;
    double period = 0;
    if (!(f >> quota >> period) || quota == "max" || period <= 0) return 0;
    char* end = nullptr;
    const double q = std::strtod(quota.c_str(), &end);
    if (end == quota.c_str() || *end != '\0' || q <= 0) return 0;   // malformed: report "unknown"
    return static_cast<unsigned>(std::max(1.0, (q + period - 1) / period));
}

int main() {
    const std::string base = "/sys/devices/system/cpu/cpu";
    std::map<std::string, std::vector<int>> by_l3;   // key: shared_cpu_list of the L3
    for (int c : allowed_cpus()) {
        const std::string cpu = base + std::to_string(c);
        std::string l3 = read_line(cpu + "/cache/index3/shared_cpu_list");
        if (l3.empty()) l3 = "unknown";
        by_l3[l3].push_back(c);
        std::printf("cpu %d  package %s  core %s  smt-siblings %s  L3 %s\n", c,
                    read_line(cpu + "/topology/physical_package_id").c_str(),
                    read_line(cpu + "/topology/core_id").c_str(),
                    read_line(cpu + "/topology/thread_siblings_list").c_str(), l3.c_str());
    }
    std::printf("L3 groups (shard candidates): %zu\n", by_l3.size());
    if (unsigned lim = cgroup_cpu_limit()) std::printf("cgroup quota: %u cpu(s)\n", lim);
    return 0;
}
```

How it goes wrong: `index3` is not always the LLC (some Arm cores stop at L2, some parts have an L4). Production code walks `index*` and takes the highest `level` of type `Unified`. `CPU_SETSIZE` is 1024; larger machines need `CPU_ALLOC`.

## How many CPUs do I have

| Query | Answers | Misses |
|---|---|---|
| `std::thread::hardware_concurrency()` | libstdc++: `get_nprocs()`. libc++: `sysconf(_SC_NPROCESSORS_ONLN)` (read from `libstdc++-v3/src/c++11/thread.cc` and `libcxx/src/thread.cpp`, main, 2026-11) | Affinity mask, cpuset, CPU quota. Open request: [GCC bug 113444](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=113444) |
| `sched_getaffinity` | CPUs this thread may use, after `taskset` and cpuset cgroups | CPU-time quota |
| cgroup v2 `cpu.max` (`quota period`) | CPU time per period ([cgroup v2 docs](https://docs.kernel.org/admin-guide/cgroup-v2.html)) | Which CPUs |
| cgroup v2 `cpuset.cpus.effective` | CPUs the group may use | Quota |

Rule: usable parallelism = `min(affinity count, ceil(quota / period))`.

Why a queue cares about quotas: a container with `cpu.max = 200000 100000` on a 64-core host has 64 runnable threads and 2 CPUs of time. When the quota runs out, every thread in the group stops until the next period. A producer stopped between claiming a ticket and publishing the slot blocks the consumers behind it for that long. That is the blocking window of a mutex-free ring made visible ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)), and spinning waiters burn the quota that would have let the producer finish ([07-waiting.md](07-waiting.md)).

How to check: `cat /sys/fs/cgroup/cpu.stat` and watch `nr_throttled` and `throttled_usec` during the run.

## Pinning

| Technique | When to use | When NOT to | How it goes wrong | How to check |
|---|---|---|---|---|
| `pthread_setaffinity_np` / `sched_setaffinity` to one CPU | Benchmarks (always), latency-critical dedicated threads | Library code. General-purpose services where the scheduler has more information | `EINVAL` when the CPU is outside the cpuset. Two threads pinned to one CPU. Pinned to a busy or parked core | `taskset -cp <tid>`, `ps -eLo tid,psr,comm` |
| Pin to an LLC group (mask of several CPUs) | Keep a producer-consumer set inside one L3 and still let the scheduler balance | The group is smaller than the thread count | Oversubscribed group while others idle | Run-queue length per CPU |
| Pin producer and consumer to SMT siblings | Lowest hand-off latency for one pair | Throughput | Halves each thread's resources ([12-cpu-and-cache.md](12-cpu-and-cache.md)) | `thread_siblings_list` |
| `isolcpus`, `nohz_full`, IRQ affinity | Tail-latency measurement | Shared machines | Isolated CPUs get no load balancing: unpinned threads never land there | [19-benchmarking.md](19-benchmarking.md) |
| No pinning | Default for users | Published numbers | Migrations move a thread away from its cached state and its shard | `perf stat -e migrations` |

## Memory placement

Owned by [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) (first touch) and [08-arenas-and-allocators.md](08-arenas-and-allocators.md). Queue-specific points only:

- A ring's slots are written by producers and read by consumers. If they sit on different nodes, no placement is local to both. Place by the side that takes the miss you care about, or shard so both sides are on one node.
- Lazy commit plus first touch means the **first producer to touch a page** decides its node, lap after lap. A ring prefaulted by the constructing thread lives on that thread's node.
- `mbind(MPOL_BIND)` or `numa_alloc_onnode` fixes the node explicitly ([`mbind(2)`](https://man7.org/linux/man-pages/man2/mbind.2.html), [NUMA memory policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)). `MPOL_INTERLEAVE` spreads pages round-robin: predictable average, no locality.
- Automatic NUMA balancing (`kernel.numa_balancing`) unmaps pages to sample access and may migrate them. On a shared ring it sees accesses from every node. Hypothesis: it adds hinting-fault latency spikes and no benefit for a queue touched from several nodes. Experiment: p99.99 with `numa_balancing` 0 and 1, threads on two nodes.
- Per-shard control blocks (head, tail, wait state) belong on the shard's node. They are the lines that bounce.

How to check: `numastat -p <pid>`, `/proc/<pid>/numa_maps` (per-mapping node counts), `perf c2c` with node columns ([20-profiling.md](20-profiling.md)).

## NUMA-aware sharding

One ring per locality group. Each shard is a complete queue ([03-algorithms.md](03-algorithms.md)); the layer above only picks a shard.

| Decision | Options | Trade-off |
|---|---|---|
| Shard key | LLC group (default candidate), NUMA node, core, fixed N | Finer shards: less contention per shard, more stealing and worse balance |
| Producer shard choice | Fixed per handle at creation | Keeps per-producer FIFO within the shard. A migrated thread keeps pushing to its old shard |
| | `sched_getcpu()` per push | Best locality. **Breaks I2**: a thread that migrates pushes element n to shard A and n+1 to shard B, and B may be drained first |
| Consumer choice | Own shard first, then steal | Locality first, starvation-free only if stealing is unconditional |
| Capacity | Per shard | A bounded sharded queue reports full when one shard is full. "Capacity" is no longer one number |
| Empty | All shards scanned empty | Not linearizable as a single emptiness check: an element can be pushed to a shard already scanned ([04-api.md](04-api.md) owns what `empty` promises) |

Contract change, which MUST be documented: no global FIFO, per-producer FIFO only with sticky shard choice, `size_approx()` is a sum of unsynchronised reads (I7).

| | When to use | When NOT to | How it goes wrong | How to check |
|---|---|---|---|---|
| Sharding | One ring's counter lines dominate `perf c2c` and the workload tolerates relaxed order | FIFO across producers is required. Few threads. One LLC group | Imbalance: one shard full while others are empty. Idle consumers scan all shards and touch every head line | Per-shard depth histogram. Steal rate. Compare against one ring at the same thread count |

## Stealing between shards

| Choice | Rule | Source or status |
|---|---|---|
| Victim order | Nearest first: same LLC group, then same node, then remote | Hierarchical idea from NUMA-aware locks: [Dice, Marathe, Shavit, "Lock Cohorting"](https://dl.acm.org/doi/10.1145/2145816.2145848) (PPoPP 2012) keeps work within a node before handing it across |
| Start position | Randomised or per-thread rotating, never "always shard 0" | Fixed start makes shard 0 the hot spot |
| Amount | A batch, not one element | One remote line transfer serves several elements ([12-cpu-and-cache.md](12-cpu-and-cache.md)). Size is an open question |
| Emptiness probe | Read the victim's cached state or a per-shard non-empty hint before touching its counters | A full pop attempt on an empty remote shard is a remote miss for nothing. Hint bitmaps: [14-simd.md](14-simd.md) |
| Blocking | One eventcount for the whole sharded queue, or one per shard plus a global fallback | A consumer parked on shard A must be woken by a push to shard B if it would have stolen it ([07-waiting.md](07-waiting.md)) |

How it goes wrong: a consumer checks shards 0..N-1, finds all empty, parks on its own shard's wait word. A producer pushes to another shard and sees no waiter there. Lost wakeup. The wait protocol must cover every shard the waiter would have served.

Hierarchical queues (per-core buffer, then per-LLC ring, then global ring): each level removes contention from the one above and adds a place where an element can sit unseen. Use only with a bound on how long an element may stay in a private level (flush on size and on time).

## rseq and per-CPU structures

Restartable sequences let a thread run a short critical section on per-CPU data without any atomic instruction: if the thread is preempted, migrated or signalled inside the section, the kernel moves it to an abort handler ([kernel docs: rseq](https://docs.kernel.org/userspace-api/rseq.html), [`rseq(2)` via librseq](https://git.kernel.org/pub/scm/libs/librseq/librseq.git/tree/doc/man/rseq.2)).

| Fact | Detail |
|---|---|
| Registration | glibc 2.35 and later registers one `struct rseq` per thread in the TCB. A program that registers its own conflicts with it. Disable with the `glibc.pthread.rseq` tunable ([Red Hat](https://developers.redhat.com/articles/2022/12/22/restartable-sequences-support-glibc-rhel-9)) |
| Fields | `cpu_id`, `node_id`, and `mm_cid`: a per-process concurrency id that stays close to 0 when the process has few threads or a narrow affinity mask, so per-CPU arrays can be sized by threads, not by host CPUs |
| Shape of a section | Compute privately, then **one** committing store. Written in assembly; the kernel must know the section's address range |
| Who uses it | tcmalloc's per-CPU caches ([design note](https://google.github.io/tcmalloc/rseq.html)) |

| | When to use | When NOT to | How it goes wrong | How to check |
|---|---|---|---|---|
| Per-CPU producer buffers flushed to the shared ring in batches | Linux only, very high producer counts, order across producers not needed | Portable core. Windows, macOS. Latency-sensitive single items | Elements stranded in a CPU's buffer after its last producer leaves: needs a flush on timer and on handle destruction. Single-stepping inside a section in a debugger aborts it forever | Stress with forced migration (`taskset` changes during the run), and a drain test for I1 |

Status: hypothesis. rseq removes the producers' contended RMW and replaces it with a batching stage; whether that beats one `fetch_add(k)` batch claim is an open question.

## sched_getcpu cost

| Platform | Mechanism | Cost class |
|---|---|---|
| glibc 2.35+, Linux with rseq | Reads `rseq.cpu_id` from thread-local memory; falls back to the vDSO when unregistered ([glibc commit, bug 31479](https://inbox.sourceware.org/glibc-cvs/20240318175035.B63BD3858C78@sourceware.org/)) | One TLS load |
| Older glibc, x86-64 | vDSO `getcpu` | A function call, no syscall |
| Older glibc, AArch64 | Real syscall: no vDSO `getcpu` there ([Red Hat](https://developers.redhat.com/articles/2022/12/22/restartable-sequences-support-glibc-rhel-9)) | A kernel entry per call |

- No published head-to-head number found for current hardware. Measure before putting it on the push path.
- The answer is stale on return. Use it to pick a shard hint or a NUMA node at handle creation. Never as a mutual-exclusion key outside an rseq section.

## When not to care

| Situation | Why topology work is wasted |
|---|---|
| All threads fit in one LLC group (most Intel desktops and laptops, any 8-core AMD part) | One level of locality. Nothing to shard on |
| Threads are not pinned and the machine is shared | The scheduler undoes the placement |
| The queue is not the bottleneck: work per element is over about a microsecond | A 100 ns hand-off is under 10% of the element's cost |
| Oversubscribed or quota-limited container | Waiting and preemption dominate ([07-waiting.md](07-waiting.md)) |
| One producer, one consumer | Pin both inside one LLC group and stop |
| Global FIFO is required | Sharding is not available. Only placement and pinning apply |

Decision order: measure one ring pinned inside one LLC group, then across groups, then across sockets. Shard only if the cross-group numbers are the ones production will see and the order contract allows it. Report the topology with every result ([19-benchmarking.md](19-benchmarking.md)).
