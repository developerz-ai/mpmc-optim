# 🛠️ C++23 craft

**Rule: every abstraction resolves at compile time, every fast path is selected by a trait, every assumption is either checked or absent.** Build flags are owned by [21-build-and-toolchain.md](21-build-and-toolchain.md); the UB budget by [18-hardening.md](18-hardening.md); atomics by [05-memory-model.md](05-memory-model.md).

As of 2026-11. Toolchain facts below were checked on GCC 16 and Clang 22.

## Toolbox

| Technique | Use when | Do NOT use when | Goes wrong | Check |
|---|---|---|---|---|
| **Concepts / `requires`** | Constraining `T`, policies, callables at the API boundary | Internal helpers with one caller | Constraint looser than the body: error surfaces deep inside | `static_assert(!std::is_invocable...)` negative tests |
| **Policy types** (wait, allocator, remap) as template parameters | Behaviour varies per queue and must inline | Behaviour varies per call (use an argument) | Combinatorial instantiations nobody tests | CI builds every supported combination |
| **`[[no_unique_address]]`** | Storing empty policies and allocators | MSVC ABI: needs `[[msvc::no_unique_address]]` | Two empty members of the same type still get distinct addresses | `static_assert(sizeof(...))` |
| **Deducing `this`** ([P0847](https://wg21.link/p0847)) | One body for const and non-const; mixins without CRTP casts | Hot code on compilers you have not tested | Derived object deduced where base was intended | Constrain the explicit object parameter |
| **CRTP** | Static polymorphism needing the derived type at class scope | Deducing `this` suffices | Wrong derived type passed: silent UB cast | Private constructor + `friend Derived` |
| **`if consteval`** | Different algorithm at compile time (no intrinsics) | To hide behaviour differences | Compile-time and run-time paths diverge | Test both: `static_assert` and a runtime test of the same inputs |
| **`constexpr` tests** | Index math, remap, capacity rounding | Anything with atomics in C++23 | UB in a constant expression is a compile error, which is the point | `static_assert` next to the function |
| **`[[assume(expr)]]`** | A proven invariant the optimiser cannot see, with a measured win | Anything derived from user input or another thread | False assumption is UB that deletes your checks | Same expression as a debug assert first |
| **`std::unreachable()`** | After an exhaustive switch | "Should not happen" | UB when reached | Debug builds trap instead |
| **`std::expected<T, E>`** | Construction and configuration errors | Push and pop results: a `bool` or small enum is cheaper | Ignored result | `[[nodiscard]]` on the function |
| **`std::span`** | Batch push/pop, adopting caller storage | Owning anything | Dangling | Never store a span beyond the call |
| **Traits pick fast paths** | `is_trivially_copyable` to `memcpy` batches; `is_trivially_destructible` to skip drain; `is_nothrow_*` to emplace in place | Guessing ("it is probably trivial") | Wrong trait: `is_trivial` is not `is_trivially_copyable` | `static_assert` per benchmark payload |
| **`noexcept`** | Push, pop, destructors, moves. Conditional `noexcept(...)` on templates | A function that can throw: it becomes `std::terminate` | Unconditional `noexcept` on a template that calls user code | `static_assert(noexcept(q.try_push(x)))` |
| **`[[likely]]` / `[[unlikely]]`** | Full, empty and closed branches without PGO | PGO builds: profile data should decide ([21](21-build-and-toolchain.md)) | Wrong hint pessimises layout | Compare with and without |
| **cold / `noinline`** (`[[gnu::cold]]`, `[[gnu::noinline]]`) | Slow paths: park, grow, error reporting | Tiny functions | Hot path bloats when the slow path inlines | Inspect the hot function's size |
| **`always_inline`** | A measured case where the inliner refuses | By default | Code bloat, worse i-cache | Benchmark both |
| **`std::bit_cast`** | Type punning of trivially copyable values | Pointers that will be dereferenced | Reading through a `reinterpret_cast` pointer of another type breaks strict aliasing | `-fsanitize=undefined` does not catch aliasing: review instead |
| **`__restrict__`** | Batch copy loops proven not to overlap | Any public signature (non-standard extension) | Overlap is UB | Debug overlap assert |
| **`final`** on classes with virtuals | Lets calls devirtualise | The hot path: it has no virtual calls at all | | No `call *` in the hot function's disassembly |
| **Small buffer / type erasure** | Cold callbacks | Hot path: `std::function` may allocate (I5) | Hidden allocation | Zero-allocation test ([08](08-arenas-and-allocators.md#proving-zero-allocations-on-the-hot-path)) |

## Policies, concepts, empty members

```cpp
// check: compile
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <type_traits>
#include <utility>

template <class T>
concept queue_element = std::is_nothrow_move_constructible_v<T> && std::is_nothrow_destructible_v<T>;

template <class W>
concept wait_policy = std::is_nothrow_default_constructible_v<W> && requires(W w, unsigned spins) {
    { w.pause(spins) } noexcept -> std::same_as<void>;
};

struct spin_wait {
    void pause(unsigned) const noexcept {}
};

template <queue_element T, wait_policy Wait = spin_wait, class Alloc = std::allocator<std::byte>>
class queue {
public:
    // Deducing this: one body serves const and non-const callers.
    template <class Self>
    [[nodiscard]] auto&& allocator(this Self&& self) noexcept { return std::forward<Self>(self).alloc_; }

    // Trait-selected paths, resolved at compile time.
    static constexpr bool memcpy_batches = std::is_trivially_copyable_v<T>;
    static constexpr bool drain_needed = !std::is_trivially_destructible_v<T>;

private:
    std::uint64_t mask_ = 0;
    [[no_unique_address]] Wait wait_{};
    [[no_unique_address]] Alloc alloc_{};
};

struct throwing_move {
    throwing_move(throwing_move&&) {}
};

static_assert(queue_element<int>);
static_assert(!queue_element<throwing_move>);  // negative test: the constraint really rejects
static_assert(!wait_policy<int>);
static_assert(sizeof(queue<int>) == sizeof(std::uint64_t));  // empty policies cost nothing
static_assert(queue<int>::memcpy_batches && !queue<int>::drain_needed);
int main() {}
```

## Compile-time tests and assumptions

```cpp
// check: compile
#include <bit>
#include <cstdint>
#include <utility>

#if defined(NDEBUG)
#define MPMC_ASSUME(x) [[assume(x)]]
#else
#define MPMC_ASSUME(x) ((x) ? void(0) : std::unreachable())  // debug: pair with a trapping assert in real code
#endif

constexpr std::uint64_t round_up_pow2(std::uint64_t n) noexcept { return std::bit_ceil(n); }

constexpr std::uint64_t index_of(std::uint64_t ticket, std::uint64_t capacity) noexcept {
    MPMC_ASSUME(std::has_single_bit(capacity));  // lets the compiler keep the mask form
    return ticket & (capacity - 1);
}

constexpr std::uint64_t lap_of(std::uint64_t ticket, std::uint64_t capacity) noexcept {
    if consteval {
        return ticket / capacity;  // simple form for the constant evaluator
    } else {
        return ticket >> std::countr_zero(capacity);
    }
}

static_assert(round_up_pow2(1000) == 1024);
static_assert(index_of(1025, 1024) == 1);
static_assert(lap_of(4096, 1024) == 4);
static_assert(index_of(~std::uint64_t{0}, 1024) == 1023);  // tickets are 64-bit; wrap of the index is fine
int main() { return lap_of(4096, 1024) == 4 ? 0 : 1; }
```

## Asserts and contracts

| Level | Macro (proposed) | On in | For |
|---|---|---|---|
| Precondition at the API boundary | `MPMC_EXPECTS` | Debug and hardened release | Capacity, alignment, handle ownership |
| Internal invariant | `MPMC_ASSERT` | Debug | Sequence state, lifetime state |
| Expensive audit | `MPMC_AUDIT` | Opt-in | Whole-ring walks |

- An assert MUST NOT change layout or behaviour: a member that exists only under `!NDEBUG` in a header-only library is an ODR violation between TUs built differently.
- An assert MUST NOT read a slot outside its window (I4), even to "just check".
- **Contracts** ([P2900](https://wg21.link/p2900)) are in the C++26 draft: `pre`, `post`, `contract_assert`. Technical work on C++26 finished in 2026-03 and the committee voted to keep contracts again in 2026-11 ([Sutter trip reports](https://herbsutter.com/category/c/)); ISO publication is pending. GCC 16 accepts them with `-fcontracts`; Clang 22 has no such flag. Use the macros now, map them to contracts later.

## Headers, ABI, build cost

| Rule | Why |
|---|---|
| Every header compiles alone | CI compiles each header as its own TU |
| Include what you use | Transitive includes differ between libstdc++ and libc++ |
| Macros: `MPMC_` prefix, defined in one config header, none in the public interface | Macros ignore namespaces |
| Any macro that changes layout or behaviour must be identical in every TU | ODR. Includes the destructive-size override ([09](09-cache-friendly-allocation.md#do-not-put-the-std-constant-in-a-layout)) |
| Version the ABI with an inline namespace (`mpmc::v1`) | Mixed versions fail at link time, not at run time |
| No `using namespace` and no anonymous namespace in headers | The second gives each TU its own entity |
| Keep `<iostream>`, `<regex>`, `<functional>` out of the core header | Compile time; measure with `-ftime-report` (GCC) or `-ftime-trace` (Clang) |
| Explicit `memory_order` on every atomic call | CLAUDE.md preventive rule |
| Modules: ship headers; a module wrapper is optional | CMake documents `import std` as experimental through 4.4 ([cmake-cxxmodules](https://cmake.org/cmake/help/latest/manual/cmake-cxxmodules.7.html)); libc++ says its module build support is experimental ([Modules in libc++](https://libcxx.llvm.org/Modules.html)) |

## Naming and errors

| Thing | Convention |
|---|---|
| Non-blocking operations | `try_push`, `try_pop`: return at once |
| Blocking operations | `push`, `pop`: may wait ([07](07-waiting.md)) |
| Hints | `_approx` suffix (I7) |
| Results | `bool` or a small enum (`ok`, `full`, `empty`, `closed`), always `[[nodiscard]]` |
| Exceptions | Construction only (`bad_alloc`, invalid capacity). Never from push or pop |
| Words | Vocabulary from [01-vision.md](01-vision.md). "Lock-free" only with a proof |

## Hygiene checklist

- [ ] Compiles warning-free with `-Wall -Wextra -Wpedantic -Wconversion` on GCC and Clang.
- [ ] Each concept has a negative `static_assert`.
- [ ] Each `noexcept` promise has a `static_assert(noexcept(...))`.
- [ ] Each `[[assume]]` has a matching debug assert and a benchmark that justifies it.
- [ ] No virtual call, `std::function`, exception or allocation reachable from push or pop.
- [ ] No layout-changing macro; no debug-only members.
- [ ] No dead code, no commented-out code, no `TODO` without an entry in [23-open-questions.md](23-open-questions.md).
