# 🛡️ Hardening

**Zero undefined behaviour is the budget; every deliberate exception is listed here with its check. Hardening flags are a consumer's choice: the library must be correct and warning-free with all of them on.**

As of 2026-11. Verified here: GCC 16.0.1, Clang 22.1.8, Ubuntu 24.04 userland, x86-64.

## UB budget

| Area | Rule | Check |
|---|---|---|
| Data races | None. Never read a slot before its sequence grants it, including speculative peeks | TSan, model checker ([17](17-testing-and-verification.md)) |
| Object lifetime in slot storage | `std::construct_at` / `std::destroy_at`; access through the pointer `construct_at` returned or `std::launder` ([10](10-raii-and-lifetime.md)) | ASan with poisoning, TySan |
| Type punning | Only `std::bit_cast` and `memcpy` | `-Wundefined-reinterpret-cast`, `-fsanitize=type` |
| Signed overflow | No signed arithmetic on tickets; the one signed value is a reinterpreted difference | UBSan |
| Invalid memory order | Never `load(release)`, `store(acquire)` | GCC `-Winvalid-memory-model` at `-O2` ([15](15-static-analysis.md)) |
| Alignment | Slots allocated with aligned new; no cast to a stricter type | UBSan `alignment` |

## Integer rules

| Rule | Reason |
|---|---|
| Tickets, sequences, capacity: `std::uint64_t`. No `int`, no `size_t` mixing | 32-bit `size_t` targets truncate silently |
| Order compare: `static_cast<std::int64_t>(a - b) < 0`, never `a < b` | `<` is wrong across the wrap. Valid while tickets differ by less than 2^63 |
| Index: `ticket & (capacity - 1)`; capacity validated power of two | A zero or non-power-of-two capacity makes the mask wrong, not slow |
| Size math: overflow-checked multiply before allocation | `capacity * sizeof(Slot)` wraps to a small allocation, then out-of-bounds writes |
| Narrowing only through one named helper | `-Wconversion` stays on without scattered casts |

```cpp
// check: run
#include <bit>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <limits>

enum class CapacityError : std::uint8_t { zero, not_power_of_two, too_large, bytes_overflow };

// Untrusted size in, validated capacity out. Every later index is `ticket & mask`.
constexpr std::expected<std::size_t, CapacityError> checked_bytes(std::uint64_t capacity,
                                                                  std::size_t slot_size,
                                                                  std::uint64_t max_capacity) {
  if (capacity == 0) { return std::unexpected{CapacityError::zero}; }
  if (!std::has_single_bit(capacity)) { return std::unexpected{CapacityError::not_power_of_two}; }
  if (capacity > max_capacity) { return std::unexpected{CapacityError::too_large}; }
  std::size_t bytes = 0;
  if (__builtin_mul_overflow(capacity, slot_size, &bytes)) {  // GCC and Clang; C++26 has ckd_mul
    return std::unexpected{CapacityError::bytes_overflow};
  }
  return bytes;
}

// Ticket order: subtract in unsigned, reinterpret as signed. Correct while the two
// tickets are less than 2^63 apart, which the capacity limit guarantees.
constexpr bool ticket_before(std::uint64_t a, std::uint64_t b) noexcept {
  return static_cast<std::int64_t>(a - b) < 0;
}

constexpr std::uint64_t umax = std::numeric_limits<std::uint64_t>::max();
static_assert(ticket_before(umax, umax + 2));  // across the wrap
static_assert(!ticket_before(umax + 2, umax));
static_assert(umax + 2 < umax);                // what `<` says: wrong

int main() {
  constexpr std::uint64_t limit = std::uint64_t{1} << 32;
  const bool ok = checked_bytes(1024, 64, limit).value() == 65536 &&
                  checked_bytes(0, 64, limit).error() == CapacityError::zero &&
                  checked_bytes(1000, 64, limit).error() == CapacityError::not_power_of_two &&
                  checked_bytes(std::uint64_t{1} << 40, 64, limit).error() == CapacityError::too_large &&
                  checked_bytes(std::uint64_t{1} << 62, 64, umax).error() == CapacityError::bytes_overflow;
  return ok ? 0 : 1;
}
```

Pitfall: `-fwrapv` and `-ftrapv` change signed semantics only. They neither fix nor detect an unsigned ticket compare.

## Compiler and linker hardening

Reference: [OpenSSF compiler hardening guide](https://best.openssf.org/Compiler-Hardening-Guides/Compiler-Options-Hardening-Guide-for-C-and-C++.html) (2026-08-20). "Hot path" is a hypothesis for a header-only ring of inlined atomics until [19-benchmarking.md](19-benchmarking.md) measures it.

| Option | GCC 16 | Clang 22 | Hot-path effect (hypothesis unless cited) |
|---|---|---|---|
| `-D_FORTIFY_SOURCE=3` | yes | yes | None unless push/pop call `memcpy` on unknown sizes. Needs optimisation |
| `-D_GLIBCXX_ASSERTIONS` | yes (verified: out-of-range `span[]` aborts with a message) | with libstdc++ | Guide: reported slowdowns "up to 6%". Zero if the hot path uses no checked container call |
| libc++ `_LIBCPP_HARDENING_MODE_FAST` | n/a | verified: traps (SIGILL) | [libc++ docs](https://libcxx.llvm.org/Hardening.html): fast is "intended to be used in production"; extensive needs benchmarking; debug is not for production. Does not change ABI |
| `-fstack-protector-strong` | yes | yes | Canary only in functions with arrays or address-taken locals; an inlined push has none |
| `-fstack-clash-protection` | yes | yes | Only large frames |
| `-fcf-protection=full` (CET: IBT + shadow stack) | yes | yes | Guide: "typically mild". One `endbr64` per indirect-call target; inlined code unaffected. Binaries here carry the IBT and SHSTK notes |
| `-mbranch-protection=standard` (BTI + PAC) | AArch64 only | AArch64 only | Rejected on x86-64 by both. Sign/authenticate on non-leaf function entry and exit |
| `-ftrivial-auto-var-init=zero` | yes | yes | Zeroes uninitialised locals: a stack buffer of elements in a batch pop is memset every call. Mark it `[[gnu::uninitialized]]` after review. `pattern` for test builds |
| `-fstrict-flex-arrays=3` | yes | yes | Guide: no significant cost |
| `-fPIE -pie`, `-Wl,-z,relro,-z,now`, `-Wl,-z,noexecstack` | yes | yes | Guide: negligible on 64-bit; `now` costs startup only |
| `-fsanitize=cfi` | no | needs `-flto` | Indirect calls only; the queue has none by design |
| `-fsanitize=shadow-call-stack` | "not supported in current platform" | AArch64/RISC-V in practice | See [docs](https://clang.llvm.org/docs/ShadowCallStack.html) |
| `-fhardened` | yes | **unknown argument** | Umbrella, see below |

`-fhardened` (GCC, GNU/Linux only): `-D_FORTIFY_SOURCE=3 -D_GLIBCXX_ASSERTIONS -ftrivial-auto-var-init=zero -fPIE -pie -Wl,-z,relro,-z,now -fstack-protector-strong -fstack-clash-protection -fcf-protection=full`; the list "may change between major releases" ([GCC docs](https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html)).

- Verified: on Ubuntu, plain `g++ -O2` already defines `_FORTIFY_SOURCE=3`, `__SSP_STRONG__`, `__CET__`, PIE. `-fhardened` there adds `_GLIBCXX_ASSERTIONS`, and prints `-Whardened`: "`_FORTIFY_SOURCE` is not enabled by `-fhardened` because it was specified in `-D` or `-U`". With `-Werror` that fails the build: add `-Wno-error=hardened`.
- Without optimisation `-fhardened` drops fortification and warns.
- Use explicit flags in presets ([21-build-and-toolchain.md](21-build-and-toolchain.md)) so GCC and Clang match; keep one `-fhardened` CI job.
- Check the result: `readelf -n` (IBT, SHSTK), `readelf -d` (`BIND_NOW`), `readelf -lW` (`GNU_RELRO`, non-executable `GNU_STACK`).

## Assertion levels and contracts

| Level | Checks | Default in |
|---|---|---|
| 0 | none | never shipped as default |
| 1 | Caller contract: capacity, handle belongs to this queue, no use after close | release |
| 2 | Internal invariants on the hot path: sequence/ticket relation, I4 window | debug, sanitizer and stress builds |

```cpp
// check: compile
#include <cstdint>
#include <cstdio>
#include <cstdlib>

// Level 0: none. 1: cheap preconditions (shipped default). 2: + invariants on the hot path.
#if !defined(MPMC_ASSERT_LEVEL)
#  define MPMC_ASSERT_LEVEL 1
#endif

namespace mpmc::detail {
[[noreturn, gnu::cold, gnu::noinline]] inline void assert_fail(const char* expr, const char* file,
                                                               int line) noexcept {
  std::fprintf(stderr, "mpmc: assertion failed: %s (%s:%d)\n", expr, file, line);
  std::abort();  // core dump keeps the ring for post-mortem
}
}  // namespace mpmc::detail

#define MPMC_CHECK_AT(level, expr)                                                   \
  (((level) <= MPMC_ASSERT_LEVEL) && !(expr)                                         \
       ? ::mpmc::detail::assert_fail(#expr, __FILE__, __LINE__)                      \
       : static_cast<void>(0))
#define MPMC_EXPECT(expr) MPMC_CHECK_AT(1, expr)   // caller broke the contract
#define MPMC_INVARIANT(expr) MPMC_CHECK_AT(2, expr)  // we broke our own

inline std::uint64_t mask_for(std::uint64_t capacity) noexcept {
  MPMC_EXPECT(capacity != 0 && (capacity & (capacity - 1)) == 0);
  return capacity - 1;
}
```

- Failure action: print, `abort()`. Never throw from push/pop (they are `noexcept`), never continue.
- C++26 contracts ([P2900](https://wg21.link/P2900)): GCC 16 accepts `pre`/`post`/`contract_assert` with `-std=c++26 -fcontracts` and `-fcontract-evaluation-semantic=ignore|observe|enforce|quick_enforce` (all four run here; `enforce` prints the predicate and terminates, `observe` continues). Clang 22 rejects the syntax. Stay on the macro until both compile it.
- Contract pitfalls: a by-value parameter named in `post` must be `const` (GCC error otherwise); `observe` continues into the UB the check guarded; predicates must have no side effects, and none may touch an atomic.

## Crash diagnostics

- Abort keeps a core with the ring intact. Document a gdb recipe: head, tail, each slot's sequence.
- Level-2 failure message prints ticket, slot index, sequence seen, sequence expected.
- Trap-mode UBSan in production is allowed ([16](16-sanitizers-and-valgrind.md#asan-lsan-ubsan)); keep frame pointers so the trap has a stack.

## Denial of service

| Vector | Rule |
|---|---|
| Untrusted capacity | Validate through the checked function above with an explicit maximum; return an error, never round up silently |
| Address-space reservation | Lazy commit means a huge capacity succeeds at construction and fails at first touch. Cap it, or prefault on request ([08](08-arenas-and-allocators.md)) |
| Unbounded variant | Needs a segment limit; without one a slow consumer is an out-of-memory |
| Spinning | Every wait loop has a bounded spin then parks ([07-waiting.md](07-waiting.md)) |
| Stalled producer | Blocks consumers in a ticket ring. State it in the API docs as blocking, not lock-free |

## API misuse resistance

- `[[nodiscard]]` on every `try_*` result; status as an enum class, not `bool` where three outcomes exist.
- Queue non-copyable, non-movable. Handles move-only, tied to their queue by a level-1 check.
- Element type constrained: nothrow move and nothrow destroy, enforced by concept ([17](17-testing-and-verification.md#compile-time-tests)).
- No implicit copy of lvalues into `try_push(T&&)`.
- `[[clang::lifetimebound]]` on anything returning a view ([15](15-static-analysis.md#thread-safety-and-lifetime-annotations)).
- `static_assert(std::atomic<T>::is_always_lock_free)` for each atomic type used.

## Supply chain

| Control | Rule |
|---|---|
| Actions | Pin every `uses:` to a full commit SHA; `permissions:` least privilege per job ([GitHub hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)). Lint with `actionlint` and [zizmor](https://docs.zizmor.sh/) (both installed here) |
| Dependencies | Header-only core has none. Test and bench dependencies pinned by commit hash, fetched in CI only |
| Provenance | Release archives with [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds); aim for [SLSA](https://slsa.dev/spec/v1.0/levels) build level 2 or higher |
| SBOM | SPDX or CycloneDX file per release, even if it lists only the toolchain |
| Reproducible builds | `SOURCE_DATE_EPOCH`, `-ffile-prefix-map`, no `__DATE__`/`__TIME__` ([reproducible-builds.org](https://reproducible-builds.org/docs/source-date-epoch/)). Check: build twice in different directories, compare hashes |
| Scorecard | Run [OpenSSF Scorecard](https://github.com/ossf/scorecard) weekly; fix findings or record why not |
| `SECURITY.md` | Private reporting channel, supported versions, response target ([GitHub docs](https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository)) |
| Source | GCC `-Wbidi-chars=any`; signed tags; branch protection with required checks |
