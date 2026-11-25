# 📐 Cache-friendly allocation

**Rule: place every byte by who writes it. One writer group per destructive-size block; read-mostly data away from all of them; everything a single operation touches inside as few lines as possible.** How to get the memory is owned by [08-arenas-and-allocators.md](08-arenas-and-allocators.md). Why coherence costs what it costs is owned by [12-cpu-and-cache.md](12-cpu-and-cache.md). NUMA placement is owned by [13-numa-and-topology.md](13-numa-and-topology.md).

As of 2026-11.

## Two sizes, not one

| Constant | Question it answers | Use for |
|---|---|---|
| **Destructive size** | How far apart must two independently written objects be? | `alignas` on head, tail, per-thread state |
| **Constructive size** | How big may a group be and still share one line? | `static_assert(sizeof(hot_group) <= constructive)` |

Defined by [P0154R1](https://wg21.link/p0154r1) as `std::hardware_destructive_interference_size` and `std::hardware_constructive_interference_size` ([cppreference](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size)).

### Do not put the std constant in a layout

| Fact | Evidence |
|---|---|
| Both std constants are **64** on x86-64 | Checked here: GCC 16 and Clang 22, libstdc++ and libc++, `-mtune=generic`, `znver3`, `skylake` |
| The value is not an ABI constant | GCC warns under `-Winterference-size`: "its value can vary between compiler versions or with different '-mtune' or '-mcpu' flags" and "if this use is part of a public ABI, change it to instead use a constant variable you define" ([GCC warning options](https://gcc.gnu.org/onlinedocs/gcc/Warning-Options.html); text reproduced with GCC 16) |
| The warning fires only when the use is in a header | Reproduced with GCC 16: same line in the main file is silent |
| 64 does not cover adjacent-line prefetch on x86 | folly uses 128 on x86-64: "pairs of cache lines also see destructive interference under heavy use of atomic operations, as observed for atomic increment on Sandy Bridge" ([folly/lang/Align.h](https://github.com/facebook/folly/blob/main/folly/lang/Align.h)) |
| Others agree on 128 | crossbeam `CachePadded`: 128 on x86-64, aarch64, powerpc64; 256 on s390x ([source](https://github.com/crossbeam-rs/crossbeam/blob/master/crossbeam-utils/src/cache_padded.rs)). atomic_queue: 64 on x86, 128 on Apple arm64 and ppc64, 256 on s390x ([defs.h](https://github.com/max0x7ba/atomic_queue/blob/master/include/atomic_queue/defs.h)) |

Header-only library + two translation units built with different `-mtune` + a layout that depends on the std constant = two layouts for one type. That is an ODR violation with no diagnostic.

**Rule.** The library defines its own constant, fixed per architecture, overridable by one macro that the build system sets for every TU. Do not `static_assert` it against the std value: GCC 15 and Clang 22 report 256 on generic AArch64 (seen in this repo's Arm CI, 2026-11), so the assert fails there and would tie the layout check to tuning flags.

| Architecture | `destructive_size` (proposed default) | Why |
|---|---|---|
| x86-64 | 128 | 64-byte lines fetched in pairs by the adjacent-line prefetcher |
| aarch64 | 128 | Apple silicon reports 128-byte lines; costs little elsewhere. Cores with 256-byte lines (A64FX) need the override macro |
| ppc64 | 128 | 128-byte lines |
| s390x | 256 | 256-byte lines |
| other | 64 | |

Whether 128 beats 64 on current x86 is unmeasured here. Experiment: two threads each incrementing its own atomic, spaced 64 then 128 bytes apart, pinned to different cores, prefetcher on and off, on Intel and AMD ([19](19-benchmarking.md)). Until then 128 is the safe default: the cost is a few hundred bytes per queue.

## Queue layout, with the tests that pin it

```cpp
// check: compile
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>
#include <type_traits>

namespace mpmc {

#if defined(MPMC_DESTRUCTIVE_SIZE)  // set for EVERY translation unit or not at all
inline constexpr std::size_t destructive_size = MPMC_DESTRUCTIVE_SIZE;
#elif defined(__s390x__)
inline constexpr std::size_t destructive_size = 256;
#elif defined(__x86_64__) || defined(_M_X64) || defined(__aarch64__) || defined(__powerpc64__)
inline constexpr std::size_t destructive_size = 128;
#else
inline constexpr std::size_t destructive_size = 64;
#endif
inline constexpr std::size_t constructive_size = 64;

// Members ordered by writer, not by "logical" grouping.
struct ring_header {
    // Block 0: written once in the constructor, then read by everyone. True sharing, wanted.
    std::byte* slots = nullptr;
    std::uint64_t mask = 0;
    // Block 1: written by producers.
    alignas(destructive_size) std::atomic<std::uint64_t> tail{0};
    // Block 2: written by consumers.
    alignas(destructive_size) std::atomic<std::uint64_t> head{0};
};

constexpr std::size_t block_of(std::size_t offset) noexcept { return offset / destructive_size; }

static_assert(std::is_standard_layout_v<ring_header>);  // keeps offsetof well defined
static_assert(alignof(ring_header) == destructive_size);
static_assert(sizeof(ring_header) % destructive_size == 0);  // nothing foreign shares the last block
static_assert(block_of(offsetof(ring_header, mask)) == block_of(offsetof(ring_header, slots)));
static_assert(block_of(offsetof(ring_header, tail)) != block_of(offsetof(ring_header, mask)));
static_assert(block_of(offsetof(ring_header, head)) != block_of(offsetof(ring_header, tail)));
static_assert(offsetof(ring_header, mask) + sizeof(std::uint64_t) <= constructive_size);

// Slot: sequence and element are touched by the same operation, so they share a line.
template <class T>
struct slot {
    std::atomic<std::uint64_t> sequence;
    union {
        T value;  // lifetime managed by hand, see 10-raii-and-lifetime.md
    };
    slot() noexcept {}
    ~slot() {}
};

static_assert(sizeof(slot<std::uint64_t>) == 16);
static_assert(constructive_size / sizeof(slot<std::uint64_t>) == 4);  // 4 slots per line: see remapping

}  // namespace mpmc
int main() {}
```

| Test | Catches |
|---|---|
| `block_of(a) != block_of(b)` | A new member silently merging two writer groups |
| `sizeof % destructive_size == 0` | The next heap object sharing the consumers' block |
| `is_standard_layout` | `offsetof` on a non-standard-layout type is only conditionally supported |
| `sizeof(slot<T>)` for the benchmark payloads | A padding change that halves slots per line |
| Runtime: `assert(reinterpret_cast<uintptr_t>(this) % destructive_size == 0)` | Allocation through a path that drops alignment (`malloc` of an over-aligned type, a C API) |

Layout asserts prove the layout. They do not prove absence of false sharing with **other** objects, or within the slot array. That needs `perf c2c` ([20-profiling.md](20-profiling.md)).

## False sharing: where it hides in a queue

| Place | Mechanism | Fix |
|---|---|---|
| Head next to tail | Producers and consumers invalidate each other on every op | Separate blocks (above) |
| Read-mostly `mask`/`slots` next to head or tail | Every op reads them; every op by the other side invalidates them | Own block, written once |
| Adjacent small slots | Producer writes slot `i` while a consumer reads slot `i-1` on the same line | Padding, or index remapping (below) |
| First or last slot next to a foreign heap object | Neighbour's writes hit slot 0's line | Align the array and round its size; rigtorp/MPMCQueue allocates `capacity + 1` slots, folly pads `kSlotPadding` slots at each end |
| Per-thread handles allocated back to back | Two handles from one `malloc` size class share a line | `alignas(destructive_size)` on the handle |
| Stats counters | "Harmless" global `pushed++` puts a contended RMW on every op | Per-handle counters, summed on read |
| `alignas` on a member, object on the stack or in `std::vector` | Fine since C++17 (aligned `new`); **not** fine through `malloc`, `realloc`, or pre-C++17 allocators | Runtime alignment assert in the constructor |

## Slot padding versus density

| Layout | Lines touched per op | False sharing between neighbours | Memory for 2^20 slots of 16 B | Batch / scan friendly |
|---|---|---|---|---|
| Dense, in ticket order | 1 | Yes, whenever head and tail are within one line of each other, and between producers claiming adjacent tickets | 16 MiB | Yes: contiguous runs |
| Dense + index remap | 1 | Reduced: consecutive tickets land on different lines | 16 MiB | No: a run of tickets is scattered |
| Padded to constructive size | 1 | None | 64 MiB | Wasteful but contiguous |
| Padded to destructive size (128) | 1 | None, including line pairs | 128 MiB | Same |

Memory figures are arithmetic (`2^20 × size`). Which wins on throughput depends on payload size, thread count and how full the ring runs: an open question with an experiment, not a default.

## Index remapping

Goal: consecutive tickets touch different lines, without padding. Requires power-of-two capacity and a **bijection** on indices.

| Library | Method | Verified in source |
|---|---|---|
| atomic_queue | Swap the low N index bits (position in line) with the next N bits (line number), N = log2(elements per line). Only when `MINIMIZE_CONTENTION` is set and capacity ≥ 2^(2N); capacity is rounded up to a power of two | [atomic_queue.h](https://github.com/max0x7ba/atomic_queue/blob/master/include/atomic_queue/atomic_queue.h), `GetIndexShuffleBits`, `RemapXor` / `RemapAnd` / `RemapBmi`, commit `b7f1bef` (2026-10) |
| folly MPMCQueue | `idx = ((ticket * stride) % capacity) + kSlotPadding`; `stride` is picked from small primes coprime to the capacity to maximise separation. Works for non-power-of-two capacity | [MPMCQueue.h](https://github.com/facebook/folly/blob/main/folly/MPMCQueue.h), `computeStride`, `idx` |
| rigtorp/MPMCQueue | No remap. Each slot's `turn` is `alignas(kFalseSharingRange)`: padding | [MPMCQueue.h](https://github.com/rigtorp/MPMCQueue/blob/master/include/rigtorp/MPMCQueue.h) |

atomic_queue's source comments claim its `RemapAnd` is "at least +1% faster throughput benchmark relative to RemapXor" and `RemapBmi` "+1.5%". Those are the author's numbers with no hardware stated; treat as a hint that the remap sits on the critical path.

```cpp
// check: compile
#include <array>
#include <cstddef>
#include <cstdint>

// Swap the low `bits` bits with the next `bits` bits. Idea from atomic_queue (MIT); code is ours.
constexpr std::uint64_t remap_swap(std::uint64_t ticket, std::uint64_t mask, unsigned bits) noexcept {
    const std::uint64_t low = (std::uint64_t{1} << bits) - 1;
    const std::uint64_t i = ticket & mask;
    return ((i >> bits) & low) | ((i & low) << bits) | (i & ~(low | (low << bits)));
}

// Multiply by an odd constant: a bijection modulo any power of two.
constexpr std::uint64_t remap_stride(std::uint64_t ticket, std::uint64_t mask, std::uint64_t odd) noexcept {
    return (ticket * odd) & mask;
}

template <class F>
constexpr bool is_bijection(F f, std::size_t capacity) {
    std::array<bool, 1024> seen{};
    for (std::size_t t = 0; t < capacity; ++t) {
        const auto i = static_cast<std::size_t>(f(t));
        if (i >= capacity || seen[i]) return false;
        seen[i] = true;
    }
    return true;
}

// Tickets t and t+1 must land at least `per_line` slots apart, the wrap included.
template <class F>
constexpr bool neighbours_split(F f, std::size_t capacity, std::size_t per_line) {
    for (std::size_t t = 0; t < capacity; ++t) {
        const auto a = static_cast<std::size_t>(f(t));
        const auto b = static_cast<std::size_t>(f(t + 1));
        if (a / per_line == b / per_line) return false;
    }
    return true;
}

inline constexpr std::size_t cap = 1024;  // slots
inline constexpr unsigned bits = 2;       // 4 slots of 16 bytes per 64-byte line
constexpr auto swap4 = [](std::uint64_t t) { return remap_swap(t, cap - 1, bits); };
constexpr auto stride5 = [](std::uint64_t t) { return remap_stride(t, cap - 1, 5); };

static_assert(is_bijection(swap4, cap));
static_assert(is_bijection(stride5, cap));
static_assert(neighbours_split(swap4, cap, 4));
static_assert(neighbours_split(stride5, cap, 4));
static_assert(remap_swap(1, cap - 1, bits) == 4);  // ticket 1 -> first slot of line 1
int main() {}
```

| Use when | Do NOT use when |
|---|---|
| Slot smaller than a line, many producers or many consumers, ring usually near empty or near full | Slot already ≥ destructive size (nothing to gain) |
| | Batch push/pop that wants one contiguous run, or a SIMD scan over consecutive sequences ([14](14-simd.md)) |
| | One producer, one consumer far apart in the ring: remap defeats the hardware stream prefetcher for nothing |

| Goes wrong | Check |
|---|---|
| Mapping is not a bijection: two tickets share a slot, silent data loss | `static_assert(is_bijection(...))` for every supported capacity class; exhaustive test for small capacities |
| Remap applied to the index but the stored sequence still compared as if contiguous | Sequence logic uses tickets; only the final array index is remapped |
| Capacity smaller than 2^(2N): bit swap degenerates | Disable remap below the threshold, as atomic_queue does |
| Even stride | Not a bijection. `static_assert(odd % 2 == 1)` |
| Remap cost on the critical path | The index feeds the slot load. Inspect with `llvm-mca` ([20](20-profiling.md)) |

## AoS, SoA, AoSoA for slots

| Layout | Shape | Good | Bad |
|---|---|---|---|
| **AoS** | `{sequence, value}` per slot | One line per op for small `T` | Sequences sparse: scanning N sequences touches N slots' worth of lines |
| **SoA** | `sequence[]` and `value[]` separate (atomic_queue's `AtomicQueue2` keeps `states_[]` and `elements_[]` apart) | Dense sequences: SIMD scan, cheap `size`/emptiness probes; values stay cold until claimed | Two lines per op; dense sequence array is a false-sharing magnet without remap |
| **AoSoA** | Blocks of K sequences followed by K values | One or two lines per op and a scannable group | Complexity; K must match the scan width |

Pick AoS for `sizeof(slot) <= constructive_size`. Reconsider at larger `T`: the sequence check of a full or empty ring then pulls in a line of payload it never uses. Open question with experiment.

## Hot/cold split

| Hot (every op) | Warm (slow path) | Cold (construction, shutdown, stats) |
|---|---|---|
| `head` or `tail`, `mask`, `slots`, the slot | Waiter count, eventcount ([07](07-waiting.md)), cached opposite index | Allocator, capacity as given, name, counters, handle registry |

- Cold fields go **after** the hot blocks or behind a pointer. Never between head and tail.
- A handle's cached copy of the opposite counter is hot for its owner only. It lives in the handle, not in the queue.
- Do not split so far that the slow path needs a second cache miss to learn it is the slow path.

## Sets, colours and 4K aliasing

| Effect | Mechanism | Bites when | Check |
|---|---|---|---|
| **Set conflicts** | L1D set index comes from low address bits. Example, this dev box (Zen 3): 32 KiB, 8 ways, 64 sets of 64 B, so set = address bits 6..11 and anything 4096 B apart competes for the same 8 ways. Read yours from `/sys/devices/system/cpu/cpu0/cache/index0/` | More than `ways` hot objects at the same page offset: page-aligned per-thread blocks, one hot header at the start of each mapping | `perf stat -e L1-dcache-load-misses`; vary one object's offset by a line and re-measure |
| **Cache colouring** | Start each instance at a different multiple of the line size inside its page, so hot headers spread over sets ([Bonwick 1994](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html), slab colouring) | Many queues or handles each from its own page-aligned mapping | Histogram of `(address >> 6) & (sets - 1)` over live hot objects |
| **4K aliasing** | Intel cores compare only the low 12 address bits when first checking a load against earlier stores; a store and a later load 4096 B apart look dependent and the load is delayed. Described in the Intel Optimization Reference Manual, aliasing in caches (primary PDF not fetched for this doc: treat as **unverified summary**) | Copying a payload between two buffers whose addresses differ by a multiple of 4096: page-aligned source batch into page-aligned ring | Intel only: `perf stat -e ld_blocks_partial.address_alias`. Then shift one buffer by 64 B and compare |
| **Power-of-two strides** | A walk with stride 4096 or larger power of two reuses one set | Padded slots of 4 KiB (rare), or SoA arrays all starting page-aligned and indexed together | Offset each array by a different number of lines |

Rule of thumb that falls out: **page alignment is for the kernel, not for the cache.** Align the mapping, then start hot structures at varied line offsets inside it.

## Locality of allocation

| Technique | Use when | How it goes wrong | Check |
|---|---|---|---|
| **Bump allocation** | Objects created together are used together: handle + its buffers, a segment + its metadata | Hot and cold objects interleave because they were created in that order | Allocate hot objects from one arena, cold from another |
| **32-bit handles** (index into an arena) instead of pointers | Payload is a reference; halving it doubles slots per line | Index width caps the object count; every deref adds a base add; a handle outlives its arena generation | Carry a generation in spare bits; `static_assert` on the index range |
| **Pointer compression** (base + shifted 32-bit offset) | All objects live in one reservation ([08](08-arenas-and-allocators.md#lazy-allocation)) | Alignment shift assumed but not enforced | `assert((p - base) % align == 0)` on encode |

### Free-list order

| Order | Effect |
|---|---|
| LIFO | The block reused first is the one most recently freed: likely still in cache **of the thread that freed it**. Good same-thread, bad cross-thread (the line migrates) |
| FIFO | Spreads reuse, delays ABA-style reuse bugs, worst cache behaviour |
| Address order | Best spatial locality and page release; costs a sort or a bitmap |

A remote-free list ([08](08-arenas-and-allocators.md#remote-free-list)) hands blocks back in reverse push order. Sort or reverse when draining if the owner then walks them.

## TLB reach

Reach = TLB entries × page size. A ring larger than the reach pays a page walk on a fraction of operations.

| Ring | 4 KiB pages | 2 MiB pages | 1 GiB pages |
|---|---|---|---|
| 2^20 slots × 64 B = 64 MiB | 16 384 | 32 | 1 |
| 2^24 slots × 64 B = 1 GiB | 262 144 | 512 | 1 |

Page counts are arithmetic. Entry counts are per CPU model: read them with `cpuid -1 | grep -i tlb`, do not assume. How to get huge pages, and how they fail, is in [08](08-arenas-and-allocators.md#huge-pages).

| Check | Command |
|---|---|
| dTLB misses | `perf stat -e dTLB-load-misses,dTLB-store-misses` |
| Huge pages really in use | `grep AnonHugePages /proc/<pid>/smaps` over the ring's range |

Index remapping and huge pages interact: remap scatters consecutive tickets across lines but stays within `2^(2N)` slots, so it does not add TLB pressure. A large odd stride does.

## First touch

Linux places a page on the NUMA node of the CPU that **first writes** it, under the default local policy ([NUMA memory policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)). Policy and pinning are owned by [13](13-numa-and-topology.md).

| Rule | Why |
|---|---|
| Constructor does not touch slot memory (zero-is-empty encoding, [08](08-arenas-and-allocators.md#pitfalls-experts-hit)) | Otherwise the whole ring lands on the constructing thread's node |
| Prefault from the thread, or with the policy, that should own the pages | `MAP_POPULATE` and `MADV_POPULATE_WRITE` populate on behalf of the calling thread |
| A shared ring has no single right node | Producers and consumers on different nodes: interleave, or shard per node |
| Handles are first-touched by their own thread | Construct the handle on the thread that uses it, not in `main` |

Check: `numastat -p <pid>` or `/proc/<pid>/numa_maps` for the ring's range.

## Alignment APIs

| API | Use | Trap |
|---|---|---|
| `alignas(N)` on a type or member | Default. Works for automatic, static, and `new` storage | Ignored by `malloc`/`realloc`/C APIs; a packed or `memcpy`'d container may break it |
| `operator new(size, std::align_val_t)` | Raw aligned block | Must be freed with the matching aligned `operator delete` |
| `std::allocator<T>` | Over-aligned `T` handled since C++17 | Custom allocators written before C++17 may ignore `alignof(T)` |
| `std::aligned_alloc(align, size)` | C interop | `size` should be a multiple of `align` for portability; not available on MSVC (use `_aligned_malloc`) |
| `posix_memalign` | POSIX; THP docs suggest it for 2 MiB alignment | Returns an error code, does not set `errno` |
| `mmap` | Page-aligned; over-allocate and trim for 2 MiB alignment | See [08](08-arenas-and-allocators.md) |
| `std::assume_aligned<N>(p)` | Tell the optimiser a pointer is aligned (vector loads) | UB if it is not. Assert first in debug |
| `std::is_sufficiently_aligned<N>(p)` (C++26, [P2897](https://wg21.link/p2897)) | The matching check | C++26 only; `__cpp_lib_is_sufficiently_aligned` is defined by libstdc++ 16 in C++26 mode |
| `std::align` | Carve an aligned object from a buffer | Mutates its arguments; check the null return |

## Checklist

- [ ] No literal `64` or `128` outside the one constant definition.
- [ ] Every shared struct has block-separation `static_assert`s.
- [ ] Std interference constant appears in asserts only, never in a layout.
- [ ] Runtime alignment assert in constructors of over-aligned types.
- [ ] `perf c2c` run on the contended benchmark shows no HITM on unexpected offsets ([20](20-profiling.md)).
- [ ] Remap function has a bijection test.
- [ ] Hot objects from page-aligned mappings start at varied line offsets.
- [ ] First touch happens on the owning thread, or deliberately at prefault.
