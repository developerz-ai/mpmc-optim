# 🧱 Arenas and allocators

**Rule: a bounded queue allocates once, in its constructor, and never again (I5). Reserve address space eagerly, commit pages lazily, and never let `malloc` decide where a hot byte lives.** Byte placement inside the block is owned by [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md). Lifetime of what is built in the block is owned by [10-raii-and-lifetime.md](10-raii-and-lifetime.md).

As of 2026-11. Linux x86-64 first; other platforms are noted where they differ.

## What allocates, and when

| Memory | Size known | Allocated | Freed | Allocator |
|---|---|---|---|---|
| Ring (slots + sequences) | Construction | Constructor | Destructor | One aligned block or one mapping |
| Segment (unbounded variant) | Construction | Lazily, on first producer overflow | When drained, after reclamation ([06](06-progress-and-reclamation.md)) | Segment pool, then upstream |
| Handle state | Construction | Handle constructor | Handle destructor | Inline in the handle, or caller's allocator |
| User payload behind a pointer | User | Producer thread | **Consumer thread** | User's choice. This is the hard case. |

## Allocator shapes

| Shape | Mechanism | Use when | Do NOT use when | Fails how | Check |
|---|---|---|---|---|---|
| **Monotonic arena** | Bump a pointer; free everything at once | Objects die together: one queue's ring, tables, per-run state | Objects die one by one | Unbounded growth if "reset" never runs | Assert high-water mark at reset |
| **Scratch / frame arena** | Monotonic + `mark`/`rewind` in LIFO order | Per-batch temporaries on one thread | Lifetimes cross threads or interleave | Rewind past a live object: use-after-free with no crash | ASan poison on rewind (below) |
| **Pool** | Fixed-size blocks, free list | One size, churn, e.g. segments or payload nodes | Mixed sizes | Free into the wrong pool; double free corrupts the list | Debug owner tag in block header; ASan poison freed blocks |
| **Slab** | Pool carved from page-aligned slabs with per-slab metadata ([Bonwick 1994](https://www.usenix.org/legacy/publications/library/proceedings/bos94/bonwick.html)) | Pool that must give whole pages back | Tiny counts | Slab pinned forever by one live object | Count partially-full slabs |
| **Intrusive free list** | `next` stored in the free block | Any pool | Block smaller than a pointer | ABA on lock-free pop ([06](06-progress-and-reclamation.md)) | Model check; tagged head |
| **Per-thread magazine** | Thread-local stash of N blocks, exchanged in bulk with a shared depot ([Bonwick & Adams 2001](https://www.usenix.org/legacy/publications/library/proceedings/usenix01/bonwick.html)) | Alloc and free on the same threads | Producer allocates, consumer frees: magazines only ever fill on one side | Memory strands in idle threads; depot lock becomes the hot spot | Count depot exchanges per million ops |
| **Remote-free queue** | Non-owner threads push freed blocks to an MPSC list; owner drains it | Cross-thread free. The MPMC payload case | Same-thread free (plain free list is cheaper) | Owner never allocates again, list grows without bound | Bound it; drain on idle |

## Cross-thread free is the allocator problem of an MPMC payload

A queue of `T*` or `unique_ptr<T>` makes every element **allocated on a producer and freed on a consumer**. Every thread-caching allocator is built for the opposite pattern.

| What goes wrong | Why |
|---|---|
| Unbounded "blowup" | Freed memory piles up in the consumer's cache while the producer keeps asking the OS for more. Named and bounded by [Hoard (Berger et al., ASPLOS 2000)](https://dl.acm.org/doi/10.1145/378993.379232) |
| Shared-list contention | Consumer cache overflows to a central list behind a lock; producer refills from the same lock |
| Line ping-pong | The free block's `next` word and its metadata were last written on the consumer's core; the producer's next `malloc` misses on them |

How general-purpose allocators route a remote free (design claims from each project's own docs):

| Allocator | Remote-free route | Licence | Source |
|---|---|---|---|
| **mimalloc** | Each page has three lists: `free`, a thread-local free list, and a separate list for concurrent frees pushed with one CAS; owner collects it later | MIT | [readme](https://github.com/microsoft/mimalloc), [Leijen, Zorn, de Moura 2019](https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/) |
| **snmalloc** | Message passing: frees are batched and sent back to the owning allocator; the readme claims "1000s of remote deallocations ... with only a single atomic operation" | MIT | [readme](https://github.com/microsoft/snmalloc), [paper](https://github.com/microsoft/snmalloc/blob/main/snmalloc.pdf) |
| **rpmalloc** | "all cross-thread deallocations will be deferred to the owner thread through a separate atomic free list per page" | Unlicense OR MIT | [readme](https://github.com/mjansson/rpmalloc) |
| **tcmalloc** | Block goes to the *freeing* CPU's cache (rseq, no lock); overflow moves batches through the mutex-protected transfer cache | Apache-2.0 | [design doc](https://google.github.io/tcmalloc/design.html) |
| **jemalloc** | Block goes to the freeing thread's tcache; a flush returns it to the owning arena's bins under that arena's locks | BSD-2-Clause | [man page](https://jemalloc.net/jemalloc.3.html) |

As of 2026-11: mimalloc v3 is the recommended line (latest release v3.7.1). jemalloc's repository was archived in 2025-06 and unarchived in 2026-03 ([Meta post](https://engineering.fb.com/2026/03/02/data-infrastructure/investing-in-infrastructure-metas-renewed-commitment-to-jemalloc/)); latest release 5.4.0. tcmalloc ships no tagged releases, track `master`.

**What this library does about it**

| Case | Rule |
|---|---|
| Queue internals | Never free to the general allocator on the hot path. Segments recycle through the queue's own pool |
| Payloads | Prefer moving values through the slot, not pointers. No allocation, no remote free |
| Pointer payloads | Give the user a pool whose `deallocate` is a remote-free push, drained by the producer. Sketch below |

No allocator benchmark is cited on purpose: results swing with workload. Never publish a pointer-payload number without naming the allocator ([19](19-benchmarking.md)); which one to recommend is open ([23](23-open-questions.md)).

### Remote-free list

Many threads push, only the owner takes, and it takes the **whole** list. No single-node pop means no ABA window and no reclamation scheme.

```cpp
// check: run
#include <atomic>
#include <cstddef>
#include <thread>
#include <vector>
struct free_node { free_node* next; };
class remote_free_list {
public:
    // Any thread. Lock-free: a failed CAS means another push succeeded.
    void push(free_node* n) noexcept {
        // relaxed: the value only seeds the CAS, which revalidates it.
        free_node* h = head_.load(std::memory_order_relaxed);
        do {
            n->next = h;  // n is private until the CAS publishes it
        } while (!head_.compare_exchange_weak(
            h, n,
            std::memory_order_release,    // publishes n->next to take_all's acquire
            std::memory_order_relaxed));  // failure: h is only a new seed
    }
    // Owner thread only. Detaches every node pushed so far.
    [[nodiscard]] free_node* take_all() noexcept {
        // acquire: pairs with the release in push, so each node's next is visible.
        return head_.exchange(nullptr, std::memory_order_acquire);
    }
private:
    std::atomic<free_node*> head_{nullptr};
};
int main() {
    constexpr std::size_t threads = 4, per_thread = 5000;
    std::vector<free_node> blocks(threads * per_thread);
    remote_free_list list;
    std::size_t seen = 0;
    {
        std::vector<std::jthread> pushers;
        for (std::size_t t = 0; t < threads; ++t) {
            pushers.emplace_back([&, t] {
                for (std::size_t i = 0; i < per_thread; ++i) {
                    list.push(&blocks[t * per_thread + i]);
                }
            });
        }
        for (int round = 0; round < 100; ++round) {  // owner drains while pushers run
            for (free_node* n = list.take_all(); n != nullptr; n = n->next) ++seen;
        }
    }  // jthreads join here
    for (free_node* n = list.take_all(); n != nullptr; n = n->next) ++seen;
    return seen == blocks.size() ? 0 : 1;
}
```

| Goes wrong | Fix |
|---|---|
| `head_` shares a line with owner-private state | Give it its own destructive-size block ([09](09-cache-friendly-allocation.md)) |
| Adding a single-node `pop` "for convenience" | That is a Treiber stack with ABA. Keep take-all, or read [06](06-progress-and-reclamation.md) |
| Owner stops allocating | List grows forever. Drain on a timer or at `close()` |

## `std::pmr` and its costs

Use `std::pmr` at the **cold boundary** (construction, segment growth). Never on the push or pop path.

| Cost | Detail | Source |
|---|---|---|
| Virtual call per `allocate`/`deallocate` | `memory_resource::do_allocate` is virtual; rarely devirtualised across a `memory_resource*` | [cppreference](https://en.cppreference.com/w/cpp/memory/memory_resource) |
| One pointer per container | `polymorphic_allocator` stores a `memory_resource*`; the stateless `std::allocator` stores nothing | [cppreference](https://en.cppreference.com/w/cpp/memory/polymorphic_allocator) |
| Move assignment may copy | `propagate_on_container_move_assignment` is false: unequal resources force an element-wise move | same |
| `monotonic_buffer_resource` never frees | `deallocate` is a no-op; memory returns only at `release()` or destruction | [cppreference](https://en.cppreference.com/w/cpp/memory/monotonic_buffer_resource) |
| `synchronized_pool_resource` synchronises | Thread-safe by contract, so it pays for it. `unsynchronized_pool_resource` is single-thread only | [cppreference](https://en.cppreference.com/w/cpp/memory/synchronized_pool_resource) |

## Allocator-aware API

Public surface is owned by [04-api.md](04-api.md). Constraints from this doc:

| Rule | Why |
|---|---|
| Queue takes `Allocator = std::allocator<std::byte>` as the last template parameter, plus a pmr alias | Costs nothing by default (`[[no_unique_address]]`, see [11](11-cpp23-craft.md)) |
| Go through `std::allocator_traits`, rebind to the slot type | The only portable route; `std::allocator` honours over-aligned `T` since C++17 |
| One `allocate` in the constructor, one `deallocate` in the destructor | I5. Verified by the zero-allocation test below |
| A `from_storage(std::span<std::byte>)` constructor that adopts caller memory | Lets users supply a mapping, huge pages, shared memory or a static buffer without an allocator type |

## Lazy allocation

Vision goal 5: reserve eagerly, commit on touch, opt-in prefault. Virtual address space is nearly free on 64-bit; physical pages are not.

| Step | Call | Effect | Source |
|---|---|---|---|
| Reserve | `mmap(nullptr, n, PROT_NONE, MAP_PRIVATE\|MAP_ANONYMOUS\|MAP_NORESERVE, -1, 0)` | Address range only. A read-only or inaccessible private mapping has zero commit charge | [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html), [overcommit accounting](https://docs.kernel.org/mm/overcommit-accounting.html) |
| Commit | `mprotect(p, n, PROT_READ\|PROT_WRITE)` | Range becomes usable and is charged ("We account mprotect changes in commit"). Still no physical page | same |
| Touch | First write to each page | Minor page fault; kernel zeroes and maps one page | |
| Prefault | `madvise(p, n, MADV_POPULATE_WRITE)` (Linux 5.14) | Faults pages in writable without touching them; returns an error instead of raising `SIGBUS` | [madvise(2)](https://man7.org/linux/man-pages/man2/madvise.2.html) |
| Prefault, old way | `MAP_POPULATE` at `mmap` time | Same intent, but "The mmap() call doesn't fail if the mapping cannot be populated" | [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html) |
| Pin | `mlock(p, n)` | Faults in and forbids swap-out. `MAP_LOCKED` is weaker: population can fail silently | [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html) |
| Decommit now | `madvise(p, n, MADV_DONTNEED)` | Pages dropped, RSS falls immediately, next touch is a zero-fill fault | [madvise(2)](https://man7.org/linux/man-pages/man2/madvise.2.html) |
| Decommit lazily | `madvise(p, n, MADV_FREE)` (Linux 4.5) | Kernel may free under memory pressure; a write before that cancels it. Private anonymous only | same |
| Release | `munmap(p, n)` | Range gone | |

`MADV_WILLNEED` is read-ahead advice. Do not rely on it to prefault anonymous memory; use `MADV_POPULATE_WRITE`.

### Pitfalls experts hit

| Pitfall | Detail | Check |
|---|---|---|
| **Initialising sequences commits the whole ring** | A Vyukov-style ring writes `seq[i] = i` to every slot in the constructor. That touches every page, so "lazy" is a lie | Choose a sequence encoding where **all-zero bytes mean "empty, lap 0"**. Fresh anonymous pages are zero-filled. Owned by [03-algorithms.md](03-algorithms.md); lifetime rules for zero-filled storage in [10](10-raii-and-lifetime.md#objects-in-zero-filled-or-mapped-memory) |
| `MAP_NORESERVE` is a hint | "In mode 2 the MAP_NORESERVE flag is ignored"; the man page says there are "no guarantees" | Reserve with `PROT_NONE`, which is uncharged in every mode |
| Commit fails late | Under `vm.overcommit_memory=2`, `mprotect` to writable returns `ENOMEM`. Under modes 0 and 1 the failure arrives as the OOM killer at touch time | Check every `mprotect`; offer prefault for users who need failure at construction |
| First-touch latency on the hot path | A producer that crosses into an untouched page takes a fault inside `push` | Tail benchmark with and without prefault ([19](19-benchmarking.md)); count with `perf stat -e page-faults` |
| `MADV_DONTNEED` then immediate reuse | Pay a syscall, a TLB shootdown to every core that mapped it, and a fresh fault | Decommit only on long idle, with hysteresis |

Page-fault cost in nanoseconds is not quoted: it depends on kernel, page size, cgroup and zeroing. Measure on the target ([19](19-benchmarking.md)).

### Lazy at three levels

| Level | Lazy means | Cost when it fires |
|---|---|---|
| Pages | Ring reserved, pages faulted by first lap | One minor fault per page, once |
| Segments | Unbounded variant creates the next segment only when a producer overflows | Allocation on a push path. Bound it: keep one spare segment so the fast path never waits on the allocator |
| Slot elements | `T` is constructed at push, destroyed at pop; the ring never default-constructs `T` | None. This is also why `T` need not be default-constructible |

### Huge pages

| Option | How | Gain | Cost | Fails how |
|---|---|---|---|---|
| **THP, `madvise` mode** | Align the mapping to 2 MiB, `madvise(p, n, MADV_HUGEPAGE)` | Fewer TLB entries for the ring ([09](09-cache-friendly-allocation.md#tlb-reach)) | "larger clear-page copy-page in page faults"; RSS grows in 2 MiB steps | Silent fallback to 4 KiB. Read `thp_fault_fallback` in `/proc/vmstat` and `AnonHugePages` in `/proc/<pid>/smaps` |
| THP, synchronous | `madvise(p, n, MADV_COLLAPSE)` (Linux 6.1) after prefault | Collapse now, at a time you choose, not when khugepaged gets round to it | Blocks the caller; best effort | `EBUSY`/`ENOMEM`: check the return value |
| **hugetlbfs** | `mmap(..., MAP_HUGETLB \| MAP_HUGE_2MB \| ...)` | Guaranteed huge pages from a reserved pool, never swapped | Needs `vm.nr_hugepages` set by an admin; length must be a multiple of the huge page size | `mmap` fails when the pool is empty. Fall back to THP and log it |

Sources: [THP admin guide](https://docs.kernel.org/admin-guide/mm/transhuge.html), [hugetlbpage](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html), [mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html).

- THP `defrag` setting decides whether a fault **stalls** for compaction. `always`: "will stall on allocation failure and directly reclaim pages and compact memory". Latency-critical users prefault at startup or set `defer`.
- "the mmap region has to be hugepage naturally aligned". An unaligned 2 MiB ring gets zero huge pages.
- THP and lazy commit pull in opposite directions: one touch commits 2 MiB. Offer THP only with prefault.

### A growable virtual-memory arena

Single owner thread. Reserves once, commits in 2 MiB steps, bumps, rewinds with RAII marks, poisons what is not handed out.

```cpp
// check: run
#include <cstddef>
#include <cstdint>
#include <new>
#if defined(__linux__)
#include <sys/mman.h>
#if __has_include(<sanitizer/asan_interface.h>)
#include <sanitizer/asan_interface.h>  // macros expand to nothing without ASan
#else
#define ASAN_POISON_MEMORY_REGION(p, n) ((void)(p), (void)(n))
#define ASAN_UNPOISON_MEMORY_REGION(p, n) ((void)(p), (void)(n))
#endif
class vm_arena {
public:
    struct mark { std::size_t top; };
    explicit vm_arena(std::size_t reserve_bytes) : cap_(round_up(reserve_bytes, commit_step)) {
        void* p = ::mmap(nullptr, cap_, PROT_NONE,
                         MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
        if (p == MAP_FAILED) throw std::bad_alloc{};
        base_ = static_cast<std::byte*>(p);
    }
    ~vm_arena() {
        ASAN_UNPOISON_MEMORY_REGION(base_, committed_);
        ::munmap(base_, cap_);
    }
    vm_arena(const vm_arena&) = delete;
    vm_arena& operator=(const vm_arena&) = delete;
    // nullptr when the reservation is exhausted or the kernel refuses the commit.
    [[nodiscard]] void* allocate(std::size_t bytes, std::size_t align) noexcept {
        const auto addr = reinterpret_cast<std::uintptr_t>(base_) + top_;
        const std::size_t start = top_ + ((std::uintptr_t{0} - addr) & (align - 1));
        if (start > cap_ || bytes > cap_ - start) return nullptr;
        const std::size_t end = start + bytes;
        if (end > committed_ && !commit(end)) return nullptr;
        ASAN_UNPOISON_MEMORY_REGION(base_ + start, bytes);
        top_ = end;
        return base_ + start;
    }
    [[nodiscard]] mark save() const noexcept { return {top_}; }
    void rewind(mark m) noexcept {
        ASAN_POISON_MEMORY_REGION(base_ + m.top, top_ - m.top);
        top_ = m.top;
    }
    // Give physical pages above the high-water mark back. Address range stays reserved.
    void decommit_unused() noexcept {
        const std::size_t keep = round_up(top_, commit_step);
        if (keep >= committed_) return;
        // Syscalls are not instrumented accesses: poisoned ranges are fine here.
        (void)::madvise(base_ + keep, committed_ - keep, MADV_DONTNEED);
        (void)::mprotect(base_ + keep, committed_ - keep, PROT_NONE);  // drops the commit charge
        committed_ = keep;
    }
    [[nodiscard]] std::size_t used() const noexcept { return top_; }
    [[nodiscard]] std::size_t committed() const noexcept { return committed_; }

private:
    static constexpr std::size_t commit_step = std::size_t{1} << 21;  // 2 MiB
    static constexpr std::size_t round_up(std::size_t n, std::size_t to) noexcept {
        return (n + to - 1) & ~(to - 1);
    }
    bool commit(std::size_t end) noexcept {
        const std::size_t want = round_up(end, commit_step);  // cap_ is a multiple of the step
        if (::mprotect(base_ + committed_, want - committed_, PROT_READ | PROT_WRITE) != 0) {
            return false;  // ENOMEM under strict overcommit
        }
        ASAN_POISON_MEMORY_REGION(base_ + committed_, want - committed_);
        committed_ = want;
        return true;
    }
    std::size_t cap_;
    std::byte* base_ = nullptr;
    std::size_t top_ = 0;
    std::size_t committed_ = 0;
};
// RAII mark: everything allocated inside the scope is released at scope exit.
class scratch_scope {
public:
    explicit scratch_scope(vm_arena& a) noexcept : arena_(a), mark_(a.save()) {}
    ~scratch_scope() { arena_.rewind(mark_); }
    scratch_scope(const scratch_scope&) = delete;
    scratch_scope& operator=(const scratch_scope&) = delete;
private:
    vm_arena& arena_;
    vm_arena::mark mark_;
};
int main() {
    vm_arena arena(std::size_t{1} << 30);  // 1 GiB of address space, no memory yet
    if (arena.committed() != 0) return 1;
    auto* a = static_cast<std::uint64_t*>(arena.allocate(sizeof(std::uint64_t), alignof(std::uint64_t)));
    if (a == nullptr || *a != 0 || arena.committed() != (std::size_t{1} << 21)) return 2;

    const std::size_t before = arena.used();
    {
        scratch_scope scope(arena);
        auto* big = static_cast<std::byte*>(arena.allocate(std::size_t{3} << 20, 64));
        if (big == nullptr || big[0] != std::byte{0}) return 3;  // fresh pages are zero
        big[(std::size_t{3} << 20) - 1] = std::byte{1};
    }
    if (arena.used() != before) return 4;
    arena.decommit_unused();
    if (arena.committed() != (std::size_t{1} << 21)) return 5;
    if (arena.allocate(std::size_t{2} << 30, 8) != nullptr) return 6;  // beyond the reservation
    return 0;
}
#else
int main() { return 0; }  // POSIX mmap only; Windows uses VirtualAlloc MEM_RESERVE / MEM_COMMIT
#endif
```

| Goes wrong | Fix |
|---|---|
| `align` not a power of two | The mask arithmetic silently returns misaligned memory. Assert `std::has_single_bit(align)` at the boundary |
| Rewinding a mark from another scope out of order | LIFO only. In debug, store a depth counter in the mark and assert it |
| Pointers kept across `decommit_unused()` | Anything above the high-water mark is gone and reads fault |

## Teaching the checkers about arenas

Without annotations an arena is one big valid block: every overrun and use-after-rewind inside it is invisible to ASan and Memcheck. Tool limits are owned by [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md).

| Tool | Call | When | Source |
|---|---|---|---|
| ASan | `ASAN_POISON_MEMORY_REGION(p, n)` | On commit, rewind, pool free | [manual poisoning](https://github.com/google/sanitizers/wiki/AddressSanitizerManualPoisoning) |
| ASan | `ASAN_UNPOISON_MEMORY_REGION(p, n)` | On allocate; before `munmap` or handing memory back to `free` | same |
| Memcheck | `VALGRIND_MAKE_MEM_NOACCESS / _UNDEFINED / _DEFINED(p, n)` | Same points; `UNDEFINED` on allocate catches reads of stale bytes | [Memcheck manual](https://valgrind.org/docs/manual/mc-manual.html) |
| Memcheck | `VALGRIND_CREATE_MEMPOOL(pool, rzB, is_zeroed)`, `VALGRIND_MEMPOOL_ALLOC(pool, p, n)`, `VALGRIND_MEMPOOL_FREE(pool, p)`, `VALGRIND_DESTROY_MEMPOOL(pool)` | Pools and slabs: gives per-block leak reports and double-free detection | same, section "Memory Pools" |

| Pitfall | Detail |
|---|---|
| ASan granularity | Shadow is 8-byte. Poisoning "may poison only subregion", unpoisoning "may unpoison a superregion". Align blocks to 8 and leave an 8-byte red zone or small overruns pass |
| Poisoning is not thread-safe per region | Two threads must not (un)poison the same region at once. Fine for single-owner arenas; for pools, poison under the same exclusion that guards the block |

## Proving zero allocations on the hot path

I5 is a test, not a comment. Use at least one in-process method (runs in CI on every commit) and one out-of-process method (catches `malloc` called behind your back by libc or a dependency).

| Method | Catches | Misses | Command or hook |
|---|---|---|---|
| Replace global `operator new`, abort inside a guarded scope | Any C++ allocation on the guarded thread | Direct `malloc`, `mmap` | Snippet below |
| RealtimeSanitizer | `malloc`, `free`, locks, syscalls inside `[[clang::nonblocking]]` functions, at run time | Paths not executed | `clang++ -fsanitize=realtime` ([docs](https://clang.llvm.org/docs/RealtimeSanitizer.html)); verified on Clang 22 |
| Function effect analysis | Calls from `[[clang::nonblocking]]` / `[[clang::nonallocating]]` code to unannotated functions, at compile time | Anything outside the annotated call tree | `-Wfunction-effects` ([docs](https://clang.llvm.org/docs/FunctionEffectAnalysis.html)); verified on Clang 22 |
| Count libc entries | Every `malloc` in the process, with stacks | Nothing in user space | `bpftrace -e 'uprobe:libc:malloc /pid == $1/ { @[ustack] = count(); }'` |
| Count memory syscalls | `mmap`, `brk`, `munmap` in the measured window | Allocation served from a cache | `perf stat -e 'syscalls:sys_enter_mmap,syscalls:sys_enter_brk' -p <pid>` |
| Count page faults | Lazy commit firing on the hot path | Nothing | `getrusage(RUSAGE_THREAD)` `ru_minflt` before and after; `perf stat -e page-faults` |

Pass criterion: counters are **exactly equal** before and after N million operations in steady state, after one warm-up lap that touches every page.

```cpp
// check: run
#include <atomic>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>
namespace {
std::atomic<std::size_t> g_allocations{0};
thread_local bool t_forbid = false;
}  // namespace

// Covers new and new[]. Production test: also replace the std::align_val_t overloads.
void* operator new(std::size_t n) {
    g_allocations.fetch_add(1, std::memory_order_relaxed);  // statistic only, no ordering edge
    if (t_forbid) {
        std::fputs("allocation inside no_alloc_scope\n", stderr);
        std::abort();
    }
    if (void* p = std::malloc(n != 0 ? n : 1)) return p;
    throw std::bad_alloc{};
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
class no_alloc_scope {
public:
    no_alloc_scope() noexcept : previous_(t_forbid) { t_forbid = true; }
    ~no_alloc_scope() { t_forbid = previous_; }
    no_alloc_scope(const no_alloc_scope&) = delete;
    no_alloc_scope& operator=(const no_alloc_scope&) = delete;
private:
    bool previous_;
};
int main() {
    std::vector<int> ring;
    ring.reserve(1024);  // the one allowed allocation, at construction
    const std::size_t before = g_allocations.load(std::memory_order_relaxed);
    {
        no_alloc_scope guard;
        for (int i = 0; i < 1024; ++i) ring.push_back(i);  // stands in for push/pop
    }
    const std::size_t after = g_allocations.load(std::memory_order_relaxed);
    return after == before ? 0 : 1;
}
```

| Goes wrong | Fix |
|---|---|
| Only the scalar `operator new` replaced | Over-aligned `new` uses separate replaceable functions; replace both families |
| Clang + `-fsanitize=thread` | Link fails: the static TSan runtime defines the same operators (seen on Clang 22). Run this test in the plain and ASan configurations |
