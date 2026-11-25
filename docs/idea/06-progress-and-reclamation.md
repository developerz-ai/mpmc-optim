# Progress and reclamation

**The default bounded ring needs no reclamation and is not lock-free. Say "mutex-free". The unbounded variant needs reclamation; recommended default: hazard pointers held in the handle, one per side.** As of 2026-11.

## Progress, precisely

| Term | Definition | Test that falsifies it |
|---|---|---|
| Wait-free | Every call finishes in a bounded number of its own steps, whatever other threads do | Any retry loop without a helping bound |
| Lock-free | Among threads taking steps, some call finishes in a finite number of steps, even if any other thread stops forever | Suspend one thread at every program point; the rest must still complete operations |
| Obstruction-free | A thread running alone, from any reachable state, finishes | Suspend all but one thread at every point; it must finish |
| Blocking | None of the above | |

- A `false` return counts as finishing only if it is a correct answer. A `try_pop` that returns "not ready" while elements exist finishes the call but the **queue** makes no progress: classify by whether elements can still be delivered.
- Memory allocation inside an operation inherits the allocator's guarantee. Most allocators take locks.
- Lock-free does not mean fast or fair. One thread may starve forever.

## Which candidate satisfies what

Candidates from [03-algorithms.md](03-algorithms.md). Sources in [02-prior-art.md](02-prior-art.md).

| Candidate | Guarantee | Why |
|---|---|---|
| A, sequence ring with CAS | blocking, mutex-free | Producer stopped between claim and publish: consumers can never pass its ticket. Vyukov says the same of the original |
| A-strict | blocking | Additionally spins while an operation is in flight |
| B, FAA tickets | blocking | A ticket is an obligation; waiting loops are unbounded |
| C, SCQ | lock-free (author's proof, sequential consistency assumed) | A stalled thread's entry is skipped by cycle bump |
| wCQ | wait-free (authors' proof) | SCQ plus fast-path/slow-path helping; needs double-width CAS |
| D, LCRQ / LPRQ | lock-free, given lock-free reclamation and allocation | Starving ring is closed, new one appended |
| SPSC | wait-free | No loops, no RMW |
| Yang and Mellor-Crummey | claimed wait-free; reclamation can block (wCQ paper) | |

Check: the stalled-thread tests in [17-testing-and-verification.md](17-testing-and-verification.md). A claim without that test is "mutex-free".

## ABA

A CAS succeeds because the value is **equal**, not because nothing happened. Three places it bites a queue:

| Where | ABA | Defence here |
|---|---|---|
| Ticket counters | Counter wraps to the same value | 64-bit tickets: no wrap in practice |
| Slot sequence | Same slot index, different lap | Sequence carries the lap (`t`, `t+1`, `t+cap`) |
| Segment or node pointers | Freed address reused by a new node | Reclamation scheme below, or a tag |

## Tags and double-width CAS

| Technique | Use when | Goes wrong |
|---|---|---|
| Tagged index (index + counter in 64 bits) | Nodes live in an array or pool | Counter too narrow: wraps under a long stall. Size it from pool size and worst stall |
| Tagged pointer (counter in unused pointer bits) | 48-bit or 57-bit virtual addresses, 16 spare bits | 5-level paging, pointer authentication, memory tagging and CHERI take those bits. 16 bits wrap in 65 536 updates |
| Double-width CAS (`cmpxchg16b`, Arm LSE `CASP`) | Pointer + full 64-bit counter | See gotchas |

Double-width CAS gotchas, observed on this machine (x86-64, GCC 16 and Clang 22, `std::atomic` of a 16-byte aligned struct):

| Compiler and flags | `is_always_lock_free` | `is_lock_free()` | Code |
|---|---|---|---|
| g++ | false | false | calls libatomic |
| g++ `-mcx16` | false | false | still calls libatomic (which contains `cmpxchg16b`) |
| clang++ | false | false | calls libatomic |
| clang++ `-mcx16` | true | true | inline `lock cmpxchg16b` |

- Rule: `static_assert(std::atomic<X>::is_always_lock_free)` on every hot-path atomic. A 16-byte atomic fails it on GCC; the design must not need one in the default path.
- Mixing object files that disagree (inline in one, libatomic in another) is only safe if libatomic picks the lock-free path at run time. Do not rely on it.
- A 16-byte **load** is not one instruction with `cmpxchg16b` alone. Background: [GCC PR104688](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=104688).
- LPRQ and SCQ exist to avoid this instruction. Prefer them over CRQ and wCQ for portability.

```cpp
// check: run
#include <atomic>
#include <cstdint>

// Tagged index: 32-bit pool index + 32-bit version in one lock-free word.
struct TaggedIndex {
  std::uint64_t bits;
  static TaggedIndex make(std::uint32_t idx, std::uint32_t ver) noexcept {
    return {(std::uint64_t{ver} << 32) | idx};
  }
  std::uint32_t index() const noexcept { return static_cast<std::uint32_t>(bits); }
  std::uint32_t version() const noexcept { return static_cast<std::uint32_t>(bits >> 32); }
};
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);

// Swing `top` from `seen` to `next_idx`, bumping the version so a recycled index cannot match.
bool swing(std::atomic<std::uint64_t>& top, TaggedIndex seen, std::uint32_t next_idx) noexcept {
  const TaggedIndex want = TaggedIndex::make(next_idx, seen.version() + 1);
  // strong: one-shot attempt. acq_rel: publishes the new top and reads its predecessor's node.
  return top.compare_exchange_strong(seen.bits, want.bits, std::memory_order_acq_rel,
                                     std::memory_order_relaxed);
}

int main() {
  std::atomic<std::uint64_t> top{TaggedIndex::make(7, 0).bits};
  const TaggedIndex seen{top.load(std::memory_order_acquire)};
  if (!swing(top, seen, 3)) return 1;
  if (swing(top, seen, 9)) return 2;  // stale version must fail even if the index matched
  const TaggedIndex now{top.load(std::memory_order_acquire)};
  return now.index() == 3 && now.version() == 1 ? 0 : 3;
}
```

## Reclamation schemes

Problem: thread X reads pointer `p` from a shared location; thread Y unlinks and frees `*p`; X dereferences. A tag stops the bad CAS, not the bad read.

| Scheme | Reader cost per protected pointer | Unreclaimed memory if a thread stalls | Use when | Goes wrong |
|---|---|---|---|---|
| Never free (type-stable pool) | 0 | none, but high-water forever | Fixed pools, boost.lockfree style | Needs tags; memory never returns |
| Hazard pointers | store + store-load barrier + re-read | bounded: hazards × threads | Few pointers per operation, threads may stall | Forgetting the re-validate; barrier cost per traversal step |
| Epochs (EBR) | one store on enter, one on exit | **unbounded**: one stalled reader blocks all frees | Short operations, threads never block inside | Preempted reader in a critical section grows memory without limit |
| QSBR | near 0; threads announce quiescent states | unbounded | Threads with a natural idle point (event loops) | A thread that forgets to announce |
| RCU | as EBR or QSBR, by implementation | unbounded while a reader section is open | Read-mostly structures | Blocking inside a reader section |
| Hazard eras, interval-based | one store when the era changes | bounded by live intervals | Many pointers per operation | More complex; era counter contention |
| Reference counting | RMW on a shared count per access | none | Coarse objects | Count is a contended line; acquiring the count races with the free unless split or deferred |
| Deferred free at quiescence | 0 | until quiescence | Shutdown, or "free when no handles remain" | Never quiescent under load |

Standard library, C++26: hazard pointers ([P2530R3](https://wg21.link/p2530r3), `<hazard_pointer>`) and RCU ([P2545R4](https://wg21.link/p2545r4), `<rcu>`). Neither header exists in the libstdc++ (GCC 16) or libc++ (Clang 22) installed here: tested, `file not found`. Plan on an in-tree implementation behind the standard's names.

## Stalled threads and memory bounds

| Design | A thread stalls forever | Memory bound |
|---|---|---|
| Bounded ring A, B | Queue stops delivering past its ticket | Fixed at construction |
| SCQ | One index leaks until it resumes | Fixed |
| Unbounded + hazard pointers | Its 1 to 2 protected segments stay allocated | live elements + threads × protected segments |
| Unbounded + epochs | No segment is ever freed again | none |

## Default for the unbounded variant

Recommended, not yet measured:

- Hazard pointer **per handle side** (one for the head segment, one for the tail segment), kept across operations. Fast path: compare the cached segment pointer with the queue's (one acquire load). The store-load barrier is paid only when the segment changes, once per segment, not once per element. folly `UnboundedQueue` uses hazard pointers for the same job.
- Retired segments go to a small per-queue spare list first; freed only above a watermark. Allocation stays off the common path.
- Never follow `next` from a segment that is not protected **and** re-validated against the queue's pointer.
- Goes wrong: an idle handle pins one segment. Bound is handles × segment size; document it, and release on handle destruction (RAII: [10-raii-and-lifetime.md](10-raii-and-lifetime.md)).
- Opt-in alternative: epochs, for users who guarantee no thread blocks inside an operation.
- Alternative worth a prototype: crossbeam `SegQueue` frees blocks through per-slot `READ`/`DESTROY` bits with no global scheme.

Check: ASan leak check at shutdown; high-water test with one thread suspended mid-operation; model-check protect/validate/retire on a 2-segment chain.
