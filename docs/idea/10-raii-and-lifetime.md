# ♻️ RAII and lifetime

**Rule: every resource has exactly one owner whose destructor releases it, and every byte of slot storage is in a known state: no object, or one live `T`.** Memory acquisition is owned by [08-arenas-and-allocators.md](08-arenas-and-allocators.md). The slot protocol is owned by [03-algorithms.md](03-algorithms.md). Public signatures are owned by [04-api.md](04-api.md).

As of 2026-11.

## Owners

| Resource | Owner | Releases | Copy / move |
|---|---|---|---|
| Ring memory | Queue | Destructor: drain, then deallocate | Neither. Other threads hold its address |
| Mapping (`mmap`) | `vm_arena`-style class ([08](08-arenas-and-allocators.md#a-growable-virtual-memory-arena)) | `munmap` | Move only |
| Element in a slot | The slot protocol, by sequence | `pop`, or the queue destructor (I6) | n/a |
| Handle | The thread that made it | Destructor unregisters | Move only; never shared between threads |
| Claimed slot | Claim guard, for the duration of one push or pop | Commit, or the failure path below | Neither |
| Scratch memory | `scratch_scope` mark | Rewind | Neither |
| Worker thread, affinity | `std::jthread` plus a guard that restores the previous mask | Join; restore | Move only |

| Rule | Why |
|---|---|
| Rule of zero for anything built from owners | Compiler-generated members are correct and stay correct |
| Rule of five, with copy and move `= delete`, for the queue | A concurrent object cannot be moved while another thread can see it |
| Declare the queue **before** the threads that use it | Members are destroyed in reverse order: threads join first, then the queue dies |
| Destructors are `noexcept` and do not block on other threads' progress | A destructor that waits for a producer can deadlock shutdown |

## Objects in raw storage

| Tool | Does | Use for |
|---|---|---|
| `union { T value; }` member | Storage with correct size and alignment, no automatic construction or destruction | Slot storage. Preferred over `std::byte[]`: no `reinterpret_cast`, no `std::launder` |
| `std::construct_at(p, args...)` | Starts a `T` lifetime | Push |
| `std::destroy_at(p)` | Ends it | Pop, drain |
| `std::launder(p)` | Gets a usable pointer to an object created in storage you only hold as another type | Needed with `alignas(T) std::byte storage[sizeof(T)]` (rigtorp/MPMCQueue does exactly this); not needed with the union |
| Implicit-lifetime types ([P0593R6](https://wg21.link/p0593r6)) | `malloc`, `memcpy`, `memmove` and byte-array creation start their lifetime implicitly | Trivial payloads, sequence words stored as plain integers |
| `std::start_lifetime_as_array<T>(p, n)` ([P2590R2](https://wg21.link/p2590r2)) | Starts lifetimes over existing bytes, keeping the bytes | Mapped or zero-filled memory |

### Objects in zero-filled or mapped memory

The lazy ring ([08](08-arenas-and-allocators.md#lazy-allocation)) must not write every sequence word at construction. Checked here:

| Fact | Evidence |
|---|---|
| `std::atomic<std::uint64_t>` is **not** implicit-lifetime | `std::is_implicit_lifetime_v` is false on GCC 16 and Clang 22 (its default constructor is not trivial since C++20) |
| `std::uint64_t` is | same check, true |
| `std::start_lifetime_as` is in libstdc++ 16, absent from libc++ 22 | `__cpp_lib_start_lifetime_as` |

So for untouched zero pages: store sequences as `std::uint64_t`, start their lifetime with `start_lifetime_as_array` where available, and access them only through `std::atomic_ref`. Every access must go through `atomic_ref`, and the storage must satisfy `atomic_ref<T>::required_alignment`. The portable fallback `std::memmove(p, p, n)` is formally correct but at `-O0` it reads and writes every page: it defeats laziness. Whether to pay that or require libstdc++ 16 is an open question.

### Trivial relocation: not in C++26

[P2786](https://wg21.link/p2786) was adopted in 2025-02 and **removed** from the C++26 draft in 2025-11 ([P3920R0](https://www.open-std.org/JTC1/sc22/wg21/docs/papers/2025/p3920r0.html)); the competing design is [P1144](https://wg21.link/p1144).

- Clang 22 still defines `__cpp_trivial_relocatability`. Do not key code off that macro.
- `memcpy` of slots is legal only for `std::is_trivially_copyable` types. Gate batch fast paths on that.
- A user opt-in trait for "relocatable but not trivially copyable" types is formally UB today. Offer it only as a documented, off-by-default extension.

## When the constructor throws after the claim

In a ticket-based ring a claimed ticket cannot be handed back: consumers will wait on that slot forever.

| Option | Cost | Verdict |
|---|---|---|
| In-place `emplace` only when `std::is_nothrow_constructible_v<T, Args...>` | None | Default fast path |
| Otherwise build a temporary **before** claiming, then nothrow-move it in | One move | Default slow path |
| Require `std::is_nothrow_move_constructible_v<T>` and `is_nothrow_destructible_v<T>` for the queue | Rejects a few types at compile time | Yes: pop and drain rely on it |
| Publish a tombstone that consumers skip | A branch on every pop | Only if a use case demands throwing in-place construction |
| `noexcept` and let it terminate | Surprise | No |

Pop side: return by value through a nothrow move, or call a user function on `T&` in the slot and destroy afterwards. The second form supports non-movable types and must mark the slot free even if the function throws: a guard destroys the element and publishes the sequence.

```cpp
// check: run
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <type_traits>
#include <utility>

template <class T>
class slot_storage {
public:
    slot_storage() noexcept {}
    ~slot_storage() {}  // owner destroys the element; the slot does not know if one is live
    template <class... Args>
    void construct(Args&&... args) noexcept(std::is_nothrow_constructible_v<T, Args...>) {
        std::construct_at(std::addressof(value_), std::forward<Args>(args)...);
    }
    T& get() noexcept { return value_; }
    void destroy() noexcept { std::destroy_at(std::addressof(value_)); }
private:
    union { T value_; };
};

struct tiny_ring {  // single-threaded stand-in: shows lifetime, not the concurrent protocol
    static constexpr std::size_t capacity = 4;
    slot_storage<struct tracked> *slots;
    std::size_t tail = 0, head = 0;
};

struct tracked {
    static inline int live = 0;
    explicit tracked(int v) : value(v) {
        if (v < 0) throw std::invalid_argument("negative");
        ++live;
    }
    tracked(tracked&& o) noexcept : value(o.value) { ++live; }
    ~tracked() { --live; }
    int value;
};

template <class... Args>
bool emplace(tiny_ring& r, Args&&... args) {
    static_assert(std::is_nothrow_move_constructible_v<tracked>);
    if (r.tail - r.head == tiny_ring::capacity) return false;
    if constexpr (std::is_nothrow_constructible_v<tracked, Args...>) {
        r.slots[r.tail++ % tiny_ring::capacity].construct(std::forward<Args>(args)...);
    } else {
        tracked tmp(std::forward<Args>(args)...);  // may throw: nothing is claimed yet
        r.slots[r.tail++ % tiny_ring::capacity].construct(std::move(tmp));
    }
    return true;
}

int main() {
    slot_storage<tracked> storage[tiny_ring::capacity];
    tiny_ring ring{storage};
    bool threw = false;
    emplace(ring, 1);
    try {
        emplace(ring, -1);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    if (!threw || ring.tail != 1 || tracked::live != 1) return 1;  // no ticket lost, no leak
    while (ring.head != ring.tail) storage[ring.head++ % tiny_ring::capacity].destroy();  // I6
    return tracked::live == 0 ? 0 : 2;
}
```

## Close, drain, destroy

A queue cannot protect itself against its own destruction. The caller must guarantee quiescence; the API makes that easy to do right.

| Step | Who | What |
|---|---|---|
| 1. `close()` | Any thread | Set the closed state; wake every waiter ([07](07-waiting.md)) |
| 2. Producers | Each | `push` fails with "closed"; they stop |
| 3. Consumers | Each | Pop until "empty and closed"; they stop |
| 4. Join | Owner | Every thread that held a handle has returned |
| 5. Destructor | Owner, alone | Destroy each remaining element exactly once (I6), free memory |

| Race | Mechanism | Rule |
|---|---|---|
| Last-touch | A consumer receives the final item and destroys the queue while the producer's `push` is still running its post-publish steps (wake, stats) on freed memory | Destroy only after join, never on "I got the last message" |
| Sleeping waiter | Thread parked on a queue that is destroyed | `close()` wakes all; destructor asserts zero waiters in debug |
| Handle outlives queue | Handle destructor touches freed memory | Debug count of live handles, asserted in the queue destructor |
| Drain skips or double-destroys | Destructor walks by `size_approx()` (I7 forbids this) | Walk by each slot's sequence state |
| `shared_ptr<queue>` as a fix | Solves memory lifetime, hides the protocol error, adds a contended refcount | Use it at the edges only, never per operation |

## Scope guards and tagging

- `std::experimental::scope_exit` and `unique_resource` (Library Fundamentals TS v3) ship in libstdc++ (`<experimental/scope>`, compiles on GCC 16) and are absent from libc++ 22. Not in C++23 or C++26. The library carries its own small guard.
- Guards must be `[[nodiscard]]`, non-copyable, and their function must not throw.

```cpp
// check: compile
#include <cstdint>
#include <type_traits>
#include <utility>

template <class F>
class [[nodiscard]] scope_exit {
public:
    explicit scope_exit(F f) noexcept(std::is_nothrow_move_constructible_v<F>) : f_(std::move(f)) {}
    ~scope_exit() { if (armed_) f_(); }
    void release() noexcept { armed_ = false; }
    scope_exit(const scope_exit&) = delete;
    scope_exit& operator=(const scope_exit&) = delete;
private:
    F f_;
    bool armed_ = true;
};

// Low-bit tag in an aligned pointer. Only bits below the alignment are free.
template <class T, unsigned Bits>
class tagged_ptr {
    static_assert((std::uintptr_t{1} << Bits) <= alignof(T), "not enough alignment bits");
    static constexpr std::uintptr_t mask = (std::uintptr_t{1} << Bits) - 1;
public:
    tagged_ptr(T* p, std::uintptr_t tag) noexcept : bits_(reinterpret_cast<std::uintptr_t>(p) | (tag & mask)) {}
    T* ptr() const noexcept { return reinterpret_cast<T*>(bits_ & ~mask); }
    std::uintptr_t tag() const noexcept { return bits_ & mask; }
private:
    std::uintptr_t bits_;
};

struct alignas(8) node { int v; };
static_assert(sizeof(tagged_ptr<node, 3>) == sizeof(void*));
int main() {
    node n{1};
    scope_exit guard([&] { n.v = 0; });
    return tagged_ptr<node, 3>(&n, 5).tag() == 5 && tagged_ptr<node, 3>(&n, 5).ptr() == &n ? 0 : 1;
}
```

| Tagging trap | Rule |
|---|---|
| Using high pointer bits | Not free in general: 5-level paging and pointer-tagging CPU features use them. Low bits only |
| Tag wider than alignment | `static_assert` as above |
| Closed flag in the ticket counter | Fine, but it shrinks the 64-bit ticket space; document the bit and keep wrap impossible |
