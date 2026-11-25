# 🛠️ Build and toolchain

**One preset per job, flags stated in the preset, nothing implied by the host.** A build that differs from the preset is a different program; say so next to any number it produced.

As of 2026-11. Checked on CMake 3.28.3, Ninja 1.11.1, Clang 22.1, GCC 16 (trunk), ccache 4.9.1, x86-64 Linux. Benchmark method: [19-benchmarking.md](19-benchmarking.md). Sanitizer semantics: [16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md). Hardening flags: [18-hardening.md](18-hardening.md).

## Rules

- Core is header-only: an `INTERFACE` target. Flags below build tests and benchmarks; NEVER export them to consumers.
- The library MUST compile with `-fno-exceptions -fno-rtti` and with both libstdc++ and libc++ ([04-api.md](04-api.md)).
- `-ffast-math` is forbidden. Nothing in a queue needs it, and it changes semantics for every consumer TU it leaks into.
- Never `-march=native` in a published result. State a level (`x86-64-v3`) so others can reproduce.
- One sanitizer family per build. ASan+UBSan combine; TSan and MSan do not combine with ASan.
- PGO/BOLT results are reported next to the plain `bench` result, never instead of it.

## CMakePresets.json

Copy to the repo root. Validated: parses, every preset lists, and all presets except `msan` configured and built a probe target (`msan` needs an instrumented libc++, which the box lacks).

```json
{
  "version": 6,
  "cmakeMinimumRequired": { "major": 3, "minor": 25, "patch": 0 },
  "configurePresets": [
    { "name": "base", "hidden": true, "generator": "Ninja",
      "binaryDir": "${sourceDir}/build/${presetName}",
      "environment": {
        "DBG": "-g -fno-omit-frame-pointer",
        "REL": "-g -fno-omit-frame-pointer -fno-semantic-interposition -fvisibility=hidden -fvisibility-inlines-hidden -ffunction-sections -fdata-sections -flto=thin",
        "LLD": "-fuse-ld=lld -Wl,--gc-sections -Wl,--icf=safe -Wl,--thinlto-cache-dir=${sourceDir}/build/thinlto-cache",
        "PGO": "${sourceDir}/build/pgo"
      },
      "cacheVariables": {
        "CMAKE_CXX_STANDARD": "23", "CMAKE_CXX_STANDARD_REQUIRED": "ON", "CMAKE_CXX_EXTENSIONS": "OFF",
        "CMAKE_EXPORT_COMPILE_COMMANDS": "ON",
        "CMAKE_CXX_COMPILER_LAUNCHER": "ccache",
        "CMAKE_JOB_POOLS": "link=2", "CMAKE_JOB_POOL_LINK": "link"
      } },
    { "name": "clang", "hidden": true, "inherits": "base",
      "cacheVariables": { "CMAKE_CXX_COMPILER": "clang++", "CMAKE_BUILD_TYPE": "RelWithDebInfo",
        "CMAKE_EXE_LINKER_FLAGS": "-fuse-ld=lld", "CMAKE_SHARED_LINKER_FLAGS": "-fuse-ld=lld" } },

    { "name": "dev", "inherits": "base", "displayName": "Debug, libstdc++ assertions, mold",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "Debug",
        "CMAKE_CXX_FLAGS": "-Og $env{DBG} -D_GLIBCXX_ASSERTIONS",
        "CMAKE_EXE_LINKER_FLAGS": "-fuse-ld=mold", "CMAKE_SHARED_LINKER_FLAGS": "-fuse-ld=mold" } },
    { "name": "asan-ubsan", "inherits": "clang",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "-O1 $env{DBG} -fno-optimize-sibling-calls -fsanitize=address,undefined -fno-sanitize-recover=all" } },
    { "name": "tsan", "inherits": "clang",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "-O1 $env{DBG} -fsanitize=thread" } },
    { "name": "msan", "inherits": "clang", "displayName": "Needs MSan-instrumented libc++ in $MPMC_MSAN_LIBCXX",
      "cacheVariables": {
        "CMAKE_CXX_FLAGS": "-O1 $env{DBG} -fsanitize=memory -fsanitize-memory-track-origins=2 -nostdinc++ -isystem $env{MPMC_MSAN_LIBCXX}/include/c++/v1",
        "CMAKE_EXE_LINKER_FLAGS": "-fuse-ld=lld -nostdlib++ -L$env{MPMC_MSAN_LIBCXX}/lib -Wl,-rpath,$env{MPMC_MSAN_LIBCXX}/lib -lc++ -lc++abi" } },
    { "name": "rtsan", "inherits": "clang", "displayName": "RealtimeSanitizer, Clang 20+",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "-O1 $env{DBG} -fsanitize=realtime" } },
    { "name": "valgrind", "inherits": "base", "displayName": "Baseline ISA, no sanitizer",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "RelWithDebInfo", "CMAKE_CXX_FLAGS": "-O1 $env{DBG} -march=x86-64" } },
    { "name": "coverage", "inherits": "clang",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "Debug", "CMAKE_CXX_FLAGS": "-O0 -g -fprofile-instr-generate -fcoverage-mapping" } },

    { "name": "release", "inherits": "clang",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "Release", "CMAKE_CXX_FLAGS": "$env{REL}", "CMAKE_EXE_LINKER_FLAGS": "$env{LLD}" } },
    { "name": "bench", "inherits": "release", "displayName": "Release at a stated ISA level",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "$env{REL} -march=x86-64-v3", "MPMC_BUILD_BENCHMARKS": "ON" } },
    { "name": "pgo-gen", "inherits": "bench",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "$env{REL} -march=x86-64-v3 -fprofile-generate=$env{PGO}/raw -fprofile-update=atomic" } },
    { "name": "pgo-use", "inherits": "bench",
      "cacheVariables": { "CMAKE_CXX_FLAGS": "$env{REL} -march=x86-64-v3 -fprofile-use=$env{PGO}/merged.profdata -Werror=profile-instr-out-of-date -Werror=profile-instr-unprofiled" } },
    { "name": "bolt", "inherits": "pgo-use", "displayName": "pgo-use, relocations kept for llvm-bolt",
      "cacheVariables": { "CMAKE_EXE_LINKER_FLAGS": "$env{LLD} -Wl,--emit-relocs" } }
  ],
  "buildPresets": [
    { "name": "dev", "configurePreset": "dev" }, { "name": "asan-ubsan", "configurePreset": "asan-ubsan" },
    { "name": "tsan", "configurePreset": "tsan" }, { "name": "msan", "configurePreset": "msan" },
    { "name": "rtsan", "configurePreset": "rtsan" }, { "name": "valgrind", "configurePreset": "valgrind" },
    { "name": "coverage", "configurePreset": "coverage" }, { "name": "release", "configurePreset": "release" },
    { "name": "bench", "configurePreset": "bench" }, { "name": "pgo-gen", "configurePreset": "pgo-gen" },
    { "name": "pgo-use", "configurePreset": "pgo-use" }, { "name": "bolt", "configurePreset": "bolt" }
  ],
  "testPresets": [
    { "name": "t", "hidden": true, "output": { "outputOnFailure": true }, "execution": { "timeout": 300 } },
    { "name": "dev", "inherits": "t", "configurePreset": "dev" },
    { "name": "release", "inherits": "t", "configurePreset": "release" },
    { "name": "asan-ubsan", "inherits": "t", "configurePreset": "asan-ubsan",
      "environment": { "ASAN_OPTIONS": "detect_stack_use_after_return=1:strict_string_checks=1",
                       "UBSAN_OPTIONS": "print_stacktrace=1:halt_on_error=1" } },
    { "name": "tsan", "inherits": "t", "configurePreset": "tsan",
      "environment": { "TSAN_OPTIONS": "halt_on_error=1:second_deadlock_stack=1:history_size=7" } },
    { "name": "msan", "inherits": "t", "configurePreset": "msan", "environment": { "MSAN_OPTIONS": "halt_on_error=1" } },
    { "name": "rtsan", "inherits": "t", "configurePreset": "rtsan", "environment": { "RTSAN_OPTIONS": "halt_on_error=1" } },
    { "name": "coverage", "inherits": "t", "configurePreset": "coverage",
      "environment": { "LLVM_PROFILE_FILE": "${sourceDir}/build/coverage/raw/%p-%m.profraw" } }
  ]
}
```

| Preset | Use | Notes |
|---|---|---|
| `dev` | edit-compile-test | Host compiler, `mold` link |
| `asan-ubsan`, `tsan`, `msan`, `rtsan` | the correctness gate | `rtsan` needs Clang 20+ ([RealtimeSanitizer](https://clang.llvm.org/docs/RealtimeSanitizer.html)) |
| `valgrind` | Memcheck, Helgrind, DRD, Cachegrind | Baseline `-march=x86-64` so Valgrind sees no instruction it cannot decode |
| `release`, `bench` | measurements | `bench` adds a stated ISA level |
| `pgo-gen` → `pgo-use` → `bolt` | profile-guided builds | Clang only as written |
| `coverage` | source coverage | `llvm-profdata merge` then `llvm-cov report` |

Pitfalls:

- `CMAKE_BUILD_TYPE=Release` adds `-O3 -DNDEBUG`; `RelWithDebInfo` adds `-O2 -g -DNDEBUG`. Checked in `compile_commands.json`. The preset's `-O1` wins only because user flags come first and CMake's come last: for `RelWithDebInfo` sanitizer presets the effective level is `-O2`. If `-O1` matters, set `CMAKE_CXX_FLAGS_RELWITHDEBINFO` too.
- `NDEBUG` MUST NOT change layout ([04-api.md](04-api.md)).
- `CMAKE_LINKER_TYPE` is CMake 3.29+. On 3.28 use `-fuse-ld=` as here.
- `$env{DBG}`-style macros are defined in the preset's own `environment`; a child preset that overrides `CMAKE_CXX_FLAGS` replaces the whole string, it does not append.
- Flags in `CMAKE_CXX_FLAGS` apply to fetched dependencies as well. Good for sanitizers (everything must be instrumented), bad for `-Werror`.

## PGO and BOLT pipeline

```bash
cmake --preset pgo-gen && cmake --build --preset pgo-gen
./build/pgo-gen/<bench> <representative args>            # writes build/pgo/raw/*.profraw
llvm-profdata merge -o build/pgo/merged.profdata build/pgo/raw
cmake --preset pgo-use && cmake --build --preset pgo-use
cmake --preset bolt && cmake --build --preset bolt       # same, linked with --emit-relocs
perf record -e cycles:u -j any,u -o perf.data -- ./build/bolt/<bench> <args>
perf2bolt -p perf.data -o perf.fdata ./build/bolt/<bench>
llvm-bolt ./build/bolt/<bench> -o <bench>.bolt -data=perf.fdata -reorder-blocks=ext-tsp \
          -reorder-functions=cdsort -split-functions -split-all-cold -dyno-stats
```

BOLT commands are from the [BOLT README](https://github.com/llvm/llvm-project/blob/main/bolt/README.md); `llvm-bolt` is not installed on the checked box, so that half is unrun.

| Technique | When | When not | How it goes wrong | Check |
|---|---|---|---|---|
| Instrumented PGO | Final benchmark and shipped binaries of *applications* | A header-only library cannot ship a profile; consumers run their own | Counters are racy by default and lose counts under exactly the contention we care about: use `-fprofile-update=atomic` (accepted by Clang 22 and GCC 16). Profile from one workload overfits one matrix cell | `-Werror=profile-instr-out-of-date`; compare against plain `bench` on cells the profile never saw |
| Sample PGO (AutoFDO) | Profile from production-like runs without an instrumented build | No branch-stack support on the CPU ([20-profiling.md](20-profiling.md)) | Stale profile after refactors | Same |
| BOLT | After PGO, for code layout | Tiny hot paths that already fit a few lines: expect little | GCC builds need `-fno-reorder-blocks-and-partition`; needs `--emit-relocs`; needs LBR-style samples or `-instrument` | `-dyno-stats` output, then the benchmark |
| ThinLTO | Default for release | Never for sanitizer builds that are slow enough already | Cache dir grows without bound; prune it (`--thinlto-cache-policy`) | Link time, cache hit on rebuild (checked: cache files written) |
| Full LTO | Only if ThinLTO measurably loses | Day-to-day | Serial link, memory | Measure |

A header-only queue inlines into the caller, so LTO and PGO matter for the *benchmark harness and consumers*, not for a library object. Do not credit the queue with a PGO gain.

## ccache and sccache

`CMAKE_CXX_COMPILER_LAUNCHER=ccache` is set in `base`. For sccache replace the value; do not stack both.

| Setting | Value | Why |
|---|---|---|
| `compiler_check` | `content` in CI, default (`mtime`) locally | CI images restore compilers with fresh mtimes, so every run would miss. Never `none`: a compiler upgrade would return old objects |
| `base_dir` | repo root | Makes absolute paths relative so two checkouts share hits |
| `hash_dir` | keep `true` unless `-fdebug-prefix-map` (or `-ffile-prefix-map`) is used | The CWD lands in debug info. With the prefix map, set `hash_dir = false` to share across directories |
| `sloppiness` | empty by default | Each entry trades correctness for hits. Add only what a counter in `ccache -s` proves you need |
| PCH | `sloppiness = pch_defines,time_macros`, Clang `-fno-pch-timestamp`, GCC `-fpch-preprocess` | Required by the ccache manual, section "Precompiled headers" |
| Clang modules | `sloppiness = modules` | ccache refuses to cache `-fmodules` otherwise |

- Source: `man ccache` 4.9.1 ([online manual](https://ccache.dev/manual/latest.html)).
- Pitfall: PGO. Profile data is an input the cache must see. Check that changing `merged.profdata` causes a miss before trusting cached `pgo-use` builds; simplest rule: `CCACHE_DISABLE=1` for `pgo-gen`, `pgo-use`, `bolt`.
- Pitfall: `time_macros` sloppiness with code that really uses `__TIME__` gives stale binaries.
- Pitfall: benchmark builds. A cache hit is the same object, so results do not change, but rebuild the baseline and the candidate with the same compiler binary: the cache key covers it, your memory does not.
- CI: cache the ccache directory keyed on compiler version plus OS image; cap with `max_size`; print `ccache -s` at job end and fail review if the hit rate collapses.
- Check: `ccache -z`, build twice from clean, `ccache -s` shows hits equal to compile count.

## Ninja

| Feature | Use |
|---|---|
| Job pools | `CMAKE_JOB_POOLS=link=2`, `CMAKE_JOB_POOL_LINK=link` (in `base`; checked in the generated `rules.ninja`). LTO links are memory-heavy; unbounded parallel links exhaust RAM |
| `ninja -t commands <target>` | Exact command lines |
| `ninja -t inputs`, `-t query`, `-t deps` | Why did this rebuild |
| `ninja -t missingdeps` | Generated-header ordering bugs |
| `ninja -t compdb` | Compilation database without CMake |
| `ninja -t cleandead`, `-t restat`, `-t recompact` | Housekeeping |
| `ninja -d explain` | Reason for each rebuild |
| `.ninja_log` → [ninjatracing](https://github.com/nico/ninjatracing) | Chrome trace of the build; with Clang `-ftime-trace` it embeds per-TU compiler time |
| [ClangBuildAnalyzer](https://github.com/aras-p/ClangBuildAnalyzer) | Aggregates `-ftime-trace`: which headers and template instantiations cost the most |

Subtool list from `ninja -t list` 1.11.1. C++20 named modules need Ninja 1.11+ (dyndep) and CMake 3.28+; the library stays header-based, with a module wrapper as a later option.

## Flags

| Flag | Verdict | Reason |
|---|---|---|
| `-O2` vs `-O3` | Measure both; neither is a default truth | Layout noise can exceed the difference ([19-benchmarking.md](19-benchmarking.md)) |
| `-march=x86-64-v2` / `-v3` / `-v4` | State one. v2 includes CMPXCHG16B and POPCNT, v3 adds AVX2 and BMI, v4 adds AVX-512 | Levels are defined in the [x86-64 psABI](https://gitlab.com/x86-psABIs/x86-64-ABI) |
| `-fno-semantic-interposition`, `-fvisibility=hidden` | On for our binaries | Lets the compiler inline across what would be interposable symbols |
| `-ffunction-sections -fdata-sections` + `--gc-sections`, `--icf=safe` | On for release | Size; `--icf=all` can merge functions whose addresses are compared |
| `-fno-omit-frame-pointer` | On everywhere, including bench | Profiling ([20-profiling.md](20-profiling.md)). State it in reports |
| `-fno-strict-aliasing` | Off (do not add) | It hides aliasing bugs instead of fixing them; the library must be correct under strict aliasing ([10-raii-and-lifetime.md](10-raii-and-lifetime.md)) |
| `-falign-functions=64` | Experiment axis only | A tool for separating layout noise from real effects |
| `-moutline` | Not on x86-64 | Clang 22 prints "'x86_64' does not support '-moutline'; flag ignored" |
| `-fsplit-machine-functions`, `-fbasic-block-address-map` | Clang only | GCC 16 rejects both |
| `-gsplit-dwarf` | Optional for `dev` | Faster links; ccache and distributed builds must carry the `.dwo` |

What NOT to enable: `-ffast-math`, `-march=native` in anything published, `-fno-strict-aliasing`, `-Ofast`, unity builds for tests (they hide missing includes in a header-only library), global `-Werror` for consumers, PCH in the library target, any flag exported through the `INTERFACE` target other than the C++ standard requirement.

## Consumer packaging

- `add_library(mpmc INTERFACE)` with `target_compile_features(mpmc INTERFACE cxx_std_23)` and a `FILE_SET HEADERS`. Alias `mpmc::mpmc`.
- Install a config package: `write_basic_package_version_file(... COMPATIBILITY SameMajorVersion ARCH_INDEPENDENT)`. `ARCH_INDEPENDENT` is what lets one header-only install serve 32- and 64-bit consumers.
- Must work through `find_package(mpmc CONFIG)`, `FetchContent`, and `add_subdirectory`. When not top-level, build no tests or benchmarks (`PROJECT_IS_TOP_LEVEL`).
- vcpkg port, Conan recipe, pkg-config file, single-header amalgamation: after the first release. Each is a build to test in CI, not a file to write once.
- Check: a consumer smoke project per route in CI, built with `-fno-exceptions -fno-rtti -Wall -Wextra -Wpedantic -Wconversion -Werror`.

## CI matrix

| Axis | Values |
|---|---|
| Compiler | GCC (oldest supported, newest), Clang (oldest supported, newest), MSVC |
| Standard library | libstdc++, libc++ (Clang), MSVC STL |
| Architecture | x86-64 and arm64. Arm is where missing acquire/release shows ([05-memory-model.md](05-memory-model.md)) |
| Preset | `dev`, `asan-ubsan`, `tsan`, `release`; `msan`, `rtsan`, `valgrind` nightly |

- Pin toolchains by version in a container image or devcontainer; record the compiler version in every benchmark report. "Latest" on a hosted runner changes under you.
- Reproducible builds: `-ffile-prefix-map=$PWD=.`, no `__DATE__`/`__TIME__`, `SOURCE_DATE_EPOCH` set.
- Oldest supported compiler versions are undecided: the sketch in [04-api.md](04-api.md) needs `<expected>` and C++23 concepts support.
