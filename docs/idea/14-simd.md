# 🧬 SIMD

**SIMD cannot speed up the part of an MPMC queue that is slow.** The cost is contended RMWs and line transfers ([12-cpu-and-cache.md](12-cpu-and-cache.md)); no vector instruction does an atomic RMW. SIMD helps only on private data: payload batches, snapshots of hint metadata, the caller's processing of a drained batch. Reach for SWAR on one atomic word first.

Status: design. No kernel here is adopted. Both `// check: run` snippets were compiled with GCC 16 and Clang 22 and run under ASan and UBSan. As of 2026-11.

Owned elsewhere: what a data race is and which orderings apply ([05-memory-model.md](05-memory-model.md)), layout and SoA versus AoS for slots ([09-cache-friendly-allocation.md](09-cache-friendly-allocation.md)), bulk API shape ([04-api.md](04-api.md)), build flags and the CI matrix ([21-build-and-toolchain.md](21-build-and-toolchain.md)).

## Rules

- **A vector load is not an atomic load.** A SIMD load of memory that another thread may write, atomically or not, is a data race: undefined behaviour in C++. No intrinsic changes that.
- Scan only (a) one `std::atomic` word with SWAR, or (b) a private snapshot filled by per-element atomic loads.
- Every scan result is a **hint**. The decision is the slot protocol's CAS or sequence check (I4, I7 in [01-vision.md](01-vision.md)).
- A hint that costs a shared write per operation is not a hint; it is a second contended counter. Update shared hint words only on transitions (empty to non-empty).
- Every vector kernel has a scalar twin, and a test that both give identical results for every length and offset.
- No ISA extension above the build baseline without run-time dispatch. Dispatch at batch granularity, never per element.
- Non-temporal stores MUST be followed by `SFENCE` before the slot is published.
- The header-only core contains no intrinsics until a benchmark shows a kernel wins ([19-benchmarking.md](19-benchmarking.md)).

## Where it helps, where it cannot

| Job | SIMD helps? | Why | What to do |
|---|---|---|---|
| Claiming a ticket, publishing a slot | **No** | One contended RMW each. Vector units have no locked operations | Fewer RMWs: batch, cache, shard ([12-cpu-and-cache.md](12-cpu-and-cache.md)) |
| Copying a batch of trivially copyable payloads into claimed slots | Yes, already | The slots are private between claim and publish. `memcpy` in libc is hand-vectorised and dispatched | Call `memcpy` with the largest contiguous span (at most two per batch: the ring wraps). Do not write a copy loop |
| Relocating non-trivial payloads | No | Element-wise move construction | [10-raii-and-lifetime.md](10-raii-and-lifetime.md) |
| "How many of the next k slots are published?" for a bulk pop | Rarely | k atomic loads of sequence words. Compilers do not vectorise atomic loads (below). Sequences inside slots (AoS) would need a gather | Scalar loop with early exit. Or claim k tickets and wait per slot |
| Occupancy or readiness bitmap, up to 64 entries | SWAR, not SIMD | One `atomic<uint64_t>` load is a true snapshot. `countr_zero`, `popcount`, `rotr` do the rest | [SWAR first](#swar-first) |
| Picking a non-empty shard among many ([13-numa-and-topology.md](13-numa-and-topology.md)) | SWAR up to 64 shards; SIMD over a private snapshot beyond | Same as above | Bitmap word of "maybe non-empty" bits, set on transition |
| Checksum, parse, filter, transform of a drained batch | **Yes** | Private, contiguous, the caller's hot loop | Give the caller contiguous spans from bulk pop. This is where the cycles are |
| SoA payloads (queue of structs split into parallel arrays) | Yes, for the caller | Each field contiguous | A payload design choice for users, not a core feature. Costs k line hand-offs per element instead of one |
| Zeroing or prefaulting the ring | Marginal | Dominated by page faults | `memset`, or let the kernel do it ([08-arenas-and-allocators.md](08-arenas-and-allocators.md)) |

Reading: the library's own SIMD surface is close to empty. Its job is to hand batches to the caller in a shape the caller can vectorise.

## The atomicity problem

| Claim | Status | Source |
|---|---|---|
| Reading an object while another thread writes it, with at least one side non-atomic, is a data race and UB | C++ standard, [intro.races] | [05-memory-model.md](05-memory-model.md) |
| `_mm256_loadu_si256` over an array of `std::atomic<uint8_t>` is such a read | Follows from the above. The intrinsic is an ordinary load to the optimiser | n/a |
| Compilers do not turn a loop of atomic loads into a vector load | Checked: a loop of `atomic<uint8_t>::load(relaxed)` into a local buffer stays byte loads at `-O3 -mavx2` on GCC 16 and Clang 22 | Local `-S` output; snippet below |
| On x86 CPUs that enumerate AVX, an **aligned 16-byte** load or store by `MOVAPS`/`MOVAPD`/`MOVDQA` and their VEX.128 and unmasked EVEX.128 forms is carried out atomically | Intel SDM since 2021-12 | Text reproduced in [GCC bug 104688](https://gcc.gnu.org/bugzilla/show_bug.cgi?id=104688) |
| AMD gives the same guarantee for cacheable memory | AMD statement relayed in the same bug, 2022-11; libatomic then treated AMD with AVX and `CMPXCHG16B` like Intel ([commit 4a7a846](https://gnu.googlesource.com/gcc/+/4a7a846687e076eae58ad3ea959245b2bf7fdc07)) | [gcc-bugs, 2022-11](https://inbox.sourceware.org/gcc-bugs/bug-104688-4-Wd5SbGJ7rD@http.gcc.gnu.org%2Fbugzilla%2F/) |

What the 16-byte guarantee gives:

- A lock-free **load** and **store** for a 16-byte atomic (for example a pointer plus counter pair) inside the implementation of `std::atomic<__int128>` or libatomic. The RMW still needs `lock cmpxchg16b`.

What it does not give:

| Not covered | Why it matters |
|---|---|
| The C++ language | The guarantee is about instructions. A source-level vector load of racing memory is still UB: the compiler may reload, hoist, split or duplicate it |
| 32 and 64-byte loads (`YMM`, `ZMM`) | No vendor statement. Assume they can tear between 16-byte halves |
| Unaligned forms (`MOVDQU`, `VMOVDQU`) and any access that crosses a cache line | Not in the list |
| CPUs without AVX | Not covered, including x86-64 baseline builds on old or low-power parts |
| Other vendors | A Zhaoxin engineer reported atomicity only for write-back memory ([gcc-bugs](https://gcc.gnu.org/pipermail/gcc-bugs/2022-November/804244.html)) |
| Arm | No equivalent statement for NEON or SVE loads known to this doc. Assume none |
| Usefulness for flags | A consistent snapshot of 16 independent one-byte flags is no better than 16 separate reads: each flag can change the instant after. It matters only when the 16 bytes are one logical value |

### Safe patterns

| Pattern | How | Defined behaviour? | TSan | Use when |
|---|---|---|---|---|
| **SWAR on one atomic word** | Pack up to 8 byte flags or 64 bit flags in `atomic<uint64_t>`; one load; bit tricks on the value | Yes | Clean | Default. Up to 64 entries per word |
| **Private snapshot** | Loop of per-element `load(relaxed)` into a local array, then any SIMD on the local array | Yes | Clean | More than 64 entries, or the metadata must stay one atomic per entry |
| **Several atomic words, SIMD over the loaded values** | Load 4 `atomic<uint64_t>` words into locals, combine into a vector register | Yes. Not one snapshot: the words are read at different times | Clean | Bitmaps of 65 to a few hundred bits |
| **Opaque assembly boundary** | The racing load lives in inline `asm` or a separately assembled function; C++ sees only the result | Outside the standard. Behaviour is whatever the hardware does: each byte is some value that was stored, and an aligned 16-byte load is one snapshot on AVX x86 | Invisible to TSan: it neither reports nor checks it | Not in the core. An opt-in kernel only, with the result treated as a hint and this table cited in the code |
| Intrinsic load on racing memory | `_mm_load_si128` on the shared array | **No. UB** | Reports a race against the atomic writers | Never |

Ordering for hint scans: `relaxed` is enough when the result is only a hint that the slot protocol re-validates, because the protocol's own acquire creates the happens-before edge (I3). If code acts on the snapshot without re-validating, it needs `acquire` on the load that covers the data it will touch, and then it is no longer a scan but the protocol ([05-memory-model.md](05-memory-model.md)).

How it goes wrong:

- The scan finds "ready", the code reads the slot without the sequence check, and a second consumer has already taken it. Double pop (I1).
- The scan finds "empty everywhere" and the thread parks, but a flag was set after its word was read. Lost wakeup. A scan is never the pre-park check; the eventcount recheck is ([07-waiting.md](07-waiting.md)).
- A shared bitmap updated with `fetch_or` on every push adds one contended RMW per operation and one more bouncing line. Throughput drops below the queue without the bitmap.

How to check: TSan on a stress test that scans while writers run ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)); a debug counter of "hint said ready, protocol said no" per success.

## SWAR first

SIMD within a register: ordinary integer instructions on a 64-bit word treated as 8 bytes or 64 bits. Atomic by construction when the word is one `std::atomic<uint64_t>`.

| Need | Expression |
|---|---|
| First set bit of 64 | `std::countr_zero(w)` |
| First set bit at or after position `p` (fair rotation) | `std::countr_zero(std::rotr(w, p))`, then add `p` modulo 64 |
| How many set | `std::popcount(w)` |
| Which bytes are nonzero | `(((w & 0x7f7f..) + 0x7f7f..) \| w) & 0x8080..` (exact, no cross-byte carry) |
| Clear the lowest set bit | `w & (w - 1)` |

```cpp
// check: run
#include <atomic>
#include <bit>
#include <cstdint>
#include <cstdlib>

// Eight one-byte ready flags in ONE atomic word. A single load is a real
// atomic snapshot of all eight, which no vector load of eight atomics is.
static_assert(std::endian::native == std::endian::little, "byte index math assumes little-endian");

constexpr std::uint64_t lo7 = 0x7f7f7f7f7f7f7f7fULL;
constexpr std::uint64_t hi1 = 0x8080808080808080ULL;

// Bit 7 of each byte set iff that byte is nonzero. Exact: no cross-byte carry.
constexpr std::uint64_t nonzero_bytes(std::uint64_t w) noexcept {
    return (((w & lo7) + lo7) | w) & hi1;
}
// Index of the first nonzero byte, 8 if none.
constexpr unsigned first_nonzero_byte(std::uint64_t w) noexcept {
    return static_cast<unsigned>(std::countr_zero(nonzero_bytes(w))) / 8;
}
constexpr unsigned first_nonzero_byte_scalar(std::uint64_t w) noexcept {
    for (unsigned i = 0; i < 8; ++i)
        if ((w >> (8 * i)) & 0xff) return i;
    return 8;
}
static_assert(first_nonzero_byte(0) == 8 && first_nonzero_byte(0x0100) == 1);
static_assert(nonzero_bytes(0x00ff008001000000ULL) == 0x0080008080000000ULL);

struct ReadyWord {
    std::atomic<std::uint64_t> bits{0};

    void set(unsigned i) noexcept {      // release: publishes whatever flag i guards
        bits.fetch_or(std::uint64_t{1} << (8 * i), std::memory_order_release);
    }
    // Claims one ready flag. The scan is a hint; the CAS is the decision.
    int try_claim() noexcept {
        std::uint64_t w = bits.load(std::memory_order_acquire);   // pairs with set()
        for (;;) {
            const unsigned i = first_nonzero_byte(w);
            if (i == 8) return -1;
            const std::uint64_t cleared = w & ~(std::uint64_t{0xff} << (8 * i));
            if (bits.compare_exchange_weak(w, cleared, std::memory_order_acq_rel,
                                           std::memory_order_acquire))
                return static_cast<int>(i);
        }
    }
};

int main() {
    // Scalar-vs-SWAR equivalence on a deterministic pseudo-random stream.
    std::uint64_t x = 0x9e3779b97f4a7c15ULL;
    for (int n = 0; n < 200000; ++n) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;                  // xorshift64
        const std::uint64_t sparse = x & (x >> 21) & (x << 9) & 0x01ff00ff8000ff01ULL;
        const std::uint64_t cases[] = {x, sparse, sparse & (std::uint64_t{0xffff} << 48), 0};
        for (std::uint64_t w : cases)
            if (first_nonzero_byte(w) != first_nonzero_byte_scalar(w)) return EXIT_FAILURE;
    }
    ReadyWord r;
    r.set(5); r.set(2);
    if (r.try_claim() != 2 || r.try_claim() != 5 || r.try_claim() != -1) return EXIT_FAILURE;
    return EXIT_SUCCESS;
}
```

When NOT to: when every push would write the word. `ReadyWord` is a contended line; it fits per-shard "maybe non-empty" bits that change rarely, not per-slot state.

Pitfalls: byte order (the index math above is little-endian; the `static_assert` says so). The popular `haszero` trick `(w - 0x0101..) & ~w & 0x8080..` gives false positives in bytes above the first zero; it is fine for "any?" and wrong for "which?".

## Snapshot then vector

For metadata that must stay one atomic per entry. The racing reads are scalar and atomic; the vector code sees only private memory.

```cpp
// check: run
#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <initializer_list>
#include <vector>
#if defined(__x86_64__) && (defined(__GNUC__) || defined(__clang__))
#include <immintrin.h>
#define MPMC_HAVE_AVX2_KERNEL 1
#endif

// Step 1: copy shared flags into PRIVATE memory with real atomic loads.
// Neither GCC 16 nor Clang 22 vectorises this loop: it stays n byte loads.
inline void snapshot(const std::atomic<std::uint8_t>* flags, std::uint8_t* out, std::size_t n) noexcept {
    for (std::size_t i = 0; i < n; ++i)
        out[i] = flags[i].load(std::memory_order_relaxed);   // hint only: no edge needed, result is re-validated
}

// Step 2: scan the private copy. No other thread can see it, so no race.
inline std::size_t find_byte_scalar(const std::uint8_t* p, std::size_t n, std::uint8_t needle) noexcept {
    for (std::size_t i = 0; i < n; ++i)
        if (p[i] == needle) return i;
    return n;
}

#if defined(MPMC_HAVE_AVX2_KERNEL)
__attribute__((target("avx2")))
inline std::size_t find_byte_avx2(const std::uint8_t* p, std::size_t n, std::uint8_t needle) noexcept {
    const __m256i v = _mm256_set1_epi8(static_cast<char>(needle));
    std::size_t i = 0;
    for (; i + 32 <= n; i += 32) {
        const __m256i x = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(p + i));
        const auto m = static_cast<std::uint32_t>(_mm256_movemask_epi8(_mm256_cmpeq_epi8(x, v)));
        if (m != 0) return i + static_cast<std::size_t>(std::countr_zero(m));
    }
    return i + find_byte_scalar(p + i, n - i, needle);   // tail: never read past n
}
#endif

inline std::size_t find_byte(const std::uint8_t* p, std::size_t n, std::uint8_t needle) noexcept {
#if defined(MPMC_HAVE_AVX2_KERNEL)
    static const bool avx2 = __builtin_cpu_supports("avx2") != 0;   // CPUID once, then a predicted branch
    if (avx2) return find_byte_avx2(p, n, needle);
#endif
    return find_byte_scalar(p, n, needle);
}

int main() {
    std::vector<std::atomic<std::uint8_t>> shared(200);
    std::vector<std::uint8_t> priv(shared.size());
    std::uint64_t x = 88172645463325252ULL;
    for (int round = 0; round < 2000; ++round) {
        for (auto& f : shared) {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            f.store(static_cast<std::uint8_t>(x % 5 == 0), std::memory_order_relaxed);
        }
        snapshot(shared.data(), priv.data(), priv.size());
        // Every length, so every tail size and every match position is covered.
        const std::size_t n = static_cast<std::size_t>(round) % (priv.size() + 1);
        for (std::uint8_t needle : {std::uint8_t{0}, std::uint8_t{1}, std::uint8_t{7}})
            if (find_byte(priv.data(), n, needle) != find_byte_scalar(priv.data(), n, needle))
                return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
```

When NOT to: the snapshot loop is n scalar loads touching the same lines a direct scan would. The vector step saves only the compare, which was never the cost. Hypothesis: this pattern loses to a plain early-exit scalar scan below a few hundred entries. Experiment: both kernels over 64, 256, 1024 flags, cold and warm lines, pinned.

## Tails, alignment, vzeroupper

| Topic | Rule | How it goes wrong | How to check |
|---|---|---|---|
| Tail of a buffer | Scalar loop, or a masked load (`_mm256_maskload_epi32`, AVX-512 `k` masks, SVE predicates). Never an over-read "because the page is mapped" | Over-read past the allocation: ASan report, a fault at a page end, or a race with the neighbour object | ASan plus the every-length test above |
| Overlapping last vector | Legal for idempotent, private operations (find, compare, copy to non-overlapping memory) when `n` is at least one vector | Applied to an accumulating operation: elements counted twice | Equivalence test at `n = width + 1` |
| Alignment | `loadu`/`storeu` cost the same as aligned forms on current x86 when the data is aligned. Align the buffer; keep the unaligned instruction | `_mm256_load_si256` on a misaligned pointer faults. A 64-byte load across a line or page boundary is slower | UBSan does not see intrinsic alignment. Test with deliberately offset buffers |
| `vzeroupper` | Compilers insert it at the end of functions that use `YMM`/`ZMM`. Hand-written assembly must do it | Dirty upper halves slow later legacy-SSE code (transition penalty, Intel optimization manual) | `objdump -d` shows `vzeroupper` before `ret` |
| `target` attribute and inlining | A `target("avx2")` function cannot inline into a baseline caller | A per-element kernel becomes a call per element | Kernel takes a span. Read the assembly |
| Non-trivially-copyable payloads | No bytewise SIMD move | `memcpy` of a type with a non-trivial move: UB | `static_assert(std::is_trivially_copyable_v<T>)` on the fast path |

## Non-temporal copies

| | |
|---|---|
| What | `MOVNTI`, `MOVNTDQ`, `_mm_stream_si128`, `_mm256_stream_si256`: write through write-combining buffers, no RFO, the line is not left in cache |
| glibc already does it | `memcpy` switches to non-temporal stores above a threshold derived from the shared cache size; tunable `glibc.cpu.x86_non_temporal_threshold` ([glibc manual: tunables](https://sourceware.org/glibc/manual/latest/html_node/Hardware-Capability-Tunables.html)) |
| When to use | One payload larger than the consumer's cache share, consumed later |
| When NOT to | Normal queue hand-off. The consumer reads the payload next; it now misses to DRAM instead of fetching the line from the producer's cache |
| How it goes wrong | Non-temporal stores are weakly ordered. On x86 an ordinary release store of the slot sequence does **not** order them: the consumer can see the sequence and read stale payload bytes. `_mm_sfence()` after the last streaming store, before the publish |
| Also | Destination must be aligned to the vector width for the streaming forms. Partial write-combining buffers flush on unrelated events |
| How to check | A test that streams, publishes without the fence, and verifies payload checksums fails only rarely and only on real hardware: rely on review plus an `SFENCE` wrapper type, not on the test |

The `SFENCE` rule is one x86 case where "x86 hides missing orderings" is false. It belongs in the per-operation justification table in [05-memory-model.md](05-memory-model.md) if the feature is ever adopted.

## Ways to write it

| Approach | Good | Bad | Use for |
|---|---|---|---|
| Scalar code plus compiler vectorisation | Portable, no `#if`. Checked by every sanitizer | Silent loss on a compiler upgrade. Never applies to atomic loads | Default for payload loops. Verify with `-fopt-info-vec` (GCC) or `-Rpass=loop-vectorize` (Clang) in CI if a kernel depends on it |
| `memcpy`, `std::copy`, `std::find` on trivially copyable data | libc dispatches on the CPU at run time | A call per tiny payload | Batch copies |
| Intrinsics | Exact control | One implementation per ISA. Easy to write UB (aliasing casts, over-reads) | A measured hot kernel, behind a scalar twin |
| `std::simd` (C++26, `<simd>`, [P1928R15](https://wg21.link/P1928R15) merged 2024-11) | Standard, width-generic | libstdc++: listed as experimental C++26 support in [GCC 16](https://gcc.gnu.org/gcc-16/changes.html) (landed in trunk 2026-03, [commit notice](https://gcc.gnu.org/pipermail/libstdc++-cvs/2026q1/044515.html)); the GCC 16 snapshot on this box predates it. libc++: not implemented, tracked in [issue 118384](https://github.com/llvm/llvm-project/issues/118384). No run-time dispatch in the type | Not for a C++23 library. Revisit when both standard libraries ship it |
| `std::experimental::simd` (Parallelism TS 2) | In libstdc++ since GCC 11 | libstdc++ only in practice. Different names from C++26 | No |
| [Highway](https://github.com/google/highway) | Width-agnostic, many targets including SVE and RVV, built-in dynamic dispatch | A dependency | Benchmarks and optional kernels, if any. Not the header-only core |
| [xsimd](https://github.com/xtensor-stack/xsimd) | Header-only wrappers, batch types | A dependency. Dispatch is manual | Same |

Licences must be checked against MIT before vendoring anything ([18-hardening.md](18-hardening.md)).

## Dispatch

| Mechanism | How | Pitfalls |
|---|---|---|
| Compile-time only (`-march=x86-64-v3`, `-mcpu=native`) | Whole program built for one baseline | Illegal instruction on older CPUs. Right for users who build from source; wrong for distributed binaries |
| `__builtin_cpu_supports("avx2")` and a branch | As in the snippet | One predicted branch per call. Fine at batch granularity |
| `__attribute__((target_clones("avx2","default")))` | Compiler emits one clone per target plus an IFUNC resolver ([GCC function multiversioning](https://gcc.gnu.org/onlinedocs/gcc/Function-Multiversioning.html)) | Needs IFUNC: glibc and FreeBSD yes, musl no. The resolver runs during relocation, before constructors and before sanitizer run-times are ready. Not inlinable. In a header-only library every translation unit emits the clones |
| Hand-written `ifunc` | Same mechanism, own resolver | Same, plus the resolver must not call anything that needs relocation |
| Function pointer set once | `static` initialised from CPUID | An indirect call. Use a local `static const`, not a namespace-scope global, to avoid initialisation-order problems |
| AArch64 function multiversioning | `target_version`, `target_clones`; no longer experimental in GCC 16 ([changes](https://gcc.gnu.org/gcc-16/changes.html)) | Feature detection through `AT_HWCAP` |

Rule for this project: the core is compile-time only. Any dispatched kernel lives in an optional, separately compiled unit.

### ISA notes

| ISA | Fact | Consequence |
|---|---|---|
| SSE2 | x86-64 baseline | Always available. 16-byte vectors |
| AVX2 | x86-64-v3. Not on every CPU in service | Needs dispatch in distributed binaries |
| AVX-512 | Older Intel cores lowered frequency under 512-bit load. Measured: Ice Lake client only 100 MHz with one active core, Rocket Lake none ([Travis Downs](https://travisdowns.github.io/blog/2020/08/19/icl-avx512-freq.html)). Skylake-X era servers were worse | A short 512-bit burst in a queue kernel can slow the surrounding scalar code on old servers. Prefer 256-bit unless measured |
| AVX10 | Version-numbered successor. AVX10.2 requires 512-bit support; the 256-bit-only option was removed, and GCC 16 dropped `-mavx10.1-256` and `-mevex512` ([GCC 16 changes](https://gcc.gnu.org/gcc-16/changes.html)) | Detect by AVX10 version, not by individual AVX-512 feature bits |
| APX | 32 general registers and three-operand forms. Not SIMD. Enabled by `-march=novalake` in GCC 16 along with AVX10.2 | Free with a recompile. No source change |
| NEON | AArch64 baseline. 16-byte vectors. No `movemask`: use the shift-right-and-narrow idiom | Port the kernel, do not translate intrinsic by intrinsic |
| SVE, SVE2 | Vector length is a run-time property (`svcntb()`), 128 to 2048 bits. Predicates handle tails | No fixed-size arrays of vectors. Test at more than one length (`qemu -cpu max,sve-vl=...`) |

## Testing

| Test | Catches |
|---|---|
| Scalar twin equivalence over every length 0..4 x width and every alignment offset 0..width-1 | Tail and over-read bugs, masked-load mistakes |
| Same test under ASan with the buffer at the end of its allocation | Over-reads |
| Force each dispatch target (environment override in the test build) | Clones that never ran in CI because the runner's CPU chose another |
| Run under an emulator for ISAs CI lacks (Intel SDE, `qemu-user`) | Illegal instructions, SVE length assumptions |
| TSan stress: scanners running against writers | A vector load that reached shared memory |
| Benchmark against the scalar twin, cold and warm ([19-benchmarking.md](19-benchmarking.md)) | Kernels that win only in a warm microbenchmark |

A kernel without a win in the last row is deleted, not kept "for later".
