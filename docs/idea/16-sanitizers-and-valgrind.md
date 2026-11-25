# 🧪 Sanitizers and Valgrind

**Run every test under ASan+UBSan and under TSan, on both compilers. Valgrind adds Memcheck and allocation proof; its race detectors need annotations before they mean anything.** A clean run proves only that the executed interleavings were clean.

As of 2026-11. Verified here: Clang 22.1.8, GCC 16.0.1, Valgrind 3.22.0 (upstream is 3.28.0, [news](https://valgrind.org/docs/manual/dist.news.html)), x86-64 Zen 3. Counts below are observations from one tool-test ring (sequence-per-slot, 2 producers, 2 consumers), not benchmarks.

## Bug class x tool

D detects, P partly, - misses.

| Bug class | ASan | UBSan | TSan | MSan | Memcheck | Helgrind / DRD | RTSan | Model checker |
|---|---|---|---|---|---|---|---|---|
| Slot read outside its sequence window (I4), heap | P with manual poisoning | - | D if it races | - | P with `MAKE_MEM_NOACCESS` | - | - | D |
| Data race on the element | - | - | D on executed schedules | - | - | D after annotation | - | D |
| Too-weak order (`relaxed` for `acquire`) | - | - | D when it yields a race; never on x86 semantics alone | - | - | - | - | D |
| Missing `seq_cst` (store-buffer shape) | - | - | - | - | - | - | - | D |
| Fence-based synchronisation | - | - | false positive | - | - | false positive | - | D |
| Use after free, overflow, double destroy (I6) | D | - | - | - | D | - | - | - |
| Uninitialised read | - | - | - | D | D | - | - | - |
| Leak of remaining elements | D (LSan) | - | - | - | D | - | - | - |
| Signed overflow, bad shift, misaligned slot | - | D | - | - | - | - | - | - |
| Ticket wrap (unsigned, defined) | - | only `unsigned-integer-overflow`, noisy | - | - | - | - | - | test, see [17](17-testing-and-verification.md) |
| Allocation or lock on push/pop (I5) | - | - | - | - | DHAT counts | - | D | - |
| Lock-order inversion on the wait path | - | - | D | - | - | D | - | - |
| Strict-aliasing violation | - | - | - | - | - | - | - | TySan D (Clang) |

## Incompatible combinations

Verified by compiling with each pair.

| Combination | Result |
|---|---|
| ASan + UBSan, TSan + UBSan, MSan + UBSan, ASan + LSan | OK (LSan is inside ASan on Linux) |
| ASan + TSan, ASan + MSan, TSan + MSan, TSan + LSan, ASan + HWASan | Rejected by both compilers |
| RTSan + ASan, TSan or UBSan | Rejected by Clang 22. RTSan gets its own build |
| TySan + ASan | Rejected. TySan + UBSan OK |
| Any sanitizer + Valgrind | Do not. Run Valgrind on a plain `-O1 -g` build |
| GCC | No `memory`, `realtime`, `type`, `numerical`, `integer`, `implicit-conversion`, `-fsanitize-minimal-runtime` |

So the matrix is five builds: ASan+UBSan, TSan(+UBSan), MSan (Clang, instrumented libc++), RTSan (Clang), plain for Valgrind.

## ASan, LSan, UBSan

```bash
clang++ -std=c++23 -O1 -g -fno-omit-frame-pointer -fno-optimize-sibling-calls \
  -fsanitize=address,undefined,float-divide-by-zero,implicit-conversion,local-bounds,nullability \
  -fsanitize-address-use-after-scope -fno-sanitize-recover=all
g++ -std=c++23 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=address,undefined,float-divide-by-zero,float-cast-overflow,pointer-compare,pointer-subtract \
  -fno-sanitize-recover=all
ASAN_OPTIONS=detect_stack_use_after_return=1:strict_string_checks=1:detect_invalid_pointer_pairs=2:check_initialization_order=1:strict_init_order=1:detect_leaks=1
UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1
```

- ASan slowdown: "typical 2x" ([docs](https://clang.llvm.org/docs/AddressSanitizer.html)).
- **ASan sees nothing inside a pre-allocated ring**: all slots are one live heap block. Poison element storage when a slot is empty ([manual poisoning](https://github.com/google/sanitizers/wiki/AddressSanitizerManualPoisoning)); snippet below.
- `unsigned-integer-overflow` (Clang) flags intended ticket wrap. Leave it off, or scope with `__attribute__((no_sanitize("unsigned-integer-overflow")))` on the ticket helpers.
- Production trap mode: `-fsanitize=undefined -fsanitize-trap=undefined` (both compilers); Clang also `-fsanitize-minimal-runtime`. Clang 22 embeds the trap reason in debug info ([release notes](https://releases.llvm.org/22.1.0/tools/clang/docs/ReleaseNotes.html)). Cost on the hot path: measure per [19-benchmarking.md](19-benchmarking.md).
- `-fsanitize=object-size` does nothing at `-O0` (Clang warns).

## TSan

```bash
clang++ -std=c++23 -O1 -g -fsanitize=thread     # same flag for g++
TSAN_OPTIONS=halt_on_error=1:second_deadlock_stack=1:history_size=7:suppressions=tsan.supp
```

| Fact | Detail |
|---|---|
| Cost | "about 5x-15x" slowdown, "5x-10x" memory ([docs](https://clang.llvm.org/docs/ThreadSanitizer.html)) |
| Fences unsupported | A release-fence / acquire-fence handoff that is correct per the standard was reported as a race by both compilers (verified). GCC warns at compile time: `-Wtsan` |
| Fix for fences | Replace the fence pair in TSan builds with `__tsan_release(addr)` / `__tsan_acquire(addr)` from `<sanitizer/tsan_interface.h>`. Verified: report gone on both compilers |
| `history_size` | 0..7; larger keeps more past accesses so the second stack is not "failed to restore". Default reads 0 in this runtime |
| `second_deadlock_stack=1` | Both lock sites in a lock-order report |
| Suppressions | `race:Symbol`, `deadlock:`, `called_from_lib:` ([format](https://github.com/google/sanitizers/wiki/ThreadSanitizerSuppressions)). Each needs a comment and an issue |
| Debug knobs | `force_seq_cst_atomics=1`: if a failure disappears, an ordering is too weak. `report_atomic_races` (default on): atomic vs plain access to one word |
| Uninstrumented code | Everything must be built with `-fsanitize=thread`; static libc/libstdc++ unsupported ([docs](https://clang.llvm.org/docs/ThreadSanitizer.html)) |

How it goes wrong: TSan checks the schedule that ran, with sequentially consistent execution of each atomic. It cannot show a weak-memory reordering. Check it is alive: the ordering mutation in [17](17-testing-and-verification.md#ordering-mutation) must make it fail (all 4 mutants of the test ring were killed).

## MSan, HWASan, GWP-ASan

| Tool | Use | Limit |
|---|---|---|
| [MSan](https://clang.llvm.org/docs/MemorySanitizer.html) | Read of a slot's element before a push wrote it. `-fsanitize=memory -fsanitize-memory-track-origins=2`. "Typical slowdown 3x" | Clang only. Needs an [instrumented libc++](https://github.com/google/sanitizers/wiki/MemorySanitizerLibcxxHowTo): every uninstrumented library yields false positives. Not installed here: unverified |
| [HWASan](https://clang.llvm.org/docs/HardwareAssistedAddressSanitizerDesign.html) | Lower-memory ASan on AArch64 (TBI, MTE hardware) | On x86-64 it needs LAM; on this CPU the link failed. Run on Arm CI only |
| [GWP-ASan](https://llvm.org/docs/GwpAsan.html) | Sampled guard-page allocator for production | Samples heap allocations: a queue that allocates once is nearly invisible to it |
| `-fsanitize=type` (TySan) | Strict-aliasing bugs in slot storage casts. Verified: catches an `int` read of a `float` at `-O0` | Clang only; the same test was silent at `-O1` |
| CFI, shadow call stack | See [18-hardening.md](18-hardening.md) | CFI needs `-flto` |

## RTSan and function effects

Proof of I5 (no allocation, no lock on push/pop), two halves:

| Half | Flag | Verified behaviour |
|---|---|---|
| Compile time | `-Wfunction-effects` ([docs](https://clang.llvm.org/docs/FunctionEffectAnalysis.html)) | A `[[clang::nonblocking]]` function calling `vector::push_back` is rejected, with the call chain to the allocating function |
| Run time | `-fsanitize=realtime` ([docs](https://clang.llvm.org/docs/RealtimeSanitizer.html)) | Same function aborts: "Intercepted call to real-time unsafe function `malloc` in real-time context" |

```cpp
// check: compile
#include <atomic>
#include <cstdint>

#if defined(__clang__) && __has_cpp_attribute(clang::nonblocking)
#  define MPMC_NONBLOCKING [[clang::nonblocking]]
#else
#  define MPMC_NONBLOCKING
#endif

struct Counter {
  std::atomic<std::uint64_t> tail{0};

  // Compile time: -Wfunction-effects rejects a call to anything not provably nonblocking.
  // Run time: -fsanitize=realtime aborts on malloc, free, pthread_mutex_lock inside.
  [[nodiscard]] std::uint64_t claim() noexcept MPMC_NONBLOCKING {
    return tail.fetch_add(1, std::memory_order_relaxed);  // ticket only, no data published
  }
};
```

When NOT to: on the blocking `push`/`pop` that parks ([07-waiting.md](07-waiting.md)); mark those `[[clang::blocking]]`. Limit: RTSan sees intercepted libc calls, not a spin loop that never ends.

## Valgrind

Valgrind runs one thread at a time ("threaded apps never use more than one CPU simultaneously", [core manual](https://valgrind.org/docs/manual/manual-core.html)). Real parallel interleavings and weak-memory effects never happen under it.

| Tool | Command | Use | Limits |
|---|---|---|---|
| Memcheck | `valgrind --error-exitcode=9 --leak-check=full --show-leak-kinds=all --errors-for-leak-kinds=definite,possible --track-origins=yes ./t` | Uninitialised reads without an instrumented libc++; I6 leaks | Quick start says "20 to 30 times" slower. Test ring: 0 errors |
| Helgrind | `valgrind --tool=helgrind --error-exitcode=9 ./t` | Lock order and misuse on the wait path | "Slowdowns on the order of 100:1 are not unusual" ([manual](https://valgrind.org/docs/manual/hg-manual.html)) |
| DRD | `valgrind --tool=drd --error-exitcode=9 ./t` | Same, lower memory | "between 20 and 50 times slower" ([manual](https://valgrind.org/docs/manual/drd-manual.html)) |
| Cachegrind | `valgrind --tool=cachegrind --cache-sim=yes ./t` | Deterministic instruction counts for CI regression | Since 3.21 `--cache-sim=no` is the default: instruction counts only. The simulated cache is not your CPU's; use `perf` ([20-profiling.md](20-profiling.md)) |
| Callgrind | `valgrind --tool=callgrind --toggle-collect='*try_push*' ./t` | Instructions per push/pop, per call site | Serialised: no contention cost |
| DHAT | `valgrind --tool=dhat ./t` | Allocation proof: block count must not grow with operation count | Test ring: 18 blocks total, all from setup and threads |
| Massif | `valgrind --tool=massif --pages-as-heap=yes ./t` | Committed pages over time, for lazy commit ([08](08-arenas-and-allocators.md)) | Slow |

**Why Helgrind and DRD false-positive on C++ atomics.** They handle `LOCK`-prefixed instructions, and the Helgrind manual says primitives built from "atomic counters" give bogus results. On x86 an atomic load or store is a plain `mov`. Observed: the TSan-clean test ring gave 24,398 Helgrind errors and 154,754 DRD errors, all on the sequence word and the element; the CAS on head and tail was not reported.

Annotations that fix it (observed: 0 errors in both tools; dropping only the element annotations brought back about 8,000):

```cpp
// check: compile
#include <atomic>
#include <cstddef>
#include <cstdint>

#if __has_include(<valgrind/helgrind.h>) && __has_include(<valgrind/memcheck.h>) && defined(MPMC_VALGRIND)
#  include <valgrind/helgrind.h>
#  include <valgrind/memcheck.h>
#  define MPMC_HB_BEFORE(addr) ANNOTATE_HAPPENS_BEFORE(addr)
#  define MPMC_HB_AFTER(addr) ANNOTATE_HAPPENS_AFTER(addr)
#  define MPMC_RACE_UNCHECKED(addr, len) VALGRIND_HG_DISABLE_CHECKING(addr, len)
#  define MPMC_NOACCESS(addr, len) VALGRIND_MAKE_MEM_NOACCESS(addr, len)
#  define MPMC_UNDEFINED(addr, len) VALGRIND_MAKE_MEM_UNDEFINED(addr, len)
#elif defined(__SANITIZE_ADDRESS__)
#  include <sanitizer/asan_interface.h>
#  define MPMC_HB_BEFORE(addr) ((void)(addr))
#  define MPMC_HB_AFTER(addr) ((void)(addr))
#  define MPMC_RACE_UNCHECKED(addr, len) ((void)(addr), (void)(len))
#  define MPMC_NOACCESS(addr, len) ASAN_POISON_MEMORY_REGION(addr, len)
#  define MPMC_UNDEFINED(addr, len) ASAN_UNPOISON_MEMORY_REGION(addr, len)
#else
#  define MPMC_HB_BEFORE(addr) ((void)(addr))
#  define MPMC_HB_AFTER(addr) ((void)(addr))
#  define MPMC_RACE_UNCHECKED(addr, len) ((void)(addr), (void)(len))
#  define MPMC_NOACCESS(addr, len) ((void)(addr), (void)(len))
#  define MPMC_UNDEFINED(addr, len) ((void)(addr), (void)(len))
#endif

struct Slot {
  std::atomic<std::uint64_t> sequence;
  alignas(std::uint64_t) std::byte storage[sizeof(std::uint64_t)];
};

// Construction: the sequence word is atomic, so exclude it from Helgrind/DRD;
// the element bytes are off limits until a producer owns the slot (I4).
inline void slot_init(Slot& s, std::uint64_t ticket) {
  s.sequence.store(ticket, std::memory_order_relaxed);  // not yet shared
  MPMC_RACE_UNCHECKED(&s.sequence, sizeof s.sequence);
  MPMC_NOACCESS(&s.storage, sizeof s.storage);
}

// Producer, after winning the ticket and before writing the element.
inline void slot_open_for_write(Slot& s) {
  MPMC_HB_AFTER(&s.sequence);  // pairs with the consumer's release store
  MPMC_UNDEFINED(&s.storage, sizeof s.storage);
}

// Producer, after writing the element and before the release store of the sequence.
inline void slot_publish(Slot& s) { MPMC_HB_BEFORE(&s.storage); }

// Consumer, after the acquire load that granted the slot.
inline void slot_open_for_read(Slot& s) { MPMC_HB_AFTER(&s.storage); }

// Consumer, after moving the element out and destroying it.
inline void slot_retire(Slot& s) {
  MPMC_NOACCESS(&s.storage, sizeof s.storage);
  MPMC_HB_BEFORE(&s.sequence);
}
```

| Valgrind fact | Detail |
|---|---|
| Annotations assert, they do not check | A wrong `HAPPENS_BEFORE` hides a real race. Helgrind and DRD stay a wait-path tool; TSan is the race gate |
| Arena allocators | `VALGRIND_CREATE_MEMPOOL` / `MEMPOOL_ALLOC` / `MEMPOOL_FREE` ([client requests](https://valgrind.org/docs/manual/mc-manual.html)) so Memcheck sees per-object lifetimes inside one mapping |
| Scheduling | `--fair-sched=yes` (default `no`) round-robins ready threads; without it one thread can run a whole quantum (`--scheduling-quantum`, default 100000 blocks) and the test degenerates to sequential |
| AVX-512 | Not upstream: [bug 383010](https://bugs.kde.org/show_bug.cgi?id=383010) is still open with patches attached. An AVX-512 build dies with an unhandled instruction; run Valgrind on an AVX2-or-lower build ([14-simd.md](14-simd.md)) |
| Valgrind beats ASan when | No rebuild possible; uninitialised reads without an MSan libc++; allocation counting (DHAT); deterministic instruction counts |
| ASan beats Valgrind when | Stack and global overflows; speed; real parallel execution |

## Open points

- MSan and libc++ hardening under TSan need an instrumented libc++ 22 in CI ([21-build-and-toolchain.md](21-build-and-toolchain.md)).
