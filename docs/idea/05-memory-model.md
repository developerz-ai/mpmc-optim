# Memory model

**Every atomic operation names its ordering and the edge it creates. Acquire/release for hand-off, relaxed for claims and guesses, `seq_cst` only for store-load (Dekker) patterns.** x86 hides a missing acquire or release; Arm, POWER and RISC-V do not. As of 2026-11.

Edge labels E1 to E8 refer to the default ring in [03-algorithms.md](03-algorithms.md).

## Orderings of the default ring

| Edge | Operation | Ordering | Why this, why not weaker or stronger |
|---|---|---|---|
| E1, E5 | `tail_.load` in push (and `head_.load` in pop) | relaxed | A guess. A stale value fails E2's comparison or E3's CAS. Nothing is read through it |
| E2 | `seq.load` in push | acquire | Pairs with E8. Brings the previous lap's move-out and destroy into happens-before, so constructing over the slot is race-free. Relaxed: data race on the element (I4) |
| E3, E7 | CAS on `tail_` / `head_` | relaxed, relaxed | Exclusivity comes from RMW atomicity: an RMW always reads the latest value in the modification order. No data is published through the counter. `seq_cst` only for A-strict |
| E4 | `seq.store(t+1)` in push | release | Publishes the constructed `T` to E6. Relaxed: consumer may read an unconstructed object (I3) |
| E6 | `seq.load` in pop | acquire | Pairs with E4 |
| E8 | `seq.store(h+cap)` in pop | release | Publishes "moved-out and destroyed" to E2 |
| ctor | `seq.store(i)` | relaxed | Handing the queue to another thread (thread start, mutex, another queue) supplies happens-before |
| dtor | all loads | relaxed | Caller guarantees quiescence |

Same pattern as Vyukov's original (relaxed counters, acquire/release sequence), verified against the archived source: [02-prior-art.md](02-prior-art.md).

Check: TSan on x86 validates the happens-before pairs because TSan tracks the C++ model, not the hardware. It does not explore weak-memory reorderings; a model checker does ([17-testing-and-verification.md](17-testing-and-verification.md)).

## Acquire/release versus `seq_cst`

- Acquire/release orders a writer before a reader of the **same** atomic.
- `seq_cst` adds a single total order over all `seq_cst` operations. Needed only when two threads each **store one variable, then load the other** and at least one must see the other's store.
- Rule: if the argument does not contain "store X, then load Y, while the peer stores Y, then loads X", `seq_cst` is not buying anything.

## Store-load (Dekker) patterns

Where they appear in a queue: sleep/wake ([07-waiting.md](07-waiting.md)), exact-empty checks (A-strict), close/shutdown flags, hazard pointers ([06-progress-and-reclamation.md](06-progress-and-reclamation.md)).

```cpp
// check: run
#include <atomic>
#include <cstdint>

std::atomic<std::uint64_t> tail{0};   // producer publishes here
std::atomic<bool> sleeping{false};    // consumer announces intent to sleep

// Consumer: store `sleeping`, then load `tail`.
bool consumer_may_sleep(std::uint64_t seen_tail) noexcept {
  sleeping.store(true, std::memory_order_seq_cst);          // store ...
  return tail.load(std::memory_order_seq_cst) == seen_tail; // ... then load. false: work arrived
}
// Producer: store `tail`, then load `sleeping`.
bool producer_must_wake(std::uint64_t new_tail) noexcept {
  tail.store(new_tail, std::memory_order_seq_cst);          // store ...
  return sleeping.load(std::memory_order_seq_cst);          // ... then load
}
// With seq_cst, "consumer sleeps" and "producer skips the wake" cannot both happen.
// With release/acquire both can: each load may run before the other thread's store is visible.
int main() { return consumer_may_sleep(0) && producer_must_wake(1) ? 0 : 1; }
```

- Wrong fix: `acq_rel` on both sides. Still no store-load ordering. Lost wakeup, on x86 too (store buffer).
- Cheaper correct forms: make the store an RMW (`exchange`, `fetch_add`) on x86, where any `lock`-prefixed instruction is a full barrier; or `store(relaxed)` plus `atomic_thread_fence(seq_cst)`.
- Mixing rule: the proof needs **both** stores and **both** loads `seq_cst` (or a `seq_cst` fence between each store and load). One relaxed access voids it.

## Fences and TSan

- `atomic_thread_fence(seq_cst)` between a store and a load is the portable full barrier. Compiled here: `lock or` on the stack (x86-64), `dmb ish` (AArch64), `fence rw,rw` (RISC-V), `sync` (POWER).
- GCC warns: `'atomic_thread_fence' is not supported with '-fsanitize=thread' [-Wtsan]` (observed, GCC 16). Clang 22 compiles it silently. Either way TSan does not model the fence: expect false positives or missed races.
- Rule: fence-based code gets a `seq_cst`-operation twin under a TSan build guard (`__SANITIZE_THREAD__` on GCC, `__has_feature(thread_sanitizer)` on Clang) or a model-checker proof. Never a TSan suppression.

## `memory_order::consume`

Do not use. [P3475R1](https://wg21.link/p3475r1) ("Defang and deprecate memory_order::consume", targeted at C++26) states that "All current compilers essentially map it to memory_order::acquire". Use acquire. Dependency ordering as hardware provides it (a load through a just-loaded pointer sees the pointee's initialisation on Arm and POWER) is not something portable C++ can rely on: publish pointers with release, read them with acquire.

## Hardware mapping

Produced with `clang -O2 -S` (clang 22) from `__atomic_*` builtins on a 64-bit object.

| Operation | x86-64 (TSO) | AArch64 v8.0 | AArch64 v8.1 LSE | RISC-V rv64gc | ppc64le |
|---|---|---|---|---|---|
| load relaxed | `mov` | `ldr` | `ldr` | `ld` | `ld` |
| load acquire | `mov` | `ldar` | `ldar` | `ld; fence r,rw` | `ld; cmp; bne; isync` |
| load `seq_cst` | `mov` | `ldar` | `ldar` | `fence rw,rw; ld; fence r,rw` | `sync; ld; cmp; bne; isync` |
| store relaxed | `mov` | `str` | `str` | `sd` | `std` |
| store release | `mov` | `stlr` | `stlr` | `fence rw,w; sd` | `lwsync; std` |
| store `seq_cst` | `xchg` | `stlr` | `stlr` | `fence rw,w; sd; fence rw,rw` | `sync; std` |
| `fetch_add` relaxed | `lock xadd` | `ldxr/stxr` loop | `ldadd` | `amoadd.d` | `ldarx/stdcx.` loop |
| `fetch_add` `seq_cst` | `lock xadd` | `ldaxr/stlxr` loop | `ldaddal` | `amoadd.d.aqrl` | `sync; ldarx/stdcx.; lwsync` |
| CAS relaxed | `lock cmpxchg` | `ldxr/stxr` | `cas` | `lr.d/sc.d` | `ldarx/stdcx.` |

What follows:

- x86-64: only a `seq_cst` **store** costs extra (`xchg`). Every RMW is already a full barrier, so relaxed versus `seq_cst` on E3 is free there and proves nothing about other targets.
- AArch64: `seq_cst` store and release store are the same instruction, as are the loads. Acquire/release discipline is cheap; the saving from relaxed is on RMWs (`ldadd` versus `ldaddal`).
- AArch64 v8.0 without LSE: `fetch_add` is an LL/SC loop and can retry under contention. FAA designs lose their "cannot fail" edge. Build with LSE or outline atomics ([21-build-and-toolchain.md](21-build-and-toolchain.md)).
- POWER and RISC-V: acquire and release each cost a barrier. Each needless one is paid.
- CAS on LL/SC targets: `compare_exchange_weak` may fail spuriously. Use weak in loops, strong only for one-shot attempts.

## `atomic_ref`, `wait`/`notify`

- `std::atomic_ref<T>` (C++20): atomic access to a plain object, for example a sequence word inside a slot that is also memcpy-initialised. Rules: object aligned to `atomic_ref<T>::required_alignment`; while any `atomic_ref` to it exists, **all** access goes through `atomic_ref`. One plain read is a data race.
- `atomic::wait(old)` blocks while the value equals `old`; `notify_one/all` wakes. The wait itself is the store-load pattern above: change the value, **then** notify. Notify before the store loses the wakeup.
- `wait` compares values: an A-B-A change between check and sleep can be missed. Use a monotonic word (a ticket or sequence), never a boolean that toggles.
- Cost and policy (spin, futex, eventcount): [07-waiting.md](07-waiting.md).

## Out-of-thin-air

The standard forbids relaxed loads from inventing values that justify themselves, but only by recommendation ([atomics.order]). Practical rule: no control or data dependency cycle through relaxed atomics. The default ring has none: relaxed values (E1, E5) are only compared, and every use is re-validated by a CAS.

## Wrong orderings that pass on x86

| Mistake | Interleaving that breaks it | Shows up |
|---|---|---|
| E4 relaxed | Consumer sees `seq == t+1` before the element's bytes: reads garbage | Arm, POWER, RISC-V; TSan reports it on x86 |
| E2 relaxed | Producer sees `seq == t` but not the consumer's move-out: constructs over a live object | same |
| E6 acquire kept, E4 on the **counter** instead of the slot | Publishing via `tail_` only orders tickets, not out-of-order slot writes: ticket `t+1` done, `t` not, consumer of `t` reads early | everywhere, rarely |
| Sleep flag with `acq_rel` | Both threads read the old value of the other's variable: consumer sleeps, producer skips wake | everywhere, x86 included |
| Reading the element before checking `seq` ("prefetch and inspect") | Racing plain read: undefined behaviour, compiler may reuse the stale value after the check | everywhere |
| `size = tail − head` used for a decision | Two relaxed loads at different times: negative or over `cap` | everywhere (I7) |
| `compare_exchange_strong` failure order stronger than needed, success weaker than the proof | A-strict with relaxed CAS: the fence-and-recheck no longer sits in the `seq_cst` total order | weak-memory targets |

## Litmus tests

Approach, not yet run in this repo (tools not installed on the authoring machine):

1. Reduce each claim to a litmus test of 2 to 3 threads: MP (message passing) for E4→E6 and E8→E2, SB (store buffering) for every Dekker pattern.
2. herd7 with the Arm, RISC-V and POWER models answers "can the hardware show the bad outcome" for the compiled mapping.
3. GenMC (RC11 and later models) or a comparable C/C++ checker answers the same for the source-level model, on a 2-slot ring with 2 producers and 2 consumers.
4. Each relaxed ordering gets a mutation test: weaken one edge, the checker must fail. An edge whose weakening passes is over-specified or untested.

Owner of tooling and CI wiring: [17-testing-and-verification.md](17-testing-and-verification.md).
