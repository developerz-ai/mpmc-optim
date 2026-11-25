# 🔌 Public API

**One class template, policies in the type, every hot-path call `noexcept` and non-allocating, failure reported in the return value.** Names follow P0260 where the semantics match, so a later move to `std` is a rename.

Status: design. Nothing here is implemented. The sketch in [Interface sketch](#interface-sketch) compiles; the bodies do not exist.

## Rules

- `try_*` never blocks, never allocates, never throws. Blocking calls exist only when the wait policy allows them.
- A failed `try_push(T&&)` MUST leave the argument untouched. Callers retry with the same object.
- Every result is `[[nodiscard]]`. A dropped `status` is a dropped element.
- `T` MUST be nothrow move constructible and nothrow destructible. No opt-out. Reason: [Exception policy](#exception-policy).
- No function returns a reference or pointer into the ring, except inside a callback that runs within the slot window (I4, [01-vision.md](01-vision.md)).
- `size_approx()` is a hint (I7). No `empty()`, no `full()`, no `size()`: those names invite check-then-act races.
- The queue is neither copyable nor movable. Handles hold its address.
- Policy order MUST NOT change the type.

## Element requirements

| Concept | Requires | Enables |
|---|---|---|
| `element<T>` | object type, not cv-qualified, nothrow move constructible, nothrow destructible | everything |
| `trivial_element<T>` | `element` and trivially copyable | `memcpy` batch moves, SIMD copies ([14-simd.md](14-simd.md)), skipping destructor loops |
| `sink<F, T>` | `F` nothrow invocable with `T&&` | in-place consume |

- Do NOT require default constructible (only out-parameter pops need it) or copyable (`try_push(const T&)` is constrained separately).
- Trivially relocatable types (P1144, P2786) are not in C++23. Do not key an optimisation on a home-made trait without an opt-in from the user: guessing wrong is UB. Owner: [10-raii-and-lifetime.md](10-raii-and-lifetime.md).
- Large `T` (hypothesis: above one destructive size) belongs behind a pointer or an index into a pool. The queue does not do this silently; see [08-arenas-and-allocators.md](08-arenas-and-allocators.md).

## Operations

| Call | Blocks | Returns | Notes |
|---|---|---|---|
| `try_push(const T&)`, `try_push(T&&)`, `try_emplace(args...)` | no | `status`: `ok`, `full`, `closed` | argument untouched unless `ok` |
| `try_pop()` | no | `expected<T, status>`: value, `empty`, `closed` | `closed` only once drained |
| `try_consume(f)` | no | `status` | `f(T&&)` runs inside the slot window; no move out of the ring |
| `try_push_bulk`, `try_pop_bulk`, `try_consume_bulk` | no | count transferred | short count means full, empty or closed |
| `push(T&&)` | yes | `status`: `ok`, `closed` | absent with `no_wait` |
| `pop()` | yes | `expected<T, status>`: value, `closed` | absent with `no_wait` |
| `try_push_for`, `try_pop_for` (and `_until`) | bounded | as `try_*` | timeout reports `full` or `empty` |
| `close()`, `is_closed()` | no | | see [Close semantics](#close-semantics) |
| `capacity()`, `size_approx()` | no | `size_t` | |

Not offered, on purpose:

| Missing | Why |
|---|---|
| `front()`, `peek()` | Another consumer can pop the element while the caller looks at it |
| `empty()`, `full()`, `size()` | Stale on return. rigtorp and folly document their `size()` as a guess that can be negative ([rigtorp source](https://github.com/rigtorp/MPMCQueue/blob/master/include/rigtorp/MPMCQueue.h), [folly source](https://github.com/facebook/folly/blob/main/folly/MPMCQueue.h)) |
| `clear()` | Not atomic against producers. Drain with `try_consume_bulk` |
| `swap`, move | Handles and parked waiters hold the address |

## How pop reports its result

| Shape | For | Against |
|---|---|---|
| `bool try_pop(T& out)` | No return-value move; familiar (TBB, folly, rigtorp, moodycamel) | Needs a constructed `T` first, so default constructible or a dummy; move-assigns over a live object; one `bool` cannot tell `empty` from `closed` |
| `optional<T> try_pop()` | No constructed `T` needed; P0260's blocking `pop` | Cannot tell `empty` from `closed` |
| `expected<T, status> try_pop()` | Tells `empty` from `closed`; `[[nodiscard]]`; matches P0260 `try_pop` | One extra move of `T` out of the slot into the result; `expected` needs C++23 library support |
| `status try_consume(F)` | Zero moves, no temporary | User code runs inside the slot window: a slow `f` holds the slot and, in ticket-ordered rings, stalls later consumers |

Decision: `expected` for the value-returning calls, `try_consume` for hot loops. The out-parameter form is not offered. Whether `expected<T, status>` costs anything measurable after inlining for register-sized `T` is an open question; compare the disassembly ([20-profiling.md](20-profiling.md)).

Pitfall: `try_consume` with a callback that pushes to the same queue, or blocks, turns a mutex-free ring into a deadlock. The `sink` concept cannot check this. Document it; assert in debug builds with a thread-local "inside slot window" flag.

## In-place claim and commit

Two-phase push: claim a slot, construct into it, publish.

| Form | Shape | Verdict |
|---|---|---|
| Closed | `try_emplace(args...)`, `try_consume(f)` | Default. The window is bounded by one constructor or one callback |
| Open | `auto g = q.try_claim(); new (g.storage()) T(...); g.commit();` | Opt-in at most. See below |

Why the open form is dangerous:

- In a sequence-per-slot ring a claimed ticket cannot be handed back ([03-algorithms.md](03-algorithms.md)). A guard destroyed without `commit()` leaves a slot no consumer can pass.
- So an uncommitted guard needs one of: `std::terminate`, a "skip" state in the slot protocol that every consumer pays for, or a rule that construction cannot fail. `try_emplace` with a `nothrow` constraint is the third option without the guard.
- The claim window lasts as long as user code holds the guard. A preempted holder blocks every later consumer. That is the "mutex-free, not lock-free" case in [01-vision.md](01-vision.md).

Use the open form only for payloads filled by a foreign API that writes into caller storage (a `recv` into the slot). Check: a test that claims, sleeps, and asserts other consumers' progress matches the documented guarantee.

## Batches

| Call | Input | Semantics |
|---|---|---|
| `try_push_bulk(span<T>)` | contiguous | moves from the first `n` elements, returns `n` |
| `try_push_bulk(It, count)` | any input iterator | constructs from `*it`, advances only for accepted elements |
| `try_pop_bulk(Out, max)` | output iterator | assigns through `out`, returns count |
| `try_consume_bulk(f, max)` | callback | `f(T&&)` per element, in order |

- Partial success is the contract. All-or-nothing bulk push needs a reservation of `n` tickets that can fail as a unit; moodycamel's `try_enqueue_bulk` returns `bool` and its `try_dequeue_bulk` returns a count ([source](https://github.com/cameron314/concurrentqueue/blob/master/concurrentqueue.h)). Whether to add an all-or-nothing variant is an open question.
- A batch claims `n` consecutive tickets with one contended RMW instead of `n` ([03-algorithms.md](03-algorithms.md)). Other producers' elements do not interleave inside it.
- Pitfall: `span<T>` push leaves moved-from objects in the first `n` positions and untouched objects after. Callers that reuse the buffer must use the returned count.
- Pitfall: an input iterator that throws on increment breaks `noexcept`. The constraint covers construction from `*it`, not `++it`. Use contiguous spans on the hot path.
- Pitfall: batch pop into `std::back_inserter(vector)` allocates inside the slot window. Reserve first, or pop into a fixed array.

## Handles

A handle is a per-thread object from `q.producer()` or `q.consumer()` (vocabulary: [01-vision.md](01-vision.md)).

| Rule | Reason |
|---|---|
| Same operations as the queue | Code moves between the two without a rewrite |
| Movable, not copyable | It owns cached state |
| One thread at a time; no internal synchronisation | That is what makes it cheap |
| MUST NOT outlive the queue | It holds `basic_queue*`. Debug builds count live handles and assert in `~basic_queue` |
| Never stored in `thread_local` by the library | Hidden TLS destructors run after `main` returns, after the queue is gone |

What a handle may cache: the other side's counter (to skip a shared load), a reserved ticket range, a preferred shard ([13-numa-and-topology.md](13-numa-and-topology.md)), parking state ([07-waiting.md](07-waiting.md)), stats counters. What it MUST NOT cache: anything a correctness decision reads without revalidating against the slot sequence.

moodycamel calls these tokens: `ProducerToken` selects an explicit per-producer sub-queue, `ConsumerToken` holds rotation state ([README](https://github.com/cameron314/concurrentqueue#tokens)). A reserved ticket range in a handle weakens ordering: tickets no longer reflect call order across threads. State the resulting contract in [03-algorithms.md](03-algorithms.md) before offering it.

## Close semantics

| Point | Rule |
|---|---|
| `close()` | `noexcept`, idempotent, callable from any thread. Not reversible |
| Pushes after close | return `closed`; the argument is untouched |
| Pops after close | drain what is there, then return `closed` |
| Blocked callers | all woken; producers get `closed`, consumers get remaining elements then `closed` |
| Elements left at destruction | destroyed exactly once (I6) |

- Linearisation: every push that returns `ok` is visible to the drain. A push that races with `close()` either wins (its element will be popped) or returns `closed`. No third outcome.
- Implementation pressure: a separate `atomic<bool> closed` checked before the ticket claim does NOT give that guarantee. A producer can pass the check, be preempted, and publish after a consumer saw "closed and empty". Fold the flag into the producer counter so the claim itself fails; crossbeam's bounded channel keeps a `mark_bit` in `tail` for this ([array.rs](https://github.com/crossbeam-rs/crossbeam/blob/master/crossbeam-channel/src/flavors/array.rs)). Owner: [03-algorithms.md](03-algorithms.md).
- P0260R20 has the same shape: `close()` stops pushes, pops continue until empty, `push` returns `false` and `pop` returns an empty `optional` when closed ([P0260R20](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2026/p0260r20)).
- TBB's `abort()` is different: it throws `user_abort` in waiting threads and the queue stays usable ([oneTBB source](https://github.com/uxlfoundation/oneTBB/blob/master/include/oneapi/tbb/concurrent_queue.h)). Not adopted: exceptions on the wait path.
- Check: stress test with N producers, one closer, consumers draining; count `ok` pushes and popped elements; they MUST match ([17-testing-and-verification.md](17-testing-and-verification.md)).

## Capacity

| Rule | Detail |
|---|---|
| Power of two | Index is `ticket & mask`. `static_capacity<N>` rejects other `N` at compile time |
| Dynamic capacity rounds up | `std::bit_ceil(min_capacity)`. `capacity()` reports the real value |
| Minimum 2 | With one slot, "written on lap L" and "free for lap L+1" are the same sequence value in a Vyukov-style ring (`pos + 1` both ways); [Vyukov's code](https://web.archive.org/web/20221127075938/https://www.1024cores.net/home/lock-free-algorithms/queues/bounded-mpmc-queue) asserts `buffer_size >= 2` (archive link: as of 2026-11 the live 1024cores.net domain redirects to an unrelated site). rigtorp avoids this with a `2 * turn` encoding and accepts any capacity at least 1 |
| Maximum | `bit_ceil` of a value above `2^63` is UB. Check before rounding, throw `std::length_error` |
| No resize | A bounded queue that resizes is a different algorithm ([03-algorithms.md](03-algorithms.md)) |

Pitfall: rounding up changes back-pressure. A caller who asked for 1000 and got 1024 sees `full` later than planned. Report `capacity()`; never let callers assume their argument.

## Memory injection

| Option | Cost | Use |
|---|---|---|
| `Allocator` template parameter (default `std::allocator<T>`) | In the type; zero call overhead | Default. Rebind to the slot type |
| `std::pmr::polymorphic_allocator` as that parameter | One virtual call at construction and destruction only | Arena or huge-page resource ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) |
| Caller-supplied storage (`span<std::byte>`) | None | Shared memory later, static storage; inter-process is a non-goal for now |

- Pitfall: allocators are not required to honour over-alignment. rigtorp checks the returned pointer and throws `bad_alloc` if it is misaligned ([source](https://github.com/rigtorp/MPMCQueue/blob/master/include/rigtorp/MPMCQueue.h)). Do the same.
- Pitfall: fancy pointers. Require `allocator_traits<A>::pointer` to be a raw pointer, by `static_assert`, until someone needs otherwise.
- `static_capacity<N>` stores the ring inline. `sizeof(queue)` can be megabytes: forbid it on the stack by documentation, and static-assert a ceiling the user can raise.

## Policies

`queue<T, Ps...>` is an alias. Each policy carries a `category`; the alias picks one per category, in any order, with a default, and maps to one `basic_queue` specialisation.

| Category | Choices | Default | Owner |
|---|---|---|---|
| wait | `no_wait`, `spin_then_park`, later `spin`, `park` | `spin_then_park` | [07-waiting.md](07-waiting.md) |
| layout | `compact`, `padded` | `compact` | [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| capacity | `dynamic_capacity`, `static_capacity<N>` | `dynamic_capacity` | this doc |
| stats | `no_stats`, `counters` | `no_stats` | [19-benchmarking.md](19-benchmarking.md) |

- Why an alias: with `template <class T, class... Ps> class queue`, `queue<T, A, B>` and `queue<T, B, A>` are different types with duplicate code and no conversion. The alias canonicalises. The sketch asserts it.
- Two policies of one category: compile error with a message.
- Unknown policy types are ignored by the sketch. Hypothesis: rejecting them is better. It costs one more fold expression.
- Pitfall: defaults are part of the type. Changing a default is an ABI break for anyone who spelled `queue<T>` in an interface.
- Pitfall: alias templates do not deduce. A function taking "any mpmc queue" must be written against `basic_queue<T, W, L, C, S, A>` or a concept.
- `stats` MUST cost nothing when off: empty base or `[[no_unique_address]]`, never an `if` on a runtime flag. Counters live in handles, not on shared lines ([12-cpu-and-cache.md](12-cpu-and-cache.md)).

## Exception policy

| Site | Policy |
|---|---|
| Constructor | May throw `std::bad_alloc`, `std::length_error`, `std::invalid_argument` |
| `try_*`, `push`, `pop`, `close`, observers | `noexcept`, unconditionally |
| Element move and destroy | Required `noexcept` by `element<T>` |
| `try_emplace(args...)` | Constrained on `is_nothrow_constructible` |
| Callbacks | Constrained on `is_nothrow_invocable` |

- Why no throwing elements: after a ticket claim there is no rollback. A constructor that throws into a claimed slot leaves a hole. folly static-asserts both properties ([folly source](https://github.com/facebook/folly/blob/main/folly/MPMCQueue.h)); rigtorp constrains each overload. moodycamel supports throwing types ([README, exception safety](https://github.com/cameron314/concurrentqueue#exception-safety)).
- Escape hatch for a throwing type: construct outside, then `try_push(std::move(obj))`, which only needs the nothrow move.
- `-fno-exceptions` consumers: every hot-path call already works. Construction failure needs a non-throwing path; the queue is immovable, so `expected<queue, errc>` is not available without `std::in_place` plumbing. Open question, see report.

## Coroutines and senders

- Not in the first release. Core header: no `<coroutine>`, no `<execution>`. Async adapters live in a separate header and build on the same waiter list as blocking calls ([07-waiting.md](07-waiting.md)).
- Shape: `async_pop()` returns an awaitable; the waiter node lives in the coroutine frame (no allocation).
- P0260R20 specifies `async_push` and `async_pop` returning senders, and a `busy_async` status for a `try_*` call that would have to complete a pending async operation inline ([P0260R20](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2026/p0260r20)). Follow that naming if the adapter is built.
- Pitfall: resuming the awaiting coroutine inline runs the consumer's continuation on the producer's thread, inside `push`. That moves latency to the wrong thread and can recurse. Resume through a scheduler the caller supplies.
- Pitfall: a coroutine destroyed while suspended must unlink its waiter node. That is a cancellation race with a concurrent wake; it needs its own model-check run ([17-testing-and-verification.md](17-testing-and-verification.md)).

## Compile-time diagnostics

| Mistake | Diagnostic |
|---|---|
| `T` throws on move or destroy | `element<T>` constraint failure naming the trait |
| `static_capacity<1000>` | constraint `has_single_bit(N)` |
| Two wait policies | `static_assert`: "mpmc: two policies of the same category" |
| `q.pop()` with `no_wait` | call does not exist (`requires can_block`) |
| 64-bit atomics not lock-free on the target | `static_assert(std::atomic<std::uint64_t>::is_always_lock_free)` in the implementation |
| Ignored result | `[[nodiscard]]` on `status` and on value-returning calls |

- Prefer `requires` on the declaration over `static_assert` in the body: the error points at the call site, and the constraint is visible to `requires`-expressions in user code.
- `= delete("reason")` is C++26 ([P2573](https://wg21.link/P2573)). Not usable here.
- Check: negative-compile tests. One file per expected error, built with `-fsyntax-only`, CTest `WILL_FAIL` ([21-build-and-toolchain.md](21-build-and-toolchain.md)).

## Interface sketch

```cpp
// check: compile
#include <bit>
#include <chrono>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <functional>
#include <iterator>
#include <memory>
#include <span>
#include <type_traits>
#include <utility>

namespace mpmc {
inline namespace v1 {

// ---- element requirements -------------------------------------------------
template <class T>
concept element = std::is_object_v<T> && !std::is_const_v<T> && !std::is_volatile_v<T> &&
                  std::is_nothrow_move_constructible_v<T> && std::is_nothrow_destructible_v<T>;

template <class T>
concept trivial_element = element<T> && std::is_trivially_copyable_v<T>;

template <class F, class T>
concept sink = std::is_nothrow_invocable_v<F, T&&>;  // consumes one element in place

// ---- results --------------------------------------------------------------
enum class [[nodiscard]] status : std::uint8_t { ok, full, empty, closed };

template <class T>
using pop_result = std::expected<T, status>;  // error is empty or closed, never ok

// ---- policies: one tag per category, any order, each at most once ----------
namespace policy {
struct wait_tag {};
struct layout_tag {};
struct capacity_tag {};
struct stats_tag {};

struct no_wait { using category = wait_tag; };         // try_* only, no blocking calls
struct spin_then_park { using category = wait_tag; };  // default
struct padded { using category = layout_tag; };        // one slot per destructive size
struct compact { using category = layout_tag; };       // dense slots, default
struct dynamic_capacity { using category = capacity_tag; };
template <std::size_t N>
  requires(N >= 2 && std::has_single_bit(N))
struct static_capacity {
  using category = capacity_tag;
  static constexpr std::size_t value = N;
};
struct no_stats { using category = stats_tag; };
struct counters { using category = stats_tag; };

template <class P, class Tag>
concept in_category = std::same_as<typename P::category, Tag>;

template <class Tag, class Default, class... Ps>
struct select : std::type_identity<Default> {};
template <class Tag, class Default, class P, class... Ps>
struct select<Tag, Default, P, Ps...> : select<Tag, Default, Ps...> {};
template <class Tag, class Default, class P, class... Ps>
  requires in_category<P, Tag>
struct select<Tag, Default, P, Ps...> : std::type_identity<P> {
  static_assert((0 + ... + int{in_category<Ps, Tag>}) == 0,
                "mpmc: two policies of the same category");
};
template <class Tag, class Default, class... Ps>
using select_t = typename select<Tag, Default, Ps...>::type;
}  // namespace policy

// ---- the queue -------------------------------------------------------------
template <element T, class Wait, class Layout, class Capacity, class Stats,
          class Allocator = std::allocator<T>>
class basic_queue {
 public:
  using value_type = T;
  static constexpr bool can_block = !std::same_as<Wait, policy::no_wait>;

  basic_queue()
    requires(!std::same_as<Capacity, policy::dynamic_capacity>);
  explicit basic_queue(std::size_t min_capacity, const Allocator& alloc = Allocator())
    requires std::same_as<Capacity, policy::dynamic_capacity>;  // rounds up, throws on failure
  basic_queue(const basic_queue&) = delete;
  basic_queue& operator=(const basic_queue&) = delete;
  ~basic_queue();  // precondition: no concurrent operation, no live handle

  // Non-blocking. A failed try_push leaves `v` untouched.
  status try_push(const T& v) noexcept
    requires std::is_nothrow_copy_constructible_v<T>;
  status try_push(T&& v) noexcept;
  template <class... Args>
    requires std::is_nothrow_constructible_v<T, Args...>
  status try_emplace(Args&&... args) noexcept;
  [[nodiscard]] pop_result<T> try_pop() noexcept;
  template <sink<T> F>
  status try_consume(F&& f) noexcept;  // f(T&&) runs inside the slot window

  // Batches. Return the count transferred; a short count means full, empty or closed.
  [[nodiscard]] std::size_t try_push_bulk(std::span<T> items) noexcept;  // moves from a prefix
  template <std::input_iterator It>
    requires std::is_nothrow_constructible_v<T, std::iter_reference_t<It>>
  [[nodiscard]] std::size_t try_push_bulk(It first, std::size_t count) noexcept;
  template <std::output_iterator<T> Out>
  [[nodiscard]] std::size_t try_pop_bulk(Out out, std::size_t max) noexcept;
  template <sink<T> F>
  [[nodiscard]] std::size_t try_consume_bulk(F&& f, std::size_t max) noexcept;

  // Blocking, only with a waiting policy. push: ok or closed. pop: value or closed.
  status push(T&& v) noexcept
    requires can_block;
  [[nodiscard]] pop_result<T> pop() noexcept
    requires can_block;
  template <class Rep, class Period>
  status try_push_for(T&& v, std::chrono::duration<Rep, Period> timeout) noexcept
    requires can_block;
  template <class Rep, class Period>
  [[nodiscard]] pop_result<T> try_pop_for(std::chrono::duration<Rep, Period> timeout) noexcept
    requires can_block;

  void close() noexcept;  // idempotent; wakes every waiter
  [[nodiscard]] bool is_closed() const noexcept;
  [[nodiscard]] std::size_t capacity() const noexcept;
  [[nodiscard]] std::size_t size_approx() const noexcept;  // hint in [0, capacity()], see I7

  class producer_handle;  // movable, not copyable, one thread at a time, must not outlive *this
  class consumer_handle;
  [[nodiscard]] producer_handle producer() noexcept;
  [[nodiscard]] consumer_handle consumer() noexcept;
};

template <class T, class... Ps>
using queue = basic_queue<T,
                          policy::select_t<policy::wait_tag, policy::spin_then_park, Ps...>,
                          policy::select_t<policy::layout_tag, policy::compact, Ps...>,
                          policy::select_t<policy::capacity_tag, policy::dynamic_capacity, Ps...>,
                          policy::select_t<policy::stats_tag, policy::no_stats, Ps...>>;

}  // namespace v1
}  // namespace mpmc

// Policy order does not create a new type.
static_assert(std::same_as<mpmc::queue<int, mpmc::policy::padded, mpmc::policy::no_wait>,
                           mpmc::queue<int, mpmc::policy::no_wait, mpmc::policy::padded>>);
static_assert(mpmc::element<std::unique_ptr<int>> && !mpmc::element<const int>);
static_assert(!mpmc::queue<int, mpmc::policy::no_wait>::can_block);

template <class Q>
concept has_blocking_pop = requires(Q& q) { q.pop(); };
static_assert(has_blocking_pop<mpmc::queue<int>>);
static_assert(!has_blocking_pop<mpmc::queue<int, mpmc::policy::no_wait>>);
```

Not in the sketch: the handle bodies, `_until` overloads, caller-supplied storage, the async header.

## Other APIs

As of 2026-11, checked against each repository's default branch.

| Library | Push | Pop | Blocking | Bulk | Close | Size | Element rule |
|---|---|---|---|---|---|---|---|
| [P0260R20](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2026/p0260r20) `bounded_queue` | `push` → `bool`, `try_push` → `conqueue_status` | `pop` → `optional<T>`, `try_pop` → `expected<T, conqueue_status>` | yes, plus senders | no | `close`, `is_closed` | none | allocator-aware |
| [moodycamel](https://github.com/cameron314/concurrentqueue) | `enqueue` (may allocate), `try_enqueue` (never allocates) → `bool` | `try_dequeue(U&)` → `bool` | separate `BlockingConcurrentQueue` | yes, with and without tokens | no | `size_approx` | throwing types supported |
| [folly `MPMCQueue`](https://github.com/facebook/folly/blob/main/folly/MPMCQueue.h) | `write`, `writeIfNotFull`, `blockingWrite`, `tryWriteUntil` | `read`, `readIfNotEmpty`, `blockingRead`, `tryReadUntil` | yes | no | no | `size`, `sizeGuess` (signed) | nothrow move and destroy |
| [oneTBB `concurrent_bounded_queue`](https://github.com/uxlfoundation/oneTBB/blob/master/include/oneapi/tbb/concurrent_queue.h) | `push` (blocks), `try_push`, `emplace`, `try_emplace` | `pop(T&)` (blocks), `try_pop(T&)` | yes | no | `abort` (throws in waiters) | `size` (signed), `set_capacity` | copy or move |
| [rigtorp `MPMCQueue`](https://github.com/rigtorp/MPMCQueue) | `push`, `emplace` (block by spinning), `try_push`, `try_emplace` | `pop(T&)`, `try_pop(T&)`, `try_consume(F)` | spin only | no | no | `size` (signed), `empty` | nothrow, per overload |

Lessons taken:

| From | Keep | Avoid |
|---|---|---|
| P0260 | names, `expected` result, close contract | `busy` results unless the algorithm needs them |
| moodycamel | `try_` means "no allocation", tokens, bulk, `size_approx` name | one name (`enqueue`) that sometimes allocates |
| folly | static asserts on `T`; the comment explaining that a failed `write(std::move(x))` leaves `x` intact | two near-identical calls (`write` and `writeIfNotFull`) whose difference is a linearisation subtlety |
| rigtorp | `try_consume`, alignment check on the allocator result | `empty()` |

P0260 status, as of 2026-11: R20 is dated 2026-07-12 and addressed to LEWG. It defines header `<conqueue>` and macro `__cpp_lib_conqueue`, renamed `conqueue_errc` to `conqueue_status` in R19, and made its concepts non-exposition-only in R20. The paper names no target standard. It is still in LEWG after C++26's feature freeze, so C++29 at the earliest (inference from the dates, not a statement in the paper). Recheck at [wg21.link/P0260](https://wg21.link/P0260) before leaning on any detail.

## ABI and versioning

- Header-only: there is no library ABI, but users put `queue<T>` in their own interfaces. Their ABI is ours.
- `inline namespace v1`. A layout change bumps it, so two versions in one process get different mangled names instead of an ODR violation.
- Everything that changes layout MUST be in the type (a policy) or in the inline namespace. NEVER a macro, and never `NDEBUG`.
- Pitfall: `std::hardware_destructive_interference_size` can differ between translation units built with different `-mtune` or compiler versions. GCC warns about its use in headers with [`-Winterference-size`](https://gcc.gnu.org/onlinedocs/gcc/C_002b_002b-Dialect-Options.html#index-Winterference-size). Use a library constant fixed per architecture. Owner: [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md).
- Pitfall: debug-only members (handle counters, "inside slot window" flags) change `sizeof`. Gate them behind a policy (`stats`-like `checked` category), not behind a macro.
- Version macros `MPMC_VERSION_MAJOR`, `_MINOR`, `_PATCH`, and one `MPMC_VERSION` integer for `#if`. Semantic versioning: major for source or layout breaks.
- Check: `abidiff` is not useful for a header-only library. Instead keep a `static_assert` file pinning `sizeof` and `alignof` for a fixed set of instantiations per target, and fail CI when they move without a namespace bump.
