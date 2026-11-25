# ✅ Testing and verification

**A correctness claim needs a checker that fails when the code is wrong. Prove that with ordering mutation: weaken each `memory_order`, and some test or checker must fail.** Stress on x86 alone cannot kill those mutants.

As of 2026-11. Run here: the two snippets below, libFuzzer (Clang 22), the mutation loop. Model checkers, rr, QEMU were not installed: their rows cite docs.

## Layers

| Layer | Finds | Misses | Tier |
|---|---|---|---|
| `static_assert` / constexpr | Ticket math, wrap, layout, API constraints | Anything concurrent | compile |
| Unit, single thread | Full, empty, wrap, move-only, destructor counts (I6) | Races | PR |
| Differential fuzz (libFuzzer), property tests ([RapidCheck](https://github.com/emil-e/rapidcheck)) | Sequential logic against a `std::deque` model | Races | PR short, nightly long |
| Stress with oracle | I1, I2, I3 on real schedules | Rare schedules, weak memory on x86 | PR |
| TSan stress | Data races on executed schedules | Fences, weak-memory-only bugs ([16](16-sanitizers-and-valgrind.md#tsan)) | PR |
| Schedule exploration | Rare interleavings, deterministic replay | State explosion beyond 2-3 threads | nightly |
| Model checker | All executions of a small harness under a weak model | Large configurations | nightly |
| Arm hardware | Real weak-memory behaviour | Low probability per run | nightly |

## Compile-time tests

Use for everything that does not need a thread. Compile-fail cases go through a concept, so no build-system harness is needed.

```cpp
// check: compile
#include <concepts>
#include <cstdint>
#include <limits>
#include <memory>
#include <type_traits>
#include <utility>

// Ticket arithmetic under test. In the library these live in one header and are
// the only place that compares tickets.
constexpr std::uint64_t slot_index(std::uint64_t ticket, std::uint64_t capacity) noexcept {
  return ticket & (capacity - 1);
}
constexpr std::int64_t ticket_distance(std::uint64_t a, std::uint64_t b) noexcept {
  return static_cast<std::int64_t>(a - b);  // modular, then reinterpret: wrap-safe within 2^63
}

constexpr std::uint64_t max = std::numeric_limits<std::uint64_t>::max();
static_assert(slot_index(max, 8) == 7);
static_assert(slot_index(max + 1, 8) == 0);            // wraps to ticket 0
static_assert(ticket_distance(max + 3, max) == 3);     // ordering survives the wrap
static_assert(ticket_distance(max, max + 3) == -3);
static_assert(!(max + 3 > max));                       // the naive compare is wrong here

// Compile-fail tests without a build-system harness: assert that the misuse is ill-formed.
template <class T>
concept QueueElement = std::is_nothrow_move_constructible_v<T> && std::is_nothrow_destructible_v<T>;

template <QueueElement T>
struct Queue {
  Queue() = default;
  Queue(const Queue&) = delete;
  Queue& operator=(const Queue&) = delete;
  bool try_push(T&&) noexcept { return false; }
};

struct ThrowingMove {
  ThrowingMove(ThrowingMove&&) noexcept(false) {}
};
template <class T>
concept Instantiable = requires { typename Queue<T>; };

static_assert(Instantiable<std::unique_ptr<int>>);
static_assert(!Instantiable<ThrowingMove>);
static_assert(!std::copyable<Queue<int>>);

// A requires-expression outside a template is a hard error, not `false`: go through a concept.
template <class Q, class Arg>
concept CanPush = requires(Q q, Arg&& a) { q.try_push(std::forward<Arg>(a)); };
static_assert(CanPush<Queue<int>, int>);
static_assert(!CanPush<Queue<int>, const int&>);  // no silent copy of an lvalue
```

Also keep the three dangling/lock negative cases from [15](15-static-analysis.md#thread-safety-and-lifetime-annotations) as expected-diagnostic builds.

## Stress design

| Rule | Why |
|---|---|
| Item = (producer id, per-producer sequence) | Makes loss, duplication and reorder each detectable |
| Conservation: popped count == pushed count, queue empty at end | I1 |
| Checksum of all items in and out | Catches a torn or duplicated element that count alone hides |
| Each consumer checks that sequences from one producer only increase | I2. Sound: one consumer's pops are ordered in real time |
| Tiny capacity (2 to 8) and more threads than cores | Full, empty and lap paths run constantly; preemption inside the window |
| Start sequences and tickets 3 below 2^64 | Wrap is exercised in the first lap, not after centuries. Needs a test-only constructor taking the initial ticket |
| Non-trivial payload (`unique_ptr`, counted type) | ASan then sees double pop as double free, loss as leak |
| Fixed iteration count, seed printed | Reproducible; never time-bounded pass criteria |

```cpp
// check: run
// Stress oracle: conservation (I1), per-producer FIFO (I2), checksum. The queue is a
// mutex-backed stand-in; swap in the real one. Tickets start 3 below wrap.
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

struct Item {
  std::uint32_t producer;
  std::uint64_t seq;  // per-producer, strictly increasing
};

class StandInQueue {
 public:
  explicit StandInQueue(std::size_t capacity) : capacity_{capacity} {}
  [[nodiscard]] bool try_push(Item v) {
    const std::scoped_lock lock{m_};
    if (q_.size() == capacity_) { return false; }
    q_.push_back(v);
    return true;
  }
  [[nodiscard]] std::optional<Item> try_pop() {
    const std::scoped_lock lock{m_};
    if (q_.empty()) { return std::nullopt; }
    const Item v = q_.front();
    q_.pop_front();
    return v;
  }

 private:
  std::mutex m_;
  std::deque<Item> q_;
  std::size_t capacity_;
};

int main() {
  constexpr std::uint32_t producers = 3;
  constexpr std::uint32_t consumers = 3;
  constexpr std::uint64_t per_producer = 20'000;
  constexpr std::uint64_t first_seq = UINT64_MAX - 2;  // wraps after 3 items

  StandInQueue q{8};  // tiny capacity: full and empty paths run constantly
  std::atomic<std::uint64_t> popped{0};
  std::atomic<std::uint64_t> sum_in{0};
  std::atomic<std::uint64_t> sum_out{0};
  std::atomic<bool> fifo_ok{true};

  std::vector<std::jthread> threads;
  for (std::uint32_t p = 0; p < producers; ++p) {
    threads.emplace_back([&, p] {
      std::uint64_t local = 0;
      for (std::uint64_t i = 0; i < per_producer; ++i) {
        const Item it{p, first_seq + i};  // unsigned wrap is defined
        while (!q.try_push(it)) { std::this_thread::yield(); }
        local += it.seq * (p + 1U);
      }
      sum_in.fetch_add(local, std::memory_order_relaxed);  // joined before read
    });
  }
  for (std::uint32_t c = 0; c < consumers; ++c) {
    threads.emplace_back([&] {
      // Distance from first_seq of the last item seen from each producer, plus one.
      std::vector<std::uint64_t> next(producers, 0);
      std::uint64_t local = 0;
      while (popped.load(std::memory_order_relaxed) < producers * per_producer) {
        const auto it = q.try_pop();
        if (!it) { std::this_thread::yield(); continue; }
        const std::uint64_t dist = it->seq - first_seq;  // wrap-safe distance
        if (dist < next[it->producer]) { fifo_ok.store(false, std::memory_order_relaxed); }
        next[it->producer] = dist + 1;
        local += it->seq * (it->producer + 1U);
        popped.fetch_add(1, std::memory_order_relaxed);
      }
      sum_out.fetch_add(local, std::memory_order_relaxed);
    });
  }
  threads.clear();  // join all

  const bool conserved = popped.load(std::memory_order_relaxed) == producers * per_producer;
  const bool checksum = sum_in.load(std::memory_order_relaxed) == sum_out.load(std::memory_order_relaxed);
  const bool empty = !q.try_pop().has_value();
  const bool ok = conserved && checksum && empty && fifo_ok.load(std::memory_order_relaxed);
  std::printf("conserved=%d checksum=%d empty=%d fifo=%d\n", conserved, checksum, empty,
              fifo_ok.load(std::memory_order_relaxed));
  return ok ? 0 : 1;
}
```

Passes under ASan+UBSan and TSan with both compilers. How it goes wrong: an oracle that only checks the total sum passes a queue that swaps two elements.

## Fault injection

| Fault | How | Catches |
|---|---|---|
| Yield points | Test-only macro between every two atomic steps: random `yield` or 50 µs sleep, compiled out in release | Windows a fast machine never opens |
| Stalled thread | One producer sleeps after claiming a ticket, before the sequence store | Whether consumers block: the "mutex-free, not lock-free" property in [06](06-progress-and-reclamation.md) becomes a visible test result |
| Signals | `pthread_kill` with a handler that pushes or pops | Reentrancy; document the result in [04-api.md](04-api.md) |
| Oversubscription | 4x threads per core, `taskset` to one core | Preemption inside critical windows |
| Throwing constructor or move | Payload that throws on the Nth construction | Slot left claimed but empty; exception safety in [10](10-raii-and-lifetime.md) |
| Allocation failure | Failing allocator at construction | Constructor cleanup |

## Deterministic schedule testing

| Tool | Idea | Limit |
|---|---|---|
| [Relacy](https://github.com/dvyukov/relacy) | Header-only; replaces `std::atomic` with `rl::atomic`, runs random or exhaustive schedules, described as a verifier "for relaxed memory models" | Code must be templated on the atomics provider. Its `fakestd` header override "may not work as compilers and standard library implementations evolve" |
| [Loom](https://github.com/tokio-rs/loom), [Shuttle](https://github.com/awslabs/shuttle), [Coyote](https://github.com/microsoft/coyote) | Rust and .NET. Borrow the design: an atomics shim plus a controlled scheduler, exhaustive (Loom) or randomised (Shuttle) | No C++ port assumed. The shim is the same one Relacy needs: design it once ([11-cpp23-craft.md](11-cpp23-craft.md)) |
| PCT scheduling | Random priorities with d change points; probabilistic bound on finding depth-d bugs ([Burckhardt et al. 2010](https://doi.org/10.1145/1736020.1736040)) | Needs the same shim |
| [rr chaos mode](https://robert.ocallahan.org/2016/02/introducing-rr-chaos-mode.html) | `rr record -h`: random priorities and timeslices, then replay the failure exactly | rr runs threads one at a time; no weak-memory effects |

## Model checking

Harness rule: 2 producers, 2 consumers, capacity 2, 1 to 2 operations each, tickets starting near wrap. Bigger never finishes.

| Tool | Checks | Notes |
|---|---|---|
| [GenMC](https://github.com/MPI-SWS/genmc) | C/C++ via LLVM IR under SC, TSO, RA, RC11, IMM | First choice for the real code. Supports LLVM 19 to 22 per its README |
| [Nidhugg](https://github.com/nidhugg/nidhugg) | SC, TSO, PSO, POWER, ARM; pthreads | README: LLVM 8 to 19; ARM and POWER models unavailable from LLVM 15 |
| [Dartagnan](https://github.com/hernanponcedeleon/Dat3M) | Bounded; `.cat` models incl. `rc11`, `aarch64`; targets c11, tso, arm8, riscv, power | `dartagnan cat/rc11.cat --target=c11 harness.c`; result UNKNOWN means the bound was too small |
| CDSChecker | C++11 atomics ([Norris and Demsky 2013](https://doi.org/10.1145/2509136.2509514)) | Research code; prefer GenMC |
| [herd7 / litmus7](https://github.com/herd/herdtools7) | Litmus tests against a model (herd7) or on hardware (litmus7) | For the 4-line core of an ordering argument, not the queue |
| [TLA+ / PlusCal](https://lamport.azurewebsites.net/tla/tla.html), [Spin](https://spinroot.com/spin/whatispin.html) | Algorithm design under interleaving semantics: I1, I2, progress | No weak memory. Use before writing code ([03-algorithms.md](03-algorithms.md)) |
| [CBMC](https://www.cprover.org/cbmc/) | Bounded C/C++ verification | Sequential arithmetic proofs (wrap, index bounds) |

When NOT to: as a substitute for stress. Model checkers verify the harness you wrote, at the size you chose.

## Linearizability

- Definition: [Herlihy and Wing 1990](https://doi.org/10.1145/78969.78972). General checkers: Wing-Gong search ([1993](https://doi.org/10.1006/jpdc.1993.1015)), improved by [Lowe 2017](https://doi.org/10.1002/cpe.3928); tools [Porcupine](https://github.com/anishathalye/porcupine) (Go), [Lincheck](https://github.com/JetBrains/lincheck) (JVM). They take a timestamped history, so C++ can log and check offline.
- General checking is exponential in the worst case. Keep histories short (under about 20 operations per thread, hypothesis) and many.
- Cheap queue-specific checks cover most bugs: the stress oracle above, plus "a pop that returned empty must overlap no interval in which the queue was provably non-empty" from logged invoke/response timestamps.
- Pitfall: timestamps taken with a shared atomic counter add synchronisation that hides the bug. Use per-thread `rdtsc`-style clocks and treat near-ties as concurrent.

## Ordering mutation

1. For each `memory_order_X` site, generate mutants: `seq_cst` to `acq_rel`/`release`/`acquire`; `acq_rel` to `release`/`acquire`; `release`, `acquire` to `relaxed`.
2. Build and run the TSan stress and the model-checker harness on each mutant.
3. A surviving mutant means: the order was stronger than needed (weaken it, with a proof in [05-memory-model.md](05-memory-model.md)), or the checks are blind there (add a test).

Tried on the tool-test ring with a 30-line script and TSan: 4 sites, 4 mutants, all killed. Expect `seq_cst` to `acq_rel` mutants to survive TSan; only a model checker kills those. Generic mutation tools ([Mull](https://github.com/mull-project/mull)) have no memory-order operator; keep the script.

## Weak-memory hardware and QEMU

- x86 is TSO: a missing `acquire`/`release` usually still works. Run the stress tier on real AArch64 (CI runner or a small board).
- QEMU user-mode AArch64 on an x86 host does not help: the guest runs on the host's stronger ordering ([QEMU multi-thread TCG notes](https://www.qemu.org/docs/master/devel/multi-thread-tcg.html)). It tests the Arm build, not Arm memory behaviour.

## Coverage

`clang++ -fprofile-instr-generate -fcoverage-mapping` (`-fcoverage-mcdc` accepted on 22) or `g++ --coverage` (`-fcondition-coverage` accepted on 16). Line coverage of a retry loop says nothing about interleavings; use it only to find untested branches (full, closed, wrap).

## CI tiers

Budgets are targets.

| Tier | Trigger | Contents | Budget |
|---|---|---|---|
| 0 | every build | static asserts, compile-fail concepts | 0 extra |
| 1 | PR | unit, stress x {ASan+UBSan, TSan} x {GCC, Clang}, 30 s fuzz | 10 min |
| 2 | merge | + RTSan, Valgrind Memcheck and DHAT, oversubscribed stress | 30 min |
| 3 | nightly | GenMC harness, ordering mutation, 1 h fuzz, AArch64 stress, fault injection matrix | 3 h |
| 4 | release | all of the above with larger bounds, Relacy/PCT runs | 12 h |
