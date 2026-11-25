# 🔎 Static analysis

**Static analysis gates style, API misuse and ordinary memory bugs. It proves nothing about memory orderings.** No tool listed here models the C++ memory model; that job belongs to TSan ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)) and model checkers ([17-testing-and-verification.md](17-testing-and-verification.md)).

As of 2026-11. Every flag and config below was run on this toolchain: GCC 16.0.1 (20260315 trunk snapshot), Clang / clang-tidy / clang-query / clang-format 22.1.8, plus Clang 23.1.6 where noted. cppcheck, CodeQL, Coverity, PVS-Studio, Infer and include-what-you-use were **not installed**: their rows cite docs and are unverified here.

## What each layer can catch

| Bug class | Compiler warnings | clang-tidy | Custom matcher | Path-sensitive analyzers | Verdict |
|---|---|---|---|---|---|
| Bare atomic operator, defaulted `memory_order` | no (see pitfalls) | no stock check | **yes** | no | Gate with the matcher below |
| Invalid order for the operation (`load(release)`) | GCC `-Winvalid-memory-model`; Clang only with libc++ | no | possible | no | Build with both compilers |
| Wrong but valid order (`relaxed` where `acquire` is needed) | no | no | no | no | TSan, model checker, ordering mutation |
| Narrowing ticket to 32 bits | `-Wconversion`, `-Wshorten-64-to-32` | `bugprone-narrowing-conversions` | no | no | Gate |
| Use after move, dangling view | `-Wdangling`, lifetime safety | `bugprone-use-after-move`, `bugprone-dangling-handle` | no | partly | Gate, expect misses |
| Mutex misuse on the cold path | Clang `-Wthread-safety` | `concurrency-*` (libc calls only) | no | Infer RacerD (lock-based) | Annotate the wait path |
| Blocking or allocating call on the hot path | Clang `-Wfunction-effects` | no | no | no | `[[clang::nonblocking]]`, see [16](16-sanitizers-and-valgrind.md#rtsan-and-function-effects) |
| Raw pointer arithmetic outside the slot accessor | Clang `-Wunsafe-buffer-usage` | `cppcoreguidelines-pro-bounds-*` | no | no | Scoped opt-out |
| Leak, double free, null deref on error paths | some | `clang-analyzer-*` | no | yes | Nightly |

## Warning sets

Rule: `-Werror` in CI only, never in the installed CMake target (a new compiler must not break users). Mark the library's own headers `SYSTEM` for consumers.

Common to both (all accepted by GCC 16 and Clang 22):

```
-Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion -Wshadow -Wold-style-cast
-Wcast-qual -Wcast-align -Wnon-virtual-dtor -Woverloaded-virtual -Wnull-dereference
-Wdouble-promotion -Wformat=2 -Wimplicit-fallthrough -Wundef -Wextra-semi
-Wzero-as-null-pointer-constant -Wsuggest-override -Wswitch-enum -Wnrvo
```

| Flag | Why it earns its place here |
|---|---|
| `-Wconversion -Wsign-conversion` | Tickets are `uint64_t`; an `int` or `uint32_t` temporary is a wrap bug in waiting ([18-hardening.md](18-hardening.md#integer-rules)) |
| `-Wshadow` | A shadowed `head` or `tail` local reads the wrong counter and still compiles |
| `-Wold-style-cast -Wcast-qual -Wcast-align` | Slot storage is `std::byte`; every cast out of it must be visible and greppable |
| `-Wnull-dereference` | Segment chains: catches deref of a just-loaded possibly-null next pointer (needs `-O1` or higher on GCC) |
| `-Wundef` | A misspelt feature macro (`#if MPMC_HAVE_FUTEX`) silently selects the slow path |
| `-Wswitch-enum` | Push/pop status enums: a new enumerator must break every switch |

GCC only:

| Flag | Why |
|---|---|
| `-Winvalid-memory-model` (default on) | `load(memory_order_release)` and `store(memory_order_acquire)` are UB. Fires only after inlining: build with `-O1` or higher. Verified: fires on GCC 16 at `-O2`; Clang 22 with libstdc++ is silent |
| `-Wtsan` (default on) | "`atomic_thread_fence` is not supported with `-fsanitize=thread`". Verified. Do not silence; fix the test build |
| `-Winterference-size` (default on) | Warns when `hardware_destructive_interference_size` leaks into ABI. Policy lives in [09-cache-friendly-allocation.md](09-cache-friendly-allocation.md) |
| `-Wduplicated-cond -Wduplicated-branches -Wlogical-op` | Copy-paste between the push and pop paths |
| `-Wcast-align=strict` | Warns regardless of target alignment rules (plain `-Wcast-align` is silent on x86) |
| `-Wdangling-pointer=2 -Wuse-after-free=3 -Wdangling-reference` | Flow-based; need optimisation. Much weaker than Clang's: the three dangling cases in the test below produce 0 GCC diagnostics |
| `-Wplacement-new=2` | Slot construction is placement new; flags a too-small buffer |
| `-Whardened` | Tells you when `-fhardened` silently dropped an option ([18](18-hardening.md#compiler-and-linker-hardening)) |

Clang only:

| Flag | Why |
|---|---|
| `-Wthread-safety -Wthread-safety-beta` | Lock discipline on the wait path. `-Wthread-safety-negative` only if every function is annotated |
| `-Wdangling` (default on), lifetime safety flags | See [lifetime](#thread-safety-and-lifetime-annotations) |
| `-Wfunction-effects` | Compile-time half of the no-allocation proof |
| `-Wunsafe-buffer-usage` | See [buffer usage](#-wunsafe-buffer-usage) |
| `-Wshorten-64-to-32 -Wimplicit-int-conversion` | Finer than `-Wconversion` on ticket math |
| `-Wcomma -Wunreachable-code-aggressive -Wconditional-uninitialized` | Retry loops: dead branches and paths that skip an initialisation |
| `-Wover-aligned` | A slot aligned past what `operator new` guarantees without aligned new |
| `-Wundefined-reinterpret-cast -Wundefined-func-template` | Type punning out of slot storage; templates with no visible definition |
| `-Wexit-time-destructors -Wglobal-constructors` | A header-only queue must own no static state |

Do **not** gate on:

| Flag | Reason |
|---|---|
| `-Weverything` | Includes mutually contradictory groups (`-Wc++98-compat`, `-Wpre-c++20-compat`). Use it in a weekly non-blocking job to discover new warnings, then promote by name |
| `-Wpadded` | Fires on every deliberate cache-line pad. Useful once, by hand, to audit slot layout |
| `-Weffc++` | Style rules from 1992; flags correct member-init patterns |
| `-Wstrict-overflow=2..5` | Noise that depends on optimiser decisions; UBSan covers the real cases |

## clang-tidy

Full config. `clang-tidy --verify-config` passes on 22.1.8. Custom check names live outside `Checks:` because `--verify-config` in 22 and 23 rejects any `custom-*` name ("check glob 'custom-*' doesn't match any known check") even though the checks run; enable them on the command line.

```yaml
---
# clang-tidy 22. Verify: clang-tidy --verify-config
Checks: >
  -*,
  bugprone-*,
  cert-*,
  clang-analyzer-*,
  concurrency-*,
  cppcoreguidelines-*,
  misc-*,
  performance-*,
  portability-*,
  modernize-use-nodiscard,
  modernize-use-noexcept,
  modernize-use-override,
  modernize-use-constraints,
  modernize-avoid-c-style-cast,
  readability-implicit-bool-conversion,
  readability-redundant-casting,
  readability-misleading-indentation,
  readability-container-data-pointer,
  -bugprone-easily-swappable-parameters,
  -cppcoreguidelines-avoid-magic-numbers,
  -cppcoreguidelines-pro-bounds-pointer-arithmetic,
  -cppcoreguidelines-pro-bounds-constant-array-index,
  -cppcoreguidelines-pro-bounds-avoid-unchecked-container-access,
  -cppcoreguidelines-pro-type-reinterpret-cast,
  -cppcoreguidelines-pro-type-union-access,
  -cppcoreguidelines-owning-memory,
  -cppcoreguidelines-avoid-do-while,
  -cppcoreguidelines-macro-usage,
  -misc-non-private-member-variables-in-classes,
  -misc-no-recursion,
  -performance-enum-size,
  -clang-analyzer-optin.performance.Padding
WarningsAsErrors: '*'
HeaderFilterRegex: '(include|src|test|bench)/.*'
ExcludeHeaderFilterRegex: '(third_party|_deps|build)/.*'
FormatStyle: file
CheckOptions:
  bugprone-narrowing-conversions.PedanticMode: true
  bugprone-narrowing-conversions.WarnOnIntegerToFloatingPointNarrowingConversion: true
  bugprone-sizeof-expression.WarnOnSizeOfPointerToAggregate: true
  bugprone-unused-return-value.AllowCastToVoid: true
  bugprone-exception-escape.FunctionsThatShouldNotThrow: 'try_push,try_pop,push,pop,close'
  cppcoreguidelines-special-member-functions.AllowSoleDefaultDtor: true
  cppcoreguidelines-rvalue-reference-param-not-moved.IgnoreUnnamedParams: true
  misc-const-correctness.AnalyzeValues: true
  misc-const-correctness.WarnPointersAsValues: false
  misc-include-cleaner.IgnoreHeaders: 'bits/.*;__.*/.*'
  performance-move-const-arg.CheckTriviallyCopyableMove: false
  performance-unnecessary-value-param.AllowedTypes: 'std::memory_order'
CustomChecks:
  - Name: atomic-defaulted-order
    Query: |
      let AtomicClass cxxRecordDecl(matchesName("^::std::(__[0-9a-zA-Z_]+::)?(atomic|__atomic_base|atomic_flag|__atomic_flag_base|atomic_ref|__atomic_ref|__atomic_float)"))
      match cxxMemberCallExpr(callee(cxxMethodDecl(ofClass(AtomicClass), unless(cxxConversionDecl()))), hasAnyArgument(cxxDefaultArgExpr())).bind("call")
    Diagnostic:
      - BindName: call
        Message: 'atomic call relies on a defaulted memory_order (seq_cst); pass the order and comment the edge'
        Level: Warning
  - Name: atomic-implicit-load
    Query: |
      let AtomicClass cxxRecordDecl(matchesName("^::std::(__[0-9a-zA-Z_]+::)?(atomic|__atomic_base|atomic_flag|__atomic_flag_base|atomic_ref|__atomic_ref|__atomic_float)"))
      match cxxMemberCallExpr(callee(cxxConversionDecl(ofClass(AtomicClass)))).bind("conv")
    Diagnostic:
      - BindName: conv
        Message: 'implicit atomic load (seq_cst); call load(order)'
        Level: Warning
  - Name: atomic-operator
    Query: |
      let AtomicClass cxxRecordDecl(matchesName("^::std::(__[0-9a-zA-Z_]+::)?(atomic|__atomic_base|atomic_flag|__atomic_flag_base|atomic_ref|__atomic_ref|__atomic_float)"))
      match cxxOperatorCallExpr(callee(cxxMethodDecl(ofClass(AtomicClass)))).bind("op")
    Diagnostic:
      - BindName: op
        Message: 'atomic operator is a seq_cst RMW or store; call the named member with an order'
        Level: Warning
...
```

```bash
clang-tidy --verify-config                                    # config loads
run-clang-tidy -p build -quiet \
  -extra-arg=-std=c++23 --experimental-custom-checks -checks='custom-*'   # appended to Checks:
clang-tidy-diff.py -p1 -path build < <(git diff -U0 origin/main)          # PR: changed lines only
```

Group by group:

| Group | Keeps | Notes for lock-free code |
|---|---|---|
| `bugprone-*` | `use-after-move`, `narrowing-conversions`, `exception-escape`, `unused-return-value`, `sizeof-expression`, `implicit-widening-of-multiplication-result` | `exception-escape` is the static half of "push and pop are `noexcept`" |
| `cert-*` | `err33-c`, `err58-cpp`, `oop54-cpp`, `con36-c`, `con54-cpp` | The `con*` checks cover condition-variable spurious wakeups in [07-waiting.md](07-waiting.md) |
| `concurrency-*` | `mt-unsafe`, `thread-canceltype-asynchronous` | Only two checks exist in 22. They flag non-reentrant libc calls, not races |
| `cppcoreguidelines-*` | special members, `pro-type-*`, `rvalue-reference-param-not-moved`, `missing-std-forward`, `noexcept-move-operations` | Bounds and reinterpret checks are off: slot access is one audited function. Re-enable per directory outside `detail/` |
| `misc-*` | `include-cleaner`, `const-correctness`, `redundant-expression`, `use-internal-linkage` | `misc-include-cleaner` replaces include-what-you-use for most uses |
| `performance-*` | `move-const-arg`, `noexcept-move-constructor`, `unnecessary-value-param`, `trivially-destructible` | `performance-enum-size` off: status enums are sized for the ABI on purpose |
| `portability-*` | `simd-intrinsics`, `std-allocator-const`, `template-virtual-member-function` | Pair with the dispatch rules in [14-simd.md](14-simd.md) |
| `clang-analyzer-*` | `core.*`, `cplusplus.*` (`NewDelete`, `PlacementNew`, `Move`), `unix.BlockInCriticalSection` | `optin.performance.Padding` off: it reports the intentional pads |

When NOT to use clang-tidy: as the ordering review. It will pass a queue with every `acquire` replaced by `relaxed`.

## Custom check: ban bare atomics

CLAUDE.md rule "no bare atomic operation" enforced mechanically. Standalone query file for `clang-query`:

```
set bind-root true
set output diag
let AtomicClass cxxRecordDecl(matchesName("^::std::(__[0-9a-zA-Z_]+::)?(atomic|__atomic_base|atomic_flag|__atomic_flag_base|atomic_ref|__atomic_ref|__atomic_float)"))
match cxxMemberCallExpr(isExpansionInMainFile(), callee(cxxMethodDecl(ofClass(AtomicClass), unless(cxxConversionDecl()))), hasAnyArgument(cxxDefaultArgExpr()))
match cxxMemberCallExpr(isExpansionInMainFile(), callee(cxxConversionDecl(ofClass(AtomicClass))))
match cxxOperatorCallExpr(isExpansionInMainFile(), callee(cxxMethodDecl(ofClass(AtomicClass))))
```

```bash
clang-query-22 -f tools/bare-atomic.query src/file.cpp -- -std=c++23
```

Tested with clang-query 22.1.8 against libstdc++ 16 and libc++ 18: all 11 of these are matched and nothing in the explicit-order control function is.

| Matched | Form |
|---|---|
| `++head`, `head += 2`, `head = 5` | `cxxOperatorCallExpr` |
| `uint64_t v = head;` | implicit conversion: `cxxMemberCallExpr` on a `cxxConversionDecl` |
| `head.load()`, `.store(v)`, `.fetch_add(1)`, `.compare_exchange_weak(e, 1)`, `flag.test_and_set()`, `head.wait(0)`, `ptr.load()` | `cxxDefaultArgExpr` argument |

| Limit | Consequence |
|---|---|
| Single-order CAS `compare_exchange_weak(e, d, acq_rel)` is a separate overload, no default argument | Not matched. The failure order is derived (`acq_rel` becomes `acquire`). Decide the policy in [05-memory-model.md](05-memory-model.md); add `argumentCountIs(3)` on the CAS names to ban it |
| Free functions `std::atomic_load(&a)`, C `_Atomic`, `__atomic_*` builtins, `__sync_*` | Not matched. Ban with a `callExpr(callee(functionDecl(matchesName(...))))` query or the grep guard |
| `std::memory_order_seq_cst` written out | Not matched, by design: explicit is allowed if the comment justifies it |
| Custom checks are experimental in clang-tidy 22 | Needs `--experimental-custom-checks`; schema may change ([docs](https://clang.llvm.org/extra/clang-tidy/QueryBasedCustomChecks.html)) |
| Templates | Uninstantiated templates have dependent call expressions and do not match. Run on a TU that instantiates the queue |

Grep fallback when clang-query is absent (coarse, comment-blind, misses operators):

```bash
! grep -rnE '\.(load|store|exchange|fetch_(add|sub|and|or|xor)|test_and_set|clear|wait|compare_exchange_(weak|strong))\([^)]*\)' include/ \
    | grep -v 'memory_order'
```

Pitfall: Clang's `-Watomic-implicit-seq-cst` looks like the built-in answer. It covers C `_Atomic` only; verified silent on `std::atomic` in Clang 22.

## Thread-safety and lifetime annotations

When to use: every mutex on the cold path (waiter lists, segment free lists, close). When NOT: the lock-free core. Thread-safety analysis models capabilities, not atomics; annotating a ticket as a "lock" produces noise and no proof.

```cpp
// check: compile
#include <cstddef>
#include <mutex>
#include <span>
#include <vector>

#if defined(__clang__)
#  define MPMC_CAPABILITY(x) __attribute__((capability(x)))
#  define MPMC_SCOPED_CAPABILITY __attribute__((scoped_lockable))
#  define MPMC_GUARDED_BY(x) __attribute__((guarded_by(x)))
#  define MPMC_ACQUIRE(...) __attribute__((acquire_capability(__VA_ARGS__)))
#  define MPMC_RELEASE(...) __attribute__((release_capability(__VA_ARGS__)))
#  define MPMC_REQUIRES(...) __attribute__((requires_capability(__VA_ARGS__)))
#  define MPMC_EXCLUDES(...) __attribute__((locks_excluded(__VA_ARGS__)))
#  define MPMC_RETURN_CAPABILITY(x) __attribute__((lock_returned(x)))
#  define MPMC_LIFETIMEBOUND [[clang::lifetimebound]]
#else
#  define MPMC_CAPABILITY(x)
#  define MPMC_SCOPED_CAPABILITY
#  define MPMC_GUARDED_BY(x)
#  define MPMC_ACQUIRE(...)
#  define MPMC_RELEASE(...)
#  define MPMC_REQUIRES(...)
#  define MPMC_EXCLUDES(...)
#  define MPMC_RETURN_CAPABILITY(x)
#  define MPMC_LIFETIMEBOUND
#endif

// libstdc++'s std::mutex carries no annotations; wrap it. libc++ annotates its own
// when _LIBCPP_ENABLE_THREAD_SAFETY_ANNOTATIONS is defined.
class MPMC_CAPABILITY("mutex") Mutex {
 public:
  void lock() MPMC_ACQUIRE() { m_.lock(); }
  void unlock() MPMC_RELEASE() { m_.unlock(); }

 private:
  std::mutex m_;
};

class MPMC_SCOPED_CAPABILITY Guard {
 public:
  explicit Guard(Mutex& m) MPMC_ACQUIRE(m) : m_{m} { m_.lock(); }
  ~Guard() MPMC_RELEASE() { m_.unlock(); }
  Guard(const Guard&) = delete;
  Guard& operator=(const Guard&) = delete;

 private:
  Mutex& m_;
};

// Cold path only: the waiter list behind the lock-free ring.
class WaitList {
 public:
  void add(int id) MPMC_EXCLUDES(mu_) {
    const Guard g{mu_};
    add_locked(id);
  }
  // The returned view dies with *this; -Wdangling flags a temporary WaitList.
  [[nodiscard]] std::span<const int> unsafe_view() const MPMC_LIFETIMEBOUND MPMC_REQUIRES(mu_) {
    return ids_;
  }
  // Without lock_returned the analysis cannot tell that mutex() is mu_.
  Mutex& mutex() MPMC_RETURN_CAPABILITY(mu_) { return mu_; }

 private:
  void add_locked(int id) MPMC_REQUIRES(mu_) { ids_.push_back(id); }

  Mutex mu_;
  std::vector<int> ids_ MPMC_GUARDED_BY(mu_);
};

std::size_t count(WaitList& w) {
  const Guard g{w.mutex()};
  return w.unsafe_view().size();
}
```

Negative test run against this snippet (unlocked call; returning a view of a local; view of a temporary):

| Compiler | Flags | Caught |
|---|---|---|
| Clang 22.1.8 | `-Wthread-safety -Wdangling` | All three: `-Wthread-safety-analysis`, `-Wreturn-stack-address`, `-Wdangling` |
| Clang 22.1.8 | `-Xclang -fexperimental-lifetime-safety -Wexperimental-lifetime-safety` | Adds a flow-sensitive duplicate for the returned local |
| Clang 23.1.6 | `-Wlifetime-safety` | Adds `-Wlifetime-safety-return-stack-addr`, `-Wlifetime-safety-use-after-scope` |
| GCC 16 | `-Wdangling-reference -Wdangling-pointer=2` | None. GCC ignores `[[clang::lifetimebound]]` |

| Analysis | Status, as of 2026-11 | Use |
|---|---|---|
| [Thread safety analysis](https://clang.llvm.org/docs/ThreadSafetyAnalysis.html) | Stable. In 22, `ACQUIRED_BEFORE/AFTER` left beta and `-Wthread-safety-beta` gained alias analysis of capability pointers ([release notes](https://releases.llvm.org/22.1.0/tools/clang/docs/ReleaseNotes.html)) | Gate |
| `[[clang::lifetimebound]]`, `[[clang::lifetime_capture_by]]`, `-Wdangling*` | Stable, statement-local: sees a temporary dying at the end of the full expression, not a use three lines later | Gate. Annotate every accessor returning a view or reference into a handle or queue |
| [Lifetime safety analysis](https://clang.llvm.org/docs/LifetimeSafety.html) | Flow-sensitive, intra-procedural. Clang 22: behind `-Xclang -fexperimental-lifetime-safety`. Clang 23: `-Wlifetime-safety-permissive` (high confidence), `-Wlifetime-safety` (adds strict), `-Wlifetime-safety-experimental` (invalidation). The docs call it bug finding, not verification | Non-blocking job on Clang 23; promote `-permissive` once it is quiet |

How it goes wrong: `no_thread_safety_analysis` on one function silently unproves its callers; a `lifetimebound` on the wrong parameter produces false confidence, not errors. Check: keep the three negative cases above as a compile-fail test ([17](17-testing-and-verification.md#compile-time-tests)).

## -Wunsafe-buffer-usage

[Clang's safe buffers model](https://clang.llvm.org/docs/SafeBuffers.html): every raw pointer subscript and pointer arithmetic is a warning; hardened `std::span` and containers do the checking at run time.

- Use: whole library on, one opt-out. The slot accessor is the single place that turns `ticket & mask` into a reference:

```cpp
#pragma clang unsafe_buffer_usage begin
  return slots_[ticket & mask_];   // mask_ == capacity - 1, capacity checked at construction
#pragma clang unsafe_buffer_usage end
```

- Verified on 22: `slots[i]` reports "unsafe buffer access", `*(slots + 1)` reports "unsafe pointer arithmetic". Related groups that exist: `-Wunsafe-buffer-usage-in-container`, `-Wunsafe-buffer-usage-in-libc-call`.
- Do NOT replace the masked index with a checked `span` subscript on the hot path without measuring: the mask already proves the bound, and the check adds a compare and branch per operation ([19-benchmarking.md](19-benchmarking.md) decides).
- GCC has no equivalent. Guard the pragmas with `#if defined(__clang__)`.

## Other analyzers

| Tool | Finds here | Limits | Cost / verdict |
|---|---|---|---|
| GCC `-fanalyzer` | Little | The manual states it "is only suitable for use on C code in this release" ([GCC docs](https://gcc.gnu.org/onlinedocs/gcc/Static-Analyzer-Options.html)). No race checks; one signal check (`-Wanalyzer-unsafe-call-within-signal-handler`). Flag accepted by `g++` 16, so it runs, with template-heavy false positives | Weekly, non-blocking. Do not gate |
| Clang static analyzer (`scan-build-22`, or `clang-analyzer-*` in tidy) | Use-after-move, `PlacementNew`, leaks on error paths, `unix.BlockInCriticalSection` | Per-TU, path explosion in retry loops. Cross-TU needs `clang-extdef-mapping` | Already inside the tidy run |
| [cppcheck](https://cppcheck.sourceforge.io/manual.html) | Unused members, redundant conditions, some UB in non-template code | Own parser, weak on C++23 templates. Unverified here | Cheap. Non-blocking: `cppcheck --enable=warning,performance,portability --std=c++23 --inline-suppr --error-exitcode=1 -I include src` |
| [CodeQL](https://codeql.github.com/codeql-query-help/cpp/) | Dataflow: unchecked sizes reaching allocation, integer overflow in size math | Needs a traced build. No memory-order reasoning. Free for public repos | GitHub Action, `security-extended` suite, PR plus weekly |
| [Coverity Scan](https://scan.coverity.com/) | Deep interprocedural defects, some lock-based concurrency checkers | Closed, upload quota, results on a web dashboard | Free for open source. Weekly at most |
| [Infer RacerD](https://fbinfer.com/docs/checker-racerd) | Lock-consistency races in C++ | Its docs say it "avoids reasoning about weak memory"; lock-based only | Only if the wait path grows |
| [include-what-you-use](https://include-what-you-use.org/) / `misc-include-cleaner` | Missing and unused includes. Header-only libraries break users when they lean on transitive includes | IWYU must match the Clang version it was built against. `misc-include-cleaner` is in the tidy run; standalone `clang-include-cleaner-22` is installed | Gate via tidy |
| clang-format | Diff noise | `Standard:` accepts `c++20` and `Latest`; `c++23` is rejected by 22 (verified) | Gate: `clang-format --dry-run --Werror $(git ls-files '*.hpp' '*.cpp')` |

Minimal `.clang-format` (loads on 22.1.8): `BasedOnStyle: Google`, `Standard: c++20`, `ColumnLimit: 100`, `PointerAlignment: Left`, `QualifierAlignment: Left`, `InsertBraces: true`, `IncludeBlocks: Regroup`, `ReflowComments: false` (ordering comments must not be re-wrapped away from their line).

## Suppression policy

| Rule | Form |
|---|---|
| Narrowest scope | `// NOLINT(check-name): reason` on the line, or `NOLINTBEGIN(check)` / `NOLINTEND(check)` around a block. Never bare `NOLINT` |
| Reason required | Text after the colon, or an issue link. CI greps for a `NOLINT` with no check name and fails |
| Warnings | `#pragma GCC diagnostic push` / `ignored "-Wx"` / `pop` around the smallest block. No `-Wno-x` in the build files without a comment naming the reason |
| No file-level opt-outs | `// NOLINTBEGIN` at the top of a file is rejected in review |
| Unused suppressions | Monthly: run once with suppressions stripped and delete each one that no longer fires |
| Analyzer false positive | Prefer restructuring or an assertion the analyzer understands over a suppression |

## Baseline rules

- New repo: start at zero findings with the full set. No baseline file.
- Adding a check to an existing tree: fix everything in the same PR, or enable it for changed lines only (`clang-tidy-diff.py`) and open one tracking issue with the count. Close it within one roadmap phase.
- A baseline file may only shrink. CI compares counts and fails on growth.

## CI layout and cost

Targets, not measurements (no code yet). Template-heavy headers make tidy the slow step.

| Stage | Trigger | Jobs | Budget (target) |
|---|---|---|---|
| Format, config | every push | `clang-format --dry-run --Werror`, `clang-tidy --verify-config`, grep guards | under 1 min |
| Warnings | every push | GCC 16 and Clang 22, full sets, `-Werror`, `-O2` (flow warnings need optimisation), libstdc++ and libc++ | under 5 min |
| Tidy on diff | PR | `clang-tidy-diff.py` plus custom checks | under 5 min |
| Tidy full | merge to main, nightly | `run-clang-tidy -p build` all TUs, cached with ccache-style key on file hash plus config | under 20 min |
| CodeQL | PR and weekly | `security-extended` | under 30 min |
| Discovery | weekly, non-blocking | `-Weverything`, `-fanalyzer`, cppcheck, Clang 23 `-Wlifetime-safety`, next compiler snapshot | report only |

Build layout lives in [21-build-and-toolchain.md](21-build-and-toolchain.md).

## Pitfalls

- **A clean tidy run on a header-only library can mean nothing was analysed.** Templates are checked only where instantiated. Analyse the test TUs, and add one TU that instantiates each policy combination.
- **`HeaderFilterRegex` wrong means zero header diagnostics, silently.** Check: plant a `head++` in a header and confirm the run fails.
- **Clang with libstdc++ does not diagnose invalid memory orders; GCC does, but only when optimising.** One compiler at `-O0` is not coverage.
- **`std::atomic` of a 16-byte struct compiles without a warning and calls `__atomic_load_16`** (verified on both compilers without `-mcx16`): a libatomic call that may take a lock. Guard every atomic type with `static_assert(std::atomic<T>::is_always_lock_free)`.
- **`-Werror` plus `-fhardened` breaks on Ubuntu.** The distro GCC predefines `_FORTIFY_SOURCE`, so `-Whardened` fires ([18](18-hardening.md#compiler-and-linker-hardening)).
- **Thread-safety analysis is off in constructors and destructors** and does not follow aliases without `lock_returned` ([docs](https://clang.llvm.org/docs/ThreadSafetyAnalysis.html)). The snippet above failed until `mutex()` was annotated.
- **A matcher that passes on libstdc++ can miss libc++** (inline namespace `__1`, different base classes). The regex above covers both; rerun the 11-case test when either library is upgraded.
