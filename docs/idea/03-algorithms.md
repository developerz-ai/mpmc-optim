# Algorithms

**Default: bounded per-slot sequence ring, CAS claim, 64-bit tickets. Everything else is opt-in.** Reasons and the losing candidates are below. Recommendation, not measurement: the experiments that could overturn it are listed at the end.

Words follow [01-vision.md](01-vision.md): tail is the producer counter, head is the consumer counter. Orderings are justified edge by edge in [05-memory-model.md](05-memory-model.md). Progress terms: [06-progress-and-reclamation.md](06-progress-and-reclamation.md). Sources for each design: [02-prior-art.md](02-prior-art.md).

## Candidates

| # | Candidate | Claim | Hand-off | Progress | Failed `try` linearizable |
|---|---|---|---|---|---|
| A | Sequence ring, CAS claim | CAS on counter | slot sequence, release store | blocking (mutex-free) | no, unless A-strict |
| B | Sequence ring, FAA ticket | FAA on counter | same slot sequence | blocking, total operations | no `try` without CAS |
| C | SCQ index ring | FAA on counter | CAS on cycle-tagged entry | lock-free | yes |
| D | Segmented (LCRQ, LPRQ style) | FAA inside a segment | CAS on cell | lock-free with reclamation | yes |
| E | Sharded rings | per shard | per shard | as the shard | no global order |

## A. Sequence ring with CAS claim (default)

Slot protocol for ticket `t`, slot `i = t mod cap`:

```text
push:  t = tail                          pop:  h = head
  loop: s = slot[t].seq (acquire)          loop: s = slot[h].seq (acquire)
    s == t   : CAS tail t -> t+1             s == h+1 : CAS head h -> h+1
               ok: write T; seq = t+1                   ok: read T; destroy; seq = h+cap
               fail: retry with new t                   fail: retry with new h
    s <  t   : return false                  s <  h+1 : return false
    s >  t   : t = tail; retry               s >  h+1 : h = head; retry
```

| `seq` of slot `i` | State | Who may touch the element | Next |
|---|---|---|---|
| `t`, tail ≤ `t` | Empty, lap `t / cap` | nobody | a producer wins the CAS |
| `t`, tail > `t` | Claimed for write | only the producer holding `t` | it stores `t+1` |
| `t+1`, head ≤ `t` | Full | nobody | a consumer wins the CAS |
| `t+1`, head > `t` | Claimed for read | only the consumer holding `t` | it stores `t+cap` |
| `t+cap` | Empty, next lap | nobody | as row 1 |

Complete, minimal, TSan-clean. Layout (padding between slots, cached counters) is deliberately absent: [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) and [12-cpu-and-cache.md](12-cpu-and-cache.md) own it.

```cpp
// check: run
#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <new>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>
template <class T>
  requires std::is_nothrow_move_constructible_v<T> && std::is_nothrow_destructible_v<T>
class Ring {
  static constexpr std::size_t kLine = std::hardware_destructive_interference_size;
  struct Slot {
    std::atomic<std::uint64_t> seq;       // == t: ticket t may write. == t+1: ticket t may read.
    alignas(T) std::byte raw[sizeof(T)];  // holds a T only while seq == t+1
    T* obj() noexcept { return std::launder(reinterpret_cast<T*>(raw)); }
  };
  const std::uint64_t cap_, mask_;
  const std::unique_ptr<Slot[]> slots_;
  alignas(kLine) std::atomic<std::uint64_t> tail_{0};  // next producer ticket
  alignas(kLine) std::atomic<std::uint64_t> head_{0};  // next consumer ticket
 public:
  explicit Ring(std::size_t capacity)
      : cap_(std::bit_ceil(capacity < 2 ? std::size_t{2} : capacity)), mask_(cap_ - 1),
        slots_(new Slot[cap_]) {
    for (std::uint64_t i = 0; i < cap_; ++i) slots_[i].seq.store(i, std::memory_order_relaxed);
  }  // publishing `this` to other threads supplies the happens-before for these stores
  ~Ring() {  // I6: single-threaded here. seq == t+1 marks the slots still holding a T
    for (std::uint64_t t = head_.load(std::memory_order_relaxed);
         slots_[t & mask_].seq.load(std::memory_order_relaxed) == t + 1; ++t)
      std::destroy_at(slots_[t & mask_].obj());
  }
  template <class... A>
    requires std::is_nothrow_constructible_v<T, A...>
  [[nodiscard]] bool try_push(A&&... a) noexcept {
    std::uint64_t t = tail_.load(std::memory_order_relaxed);  // E1: a guess, checked by E2 + E3
    for (;;) {
      Slot& s = slots_[t & mask_];
      // E2 acquire: pairs with E8. Brings in the previous lap's destroy of this slot.
      const std::uint64_t seq = s.seq.load(std::memory_order_acquire);
      const auto d = static_cast<std::int64_t>(seq - t);
      if (d == 0) {
        // E3: the claim. Relaxed: exclusivity comes from CAS atomicity, visibility from E2/E4.
        if (tail_.compare_exchange_weak(t, t + 1, std::memory_order_relaxed,
                                        std::memory_order_relaxed)) {
          ::new (static_cast<void*>(s.raw)) T(std::forward<A>(a)...);
          s.seq.store(t + 1, std::memory_order_release);  // E4 release: publishes the T to E6
          return true;
        }  // CAS failure reloaded t
      } else if (d < 0) {
        return false;  // slot not released yet: full, or its consumer is mid-pop
      } else {
        t = tail_.load(std::memory_order_relaxed);  // E5: we raced, refresh the guess
      }
    }
  }
  [[nodiscard]] bool try_pop(T& out) noexcept
    requires std::is_nothrow_move_assignable_v<T>
  {
    std::uint64_t h = head_.load(std::memory_order_relaxed);
    for (;;) {
      Slot& s = slots_[h & mask_];
      // E6 acquire: pairs with E4. The T is visible before obj() is touched (I3, I4).
      const std::uint64_t seq = s.seq.load(std::memory_order_acquire);
      const auto d = static_cast<std::int64_t>(seq - (h + 1));
      if (d == 0) {
        if (head_.compare_exchange_weak(h, h + 1, std::memory_order_relaxed,  // E7: the claim
                                        std::memory_order_relaxed)) {
          out = std::move(*s.obj());
          std::destroy_at(s.obj());
          s.seq.store(h + cap_, std::memory_order_release);  // E8 release: frees slot for E2
          return true;
        }
      } else if (d < 0) {
        return false;  // nothing published at head: empty, or its producer is mid-push
      } else {
        h = head_.load(std::memory_order_relaxed);
      }
    }
  }
};
int main() {
  constexpr std::uint64_t kProducers = 4, kConsumers = 4, kPer = 20000;
  Ring<std::uint64_t> q(64);
  std::atomic<std::uint64_t> sum{0}, popped{0};
  std::vector<std::jthread> ts;
  for (std::uint64_t p = 0; p < kProducers; ++p)
    ts.emplace_back([&q, p] {
      for (std::uint64_t i = 0; i < kPer; ++i)
        while (!q.try_push((p << 32) | i)) std::this_thread::yield();
    });
  for (std::uint64_t c = 0; c < kConsumers; ++c)
    ts.emplace_back([&] {
      std::vector<std::uint64_t> next(kProducers, 0);
      for (std::uint64_t v = 0; popped.load(std::memory_order_relaxed) < kProducers * kPer;) {
        if (!q.try_pop(v)) { std::this_thread::yield(); continue; }
        if ((v & 0xffffffffu) < next[v >> 32]) std::abort();  // I2 as seen by one consumer
        next[v >> 32] = (v & 0xffffffffu) + 1;
        sum.fetch_add(v & 0xffffffffu, std::memory_order_relaxed);
        popped.fetch_add(1, std::memory_order_relaxed);
      }
    });
  ts.clear();  // join
  return sum.load(std::memory_order_relaxed) == kProducers * (kPer * (kPer - 1) / 2) ? 0 : 1;  // I1
}
```

Why it holds:

| Invariant | Argument |
|---|---|
| I1 | A ticket is issued by exactly one successful CAS (E3 or E7). Ticket `t` writes slot `t mod cap` once and reads it once |
| I2 | One producer's pushes are sequential, so its tickets increase. Consumers take tickets in increasing order, and ticket `t` pops what ticket `t` pushed |
| I3 | Pop touches the element only after E6 reads `t+1`, which E4 wrote after constructing it. Release to acquire gives happens-before |
| I4 | Element access sits strictly between a won CAS and the following release store. `seq` is the only field read outside that window |
| I5 | Storage is allocated in the constructor only |
| I6 | Destructor walks from head while `seq == t+1`. Stops within `cap` steps because `cap ≥ 2` makes `t+1 ≠ t+cap` |
| I7 | No size function exists. If added it reads both counters relaxed and is a hint |

Where it fails:

| Failure | Cause | Guard or check |
|---|---|---|
| Consumers stop while elements exist | Producer preempted between E3 and E4 holds ticket `t`. Later tickets are published but unreachable | By design: say "mutex-free". Measure with a stalled-thread test ([17-testing-and-verification.md](17-testing-and-verification.md)) |
| `try_pop` false, queue not empty | Same window. A push that already returned sits behind an unpublished ticket | Document `false` as "not ready". Use A-strict when the caller needs "empty" |
| `try_push` false, queue not full | Consumer between E7 and E8 | Same |
| Slot never recovers | Constructor or move throws after the claim | `noexcept` in the `requires` clause. folly enforces the same |
| Wrong state after wrap | 32-bit tickets, or `cap = 1` (`t+1 == t+cap`) | 64-bit tickets, `cap ≥ 2` in the constructor |
| False sharing | Small `T`: neighbours' `seq` share a line | Index remap or padding, owned by doc 09 |
| CAS storm | Many producers retry E3 | Backoff ([07-waiting.md](07-waiting.md)) or variant B |

**A-strict (opt-in).** On `s < t` (or `s < h+1`): full fence, re-read the opposite counter, return false only when the counters prove full or empty, otherwise spin and retry. Needs `seq_cst` on E3 and E7. Gives linearizable `false`, costs a wait on a stalled thread. crossbeam `ArrayQueue` does exactly this. The fence is a store-load pattern: see doc 05 before touching it.

## B. FAA tickets on the same slot protocol

Use when the API is "wait until done" (`push`, `pop`). Do not use when the caller needs a timeout or `try`. One FAA cannot fail, so contention costs no retries.

```cpp
void push(T v) noexcept {  // fragment: members as in Ring above
  const std::uint64_t t = tail_.fetch_add(1, std::memory_order_relaxed);  // cannot fail, cannot undo
  Slot& s = slots_[t & mask_];
  while (s.seq.load(std::memory_order_acquire) != t) wait();  // previous lap not popped yet
  ::new (static_cast<void*>(s.raw)) T(std::move(v));
  s.seq.store(t + 1, std::memory_order_release);
}
T pop() noexcept {
  const std::uint64_t h = head_.fetch_add(1, std::memory_order_relaxed);
  Slot& s = slots_[h & mask_];
  while (s.seq.load(std::memory_order_acquire) != h + 1) wait();  // not pushed yet
  T v = std::move(*s.obj());
  std::destroy_at(s.obj());
  s.seq.store(h + cap_, std::memory_order_release);
  return v;
}
```

- Same state table, so A's `try_push` and B's `push` can share one ring. rigtorp ships that mix.
- Waiting consumers queue in ticket order: fair hand-off, no thundering herd on one counter.
- Goes wrong: a ticket is a debt. A thread that takes one and never completes blocks that slot for every lap. Timeouts need a ticket-abandon protocol; none is designed here.
- Goes wrong: counters overshoot. `tail − head` can exceed `cap` or go negative, so a size hint needs clamping, and A's `try_push` sees "full" while pushers are parked.

## C. SCQ: lock-free bounded ring

Use when a stalled thread must not stop the others and the payload fits an index. Do not use as the default: four shared RMWs per element against two for A.

Idea ([Nikolaev, DISC 2019](https://arxiv.org/abs/1908.04511)): counters advance by FAA and never wait. An entry carries the cycle (lap) it belongs to. A consumer that arrives first bumps the entry's cycle, so the late producer's CAS fails and it takes a new ticket instead of blocking. `2n` entries hold `n` indices so a free entry is always near. A threshold counter of `3n − 1` stops consumers spinning on an empty ring. Payload lives in a plain array addressed by index; two index rings (free, used) make a queue.

```cpp
// check: run
#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>
#include <optional>
// SCQ index ring after Nikolaev, DISC 2019, Figure 8. Holds indices 0..n-1 in 2n entries.
// Entry = [cycle | safe:1 | index:b], b = log2(2n), bottom (no index) = all ones.
// Every operation is seq_cst: the paper proves the algorithm under sequential consistency only.
class ScqIndexRing {
  static constexpr auto sc = std::memory_order_seq_cst;
  const std::uint64_t n2_;      // 2n entries
  const unsigned b_;            // index bits
  const std::uint64_t bottom_;  // 2n - 1
  const std::unique_ptr<std::atomic<std::uint64_t>[]> e_;
  static constexpr std::size_t kLine = std::hardware_destructive_interference_size;
  alignas(kLine) std::atomic<std::uint64_t> tail_;
  alignas(kLine) std::atomic<std::uint64_t> head_;
  alignas(kLine) std::atomic<std::int64_t> threshold_{-1};
  std::uint64_t cyc(std::uint64_t entry) const noexcept { return entry >> (b_ + 1); }
  std::uint64_t pack(std::uint64_t c, std::uint64_t safe, std::uint64_t i) const noexcept {
    return (c << (b_ + 1)) | (safe << b_) | i;
  }
 public:
  explicit ScqIndexRing(std::uint64_t n_pow2)
      : n2_(2 * n_pow2), b_(static_cast<unsigned>(std::countr_zero(n2_))), bottom_(n2_ - 1),
        e_(new std::atomic<std::uint64_t>[n2_]), tail_(n2_), head_(n2_) {
    for (std::uint64_t i = 0; i < n2_; ++i) e_[i].store(pack(0, 1, bottom_), sc);
  }
  void enqueue(std::uint64_t index) noexcept {  // caller guarantees at most n live indices
    for (;;) {
      const std::uint64_t t = tail_.fetch_add(1, sc);
      auto& slot = e_[t & bottom_];
      std::uint64_t ent = slot.load(sc);
      while (cyc(ent) < t / n2_ && (ent & bottom_) == bottom_ &&
             (((ent >> b_) & 1) != 0 || head_.load(sc) <= t)) {
        if (slot.compare_exchange_weak(ent, pack(t / n2_, 1, index), sc, sc)) {
          const auto full = static_cast<std::int64_t>(n2_ + n2_ / 2 - 1);  // 3n - 1
          if (threshold_.load(sc) != full) threshold_.store(full, sc);
          return;
        }
      }
    }
  }
  std::optional<std::uint64_t> dequeue() noexcept {
    if (threshold_.load(sc) < 0) return std::nullopt;  // empty, no shared write
    for (;;) {
      const std::uint64_t h = head_.fetch_add(1, sc);
      auto& slot = e_[h & bottom_];
      std::uint64_t ent = slot.load(sc);
      for (;;) {
        if (cyc(ent) == h / n2_) {      // our lap: consume by setting index to bottom
          slot.fetch_or(bottom_, sc);
          return ent & bottom_;
        }
        if (cyc(ent) > h / n2_) break;  // slot already belongs to a later lap
        const std::uint64_t next = (ent & bottom_) == bottom_
            ? pack(h / n2_, (ent >> b_) & 1, bottom_)  // empty slot: bump its cycle
            : pack(cyc(ent), 0, ent & bottom_);        // old element: mark unsafe
        if (slot.compare_exchange_weak(ent, next, sc, sc)) break;
      }
      std::uint64_t t = tail_.load(sc);
      if (t <= h + 1) {  // head overtook tail: drag tail forward (catchup), report empty
        for (std::uint64_t hh = h + 1; !tail_.compare_exchange_weak(t, hh, sc, sc);) {
          hh = head_.load(sc);
          t = tail_.load(sc);
          if (t >= hh) break;
        }
        threshold_.fetch_sub(1, sc);
        return std::nullopt;
      }
      if (threshold_.fetch_sub(1, sc) <= 0) return std::nullopt;
    }
  }
};
int main() { ScqIndexRing r(4); r.enqueue(1); return r.dequeue() == 1u ? 0 : 1; }
```

- Queue = two rings (`free`, `used`) plus `T data[n]`: push takes an index from `free`, writes `data[i]`, enqueues `i` on `used`; pop mirrors. That wrapper passed a 3×3-thread TSan and ASan stress once, outside this repo; it is not in the gate.
- Simplified against the paper: no `Cache_Remap`, plain `<` on cycles (64-bit, never wraps in practice), `seq_cst` everywhere.
- Goes wrong: relaxing any ordering. The published proof assumes sequential consistency. Treat every weaker ordering as unproven until a weak-memory model checker passes.
- Goes wrong: polling an empty ring. Each failed `dequeue` writes `threshold_` and `head_`: empty polling is a contended write, unlike A.
- Goes wrong: a thread that stalls between taking an index from one ring and returning it to the other leaks that index (capacity shrinks by one until it resumes). Others keep going.
- Check: linearizability tester with a stalled thread; expect A to hang and C to finish.

## D. Segmented unbounded: LCRQ and LPRQ

Use for the unbounded variant only. I5 does not apply; allocation happens on segment change.

```text
queue = linked list of segments, each a small ring with its own head and tail
push: seg = tail_seg; try seg.push; on "closed": allocate next (or take a spare), CAS seg.next, CAS tail_seg, retry
pop:  seg = head_seg; try seg.pop;  on "empty and seg.next != null": CAS head_seg to next, retire seg, retry
close: a producer that fails too often, or finds the ring full, sets a closed bit in the segment tail
```

| Choice | LCRQ | LPRQ | Ring chain (hypothesis) |
|---|---|---|---|
| Segment | CRQ: FAA + CAS2 on a 16 B cell | PRQ: FAA + single-width CAS | Candidate A ring |
| Portability | needs `cmpxchg16b` or CASP | any 64-bit CAS | any |
| Segment progress | livelock-prone alone, closes | same | blocking |
| Whole queue | lock-free | lock-free | blocking pop on in-flight push |

- Reclamation is mandatory: a consumer may still read a segment another consumer just unlinked. Scheme and default: doc 06.
- Goes wrong: closing too eagerly wastes most of each segment (the SCQ paper measures LCRQ memory against LSCQ). Closing too lazily livelocks.
- Goes wrong: "ring chain" inherits A's stall: a preempted producer blocks the drain of its segment and all later ones.

## E. Sharded rings (relaxed FIFO)

Use when throughput matters more than cross-producer order. Never the default: it breaks the linearizable-queue contract.

- `k` rings. A producer handle sticks to one shard, so I2 (per-producer FIFO) holds. Consumers start at their own shard and scan.
- Loses: global order, exact empty (a scan is not atomic), fairness (a busy shard can starve a quiet one unless consumers rotate).
- Goes wrong: handles migrating between shards mid-stream reorder one producer's elements. Bind the shard for the handle's lifetime.

## Batch claims

| Ring | Batch claim of `n` | Catch |
|---|---|---|
| A | Not sound by checking one slot: slots are released out of order. Check all `n` sequences, then CAS tail by `n` | `n` acquire loads before the claim; partial batches when one slot lags |
| B | `fetch_add(n)`, then wait per slot | Debt of `n` tickets |
| Head/tail pair (DPDK) | CAS head by `n`, copy, publish tail in order | Contiguous by construction; ordered publish waits on preempted peers |
| SPSC | Free: compare against the cached opposite counter once | |

Consumer-side batching on A is cheaper to get right: claim `n` with one CAS only after seeing `seq == h+1` on each of the `n` slots. API shape: [04-api.md](04-api.md).

## Specialisations

Selected at compile time. Using the wrong one is undefined behaviour, so debug builds should assert the single-thread side.

| Variant | Producer side | Consumer side | Slot sequence | RMWs per op |
|---|---|---|---|---|
| MPMC (A) | CAS tail | CAS head | yes | 1 + 1 |
| MPSC | CAS tail | plain private head; release store of `seq` | yes | 1 + 0 |
| SPMC | plain private tail; release store of `seq` | CAS head | yes | 0 + 1 |
| SPSC | release store of tail; cached head | release store of head; cached tail | no | 0 + 0 |

- SPSC drops the sequence word: the two counters are the hand-off. The cached opposite counter turns most operations into zero shared reads.
- Goes wrong: an "SPSC" queue used from a thread pool where the producer role migrates without a happens-before between owners.

## Inline or indirect payload

| | Inline `T` in slot | Indirect (pointer or index) |
|---|---|---|
| Use when | `T` small, nothrow-movable | `T` large, non-movable, or variable size |
| Cost | one move in, one move out | allocation or pool, extra cache miss on pop |
| Slot size | `sizeof(T) + 8`, padded | 8 or 16 bytes: several per line, remap matters |
| Lock-free variants | not with C (entry must be one word) | required by C and D |
| Goes wrong | long copy inside the claimed window lengthens every stall | pool exhaustion becomes a second "full" condition |

## Decision

| Need | Choice | Status |
|---|---|---|
| Default bounded MPMC | A, `try_push` / `try_pop`, `false` means "not ready" | recommended |
| "Empty" must be exact | A-strict | opt-in |
| Blocking `push` / `pop` | B on the same ring, parking from doc 07 | opt-in |
| One side single-threaded | SPSC, MPSC, SPMC policies | opt-in, compile time |
| Survive stalled or killed threads | C (SCQ) | opt-in |
| Unbounded | D with LPRQ-style segments | opt-in, design open |
| Maximum throughput, order relaxed | E | opt-in, separate type |

Why A is the default: one contended RMW per side, the target in the vision; smallest state space to model-check; inline payload of any nothrow-movable `T`; every ordering already justified. What it gives up, stated in the public contract: lock-freedom and exact empty.

Experiments that could change this:

- A against C at 1 to 2× core count with oversubscription. If A's p99.99 collapses under preemption, C or an RTS-style publish moves up.
- A against A-strict on AArch64: cost of `seq_cst` CAS on the success path.
- B against A with 8 or more producers: FAA against CAS retries.
