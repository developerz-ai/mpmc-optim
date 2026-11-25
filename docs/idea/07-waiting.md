# ⏳ Waiting

**Waiting is a policy layered on the non-blocking `try_*` operations: spin for a bounded time, then park through an eventcount whose notify costs one load when nobody waits.** The eventcount needs a store-then-load (Dekker) handshake on both sides; get it from `seq_cst` operations, not from a fence.

Status: design. The eventcount snippet was built with GCC 16 and Clang 22 and run under TSan and under ASan+UBSan, exit 0. As of 2026-11.

Owned elsewhere: orderings ([05-memory-model.md](05-memory-model.md)), `PAUSE` cycle table and machine clears ([12-cpu-and-cache.md](12-cpu-and-cache.md)), blocking API and close semantics ([04-api.md](04-api.md)), quotas and sharded wake-ups ([13-numa-and-topology.md](13-numa-and-topology.md)).

## Rules

- The wait policy is a compile-time parameter. A queue built without one contains no wait state and no notify code.
- Never sleep on a condition without the sequence: announce, **recheck**, then sleep. Skipping the recheck is a lost wakeup.
- Notify with no waiter MUST be one load, and that load MUST come after a `seq_cst` publish.
- Spin budgets are in time, never in iterations. One `PAUSE` is 3 to about 180 cycles depending on the core.
- Every spin loop contains a pause hint and has an upper bound.
- No `std::atomic_thread_fence` in wait code that TSan must check: TSan does not model it ([16-sanitizers-and-valgrind.md](16-sanitizers-and-valgrind.md)).
- Do not call `wait()` on a 64-bit atomic on Linux and expect a futex. It is a proxy wait: [stdlib pitfalls](#stdatomic-wait-and-notify).

## Spin primitives

| Primitive | Where | Notes |
|---|---|---|
| `PAUSE` (`_mm_pause`) | x86 | Avoids the memory-ordering clear at loop exit and yields to the SMT sibling ([SDM `PAUSE`](https://www.felixcloutier.com/x86/pause)). Length per core: [12-cpu-and-cache.md](12-cpu-and-cache.md) |
| `YIELD` | AArch64 | A NOP on most cores. Rust switched `spin_loop` to `ISB` for that reason ([rust PR 84725](https://github.com/rust-lang/rust/pull/84725)); the choice is disputed ([go issue 69232](https://github.com/golang/go/issues/69232)) |
| `ISB` | AArch64 | Used as a longer pause. Tune the count per core |
| `WFE` | AArch64 | Sleeps until an event. Linux generates a timer event stream of about 10 kHz so a `WFE` cannot hang; that bounds the nap near 100 µs. Too coarse for a queue spin |
| [`TPAUSE`](https://www.felixcloutier.com/x86/tpause), [`UMWAIT`](https://www.felixcloutier.com/x86/umwait) (WAITPKG) | Recent Intel | Low-power wait until a TSC deadline; `UMWAIT` also wakes on a write to the line armed by `UMONITOR`. The OS caps the time: Linux default 100000 TSC units, C0.2 enabled, under `/sys/devices/system/cpu/umwait_control/` |
| `MWAITX` | AMD (`mwaitx` CPU flag) | Monitor-and-wait with a timer, usable from user mode |
| `sched_yield` | OS | Not a spin primitive. It gives no guarantee about who runs next |

When NOT to use `UMWAIT`/`MWAITX`: portable core, virtual machines that hide the feature. Status: hypothesis that a monitored wait beats `PAUSE` spinning for hand-off latency. Experiment: p99 wake latency, pinned pair, `PAUSE` loop against `UMWAIT` on the slot line.

## Backoff

| Policy | Rule | When to use | How it goes wrong |
|---|---|---|---|
| None | Retry at once | Uncontended paths | Failed CAS storms ([12-cpu-and-cache.md](12-cpu-and-cache.md)) |
| Truncated exponential | Double the pause burst up to a cap | Default after a failed CAS | Cap tuned in iterations on one machine is 50x off on another |
| Proportional | Pause in proportion to the number of threads ahead (ticket distance) | Ticket-ordered waits, where the distance is known | The SOSP 2013 study measured this on ticket locks ([David et al.](https://sigops.org/s/conferences/sosp/2013/papers/p33-david.pdf) §5.3); for queues it is a hypothesis |
| Spin then park | Spin for about the cost of a park plus wake, then sleep | Any blocking wait | Competitive-spinning result: [Karlin et al., SOSP 1991](https://dl.acm.org/doi/10.1145/121132.286599). Measure the park cost; do not guess it |

```cpp
// check: compile
#include <chrono>
#include <cstdint>
#include <thread>
#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#endif

inline void cpu_relax() noexcept {
#if defined(__x86_64__) || defined(__i386__)
    _mm_pause();                      // 3 to ~180 cycles depending on the core
#elif defined(__aarch64__)
    __asm__ __volatile__("isb");      // YIELD is a NOP on most Arm cores
#else
    std::this_thread::yield();
#endif
}

// Spin budget in TIME, not iterations: one PAUSE differs 50x across cores.
class SpinBudget {
    using clock = std::chrono::steady_clock;
    clock::time_point deadline_;
    std::uint32_t burst_ = 1;

public:
    explicit SpinBudget(std::chrono::nanoseconds budget) noexcept
        : deadline_(clock::now() + budget) {}

    // Returns false when the caller should park.
    [[nodiscard]] bool spin() noexcept {
        for (std::uint32_t i = 0; i < burst_; ++i) cpu_relax();
        if (burst_ < 64) burst_ *= 2;                 // truncated exponential
        return clock::now() < deadline_;              // one vDSO call per burst
    }
};

template <class TryOp, class Park>
auto spin_then_park(TryOp&& try_op, Park&& park, std::chrono::nanoseconds budget) {
    for (;;) {
        SpinBudget b{budget};
        do {
            if (auto r = try_op()) return r;
        } while (b.spin());
        park();                                       // eventcount wait, see below
    }
}
```

How to check: sweep the budget (0, 1 µs, 10 µs, 100 µs) per machine and report throughput and p99.99 for each ([19-benchmarking.md](19-benchmarking.md)).

## Parking primitives

| OS | Primitive | Notes |
|---|---|---|
| Linux | [`futex(2)`](https://man7.org/linux/man-pages/man2/futex.2.html) `FUTEX_WAIT` / `FUTEX_WAKE` | The word is **32 bits**. The kernel compares it to the expected value before sleeping, which closes the check-then-sleep race |
| Linux 5.16+ | `futex_waitv` ([futex2](https://docs.kernel.org/userspace-api/futex2.html)) | Waits on up to 128 words: one waiter, several shards |
| Linux 6.7+ | `futex_wait`, `futex_wake`, `futex_requeue` syscalls; io_uring futex wait, wake and waitv ([Linux 6.7](https://kernelnewbies.org/Linux_6.7), [`io_uring_prep_futex_wait`](https://man7.org/linux/man-pages/man3/io_uring_prep_futex_wait.3.html)) | An io_uring event loop can wait on the queue's futex word directly |
| Windows | [`WaitOnAddress`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress), `WakeByAddressSingle/All` | 1, 2, 4 or 8 byte words |
| macOS | [`os_sync_wait_on_address`](https://developer.apple.com/documentation/os/os_sync_wait_on_address); older systems only have the private `__ulock_wait` | libc++ falls back to `__ulock` (its `src/atomic.cpp`) |

Event loops: an `epoll` consumer cannot block on a futex. Give it an [`eventfd`](https://man7.org/linux/man-pages/man2/eventfd.2.html) and gate the `write` behind the same "any waiter?" load, or every push becomes a syscall. With io_uring 6.7+ use the futex opcode instead.

## std::atomic wait and notify

Read from the installed headers and upstream sources, not from documentation.

| Library | Native wait | Everything else | Notify with no waiter |
|---|---|---|---|
| libstdc++ (GCC 16, `bits/atomic_wait.h`) | Linux: only types with `sizeof == sizeof(int)` and alignment 4 | Proxy wait on a library-owned word chosen by hashing the address. `atomic<uint64_t>` is a proxy wait | A call into `libstdc++.so` (entry points moved into the library in GCC 16, with an ABI break for these C++20 parts: [GCC 16 changes](https://gcc.gnu.org/gcc-16/changes.html)) |
| libc++ (`__atomic/contention_t.h`, `src/atomic.cpp`) | Linux: `int32_t` contention type only. Newer versions add opt-in native waits by size 4 or 8 behind `_LIBCPP_ABI_ATOMIC_WAIT_NATIVE_BY_SIZE` ([PR 161086](https://github.com/llvm/llvm-project/pull/161086)); Linux stays 32-bit | A global contention table shared by unrelated atomics | A `seq_cst` load of a waiter count in that table, then the syscall only if nonzero |

Pitfalls:

- Proxy waits share state between unrelated atomics: spurious wake-ups, and a notify that touches a table line you do not own. libstdc++ fixed a case where `notify_one` woke a waiter on a different object ([PR 115955 commit](https://gcc.gnu.org/pipermail/libstdc++-cvs/2026q4/045482.html)).
- `wait(old)` returns only when the value differs from `old`. A value that changes and changes back may leave the waiter asleep. Wait on a counter that only moves forward.
- No timeout and no way to wait on several atomics in C++23.
- The standard library spins and counts waiters itself. Layering your own spin and waiter count on top pays twice.

Rule: the core calls the OS primitive directly on a 32-bit word it owns. `std::atomic::wait` is the fallback for platforms without a known primitive.

## Eventcount

A condition variable for mutex-free code: the queue stays non-blocking; the eventcount adds the sleep ([Vyukov](https://www.1024cores.net/home/lock-free-algorithms/eventcounts), [folly `EventCount`](https://github.com/facebook/folly/blob/main/folly/synchronization/EventCount.h)).

| Step | Waiter | Notifier |
|---|---|---|
| 1 | `waiters.fetch_add(1)` [S], read `epoch` | publish the element [S] |
| 2 | **recheck** the queue [S] | `waiters.load()` [S]; zero: return |
| 3 | success: cancel. Failure: sleep while `epoch == key` | `epoch.fetch_add(1)`, then wake |

Why it is correct: the four [S] operations are `seq_cst`, so they have one total order. If the notifier's load sees zero waiters, the waiter's increment is later in that order, so its recheck is later than the publish and sees the element. If the load sees a waiter, the epoch moves; a waiter that has not slept yet fails the kernel's compare, one that sleeps is woken.

Why not a fence: `store(release); atomic_thread_fence(seq_cst); load(relaxed)` is equally valid C++ and the same machine code cost on x86, but TSan cannot check it. With `seq_cst` operations the publish costs `xchg` instead of `mov` on x86 (about one uncontended RMW, [12-cpu-and-cache.md](12-cpu-and-cache.md)); the `seq_cst` loads are plain loads.

Design difference from folly: folly's `notify` always does a `fetch_add` on the shared epoch word, a contended RMW per push. Splitting the waiter count from the epoch makes the no-waiter path a load. Cost: the publish must be `seq_cst`.

```cpp
// check: run
#include <atomic>
#include <climits>
#include <cstdint>
#include <cstdlib>
#include <thread>
#include <vector>
#if defined(__linux__)
#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif

// Eventcount: lets a non-blocking try-operation block. No fence: the four
// seq_cst operations marked [S] form a Dekker pair, which TSan models.
class EventCount {
    // Separate fields, not one packed word: notify with no waiter stays a pure load.
    std::atomic<std::int32_t> epoch_{0};     // the futex word (32-bit on Linux)
    std::atomic<std::uint32_t> waiters_{0};

    void park(std::int32_t key) noexcept {
#if defined(__linux__)
        // Kernel rechecks epoch_ == key under its bucket lock, so a bump
        // between our load and the syscall returns EAGAIN, not a sleep.
        syscall(SYS_futex, &epoch_, FUTEX_WAIT_PRIVATE, key, nullptr, nullptr, 0);
#else
        epoch_.wait(key, std::memory_order_seq_cst);
#endif
    }
    void unpark(int n) noexcept {
#if defined(__linux__)
        syscall(SYS_futex, &epoch_, FUTEX_WAKE_PRIVATE, n, nullptr, nullptr, 0);
#else
        n == 1 ? epoch_.notify_one() : epoch_.notify_all();
#endif
    }

public:
    using Key = std::int32_t;

    // Waiter, step 1. [S] RMW: announces the waiter before it rechecks.
    Key prepare_wait() noexcept {
        waiters_.fetch_add(1, std::memory_order_seq_cst);
        return epoch_.load(std::memory_order_seq_cst);
    }
    // Waiter, step 2a: the recheck succeeded.
    void cancel_wait() noexcept { waiters_.fetch_sub(1, std::memory_order_seq_cst); }
    // Waiter, step 2b: the recheck failed. Sleeps until the epoch moves.
    void wait(Key key) noexcept {
        while (epoch_.load(std::memory_order_seq_cst) == key) park(key);
        waiters_.fetch_sub(1, std::memory_order_seq_cst);
    }
    // Notifier: call AFTER a seq_cst publish. [S] load: one load when nobody waits.
    void notify(int n) noexcept {
        if (waiters_.load(std::memory_order_seq_cst) == 0) return;
        epoch_.fetch_add(1, std::memory_order_seq_cst);  // wraps; atomics have no signed-overflow UB
        unpark(n);
    }
};

// Stand-in for a queue: a count of available items.
std::atomic<std::int64_t> items{0};
std::atomic<bool> closed{false};
EventCount ec;

bool try_pop() noexcept {
    // [S] loads: the recheck must sit in the seq_cst total order.
    std::int64_t n = items.load(std::memory_order_seq_cst);
    while (n > 0)
        if (items.compare_exchange_weak(n, n - 1, std::memory_order_seq_cst)) return true;
    return false;
}

void push() noexcept {
    items.fetch_add(1, std::memory_order_seq_cst);  // [S] publish
    ec.notify(1);
}

bool pop_blocking() noexcept {
    for (;;) {
        if (try_pop()) return true;
        if (closed.load(std::memory_order_seq_cst)) return try_pop();
        const EventCount::Key key = ec.prepare_wait();
        if (try_pop()) { ec.cancel_wait(); return true; }
        if (closed.load(std::memory_order_seq_cst)) { ec.cancel_wait(); return try_pop(); }
        ec.wait(key);
    }
}

int main() {
    constexpr int producers = 3, consumers = 3, per_producer = 20000;
    std::atomic<std::int64_t> popped{0};
    std::vector<std::thread> ts;
    for (int c = 0; c < consumers; ++c)
        ts.emplace_back([&] {
            while (pop_blocking()) popped.fetch_add(1, std::memory_order_relaxed);
        });
    std::vector<std::thread> ps;
    for (int p = 0; p < producers; ++p)
        ps.emplace_back([] { for (int i = 0; i < per_producer; ++i) push(); });
    for (auto& t : ps) t.join();
    closed.store(true, std::memory_order_seq_cst);  // [S] publish of "closed"
    ec.notify(INT_MAX);
    for (auto& t : ts) t.join();
    // A lost wakeup shows up as a hang here, not as a wrong count.
    return popped.load(std::memory_order_relaxed) == std::int64_t{producers} * per_producer
               ? EXIT_SUCCESS : EXIT_FAILURE;
}
```

How it goes wrong:

| Bug | Cause | Check |
|---|---|---|
| Lost wakeup | Recheck missing, or publish/recheck not `seq_cst`. Passes on x86 by luck when the publish is already a locked RMW; fails on Arm | Model check ([17-testing-and-verification.md](17-testing-and-verification.md)); stress test that hangs on loss, as above |
| Lost wakeup across shards | Waiter parked on one shard's word, push went to another | One eventcount per sharded queue, or `futex_waitv` |
| Thundering herd | `notify_all` per push | Wake one per element; wake all only on close |
| Wake storm | Each push sees `waiters != 0` while the woken thread has not yet decremented, and issues another syscall | Count `futex_wake` calls per push; hypothesis: a "wake pending" bit removes most |
| Epoch wrap | A waiter sleeps through exactly 2^32 notifies | Accepted; document it |
| Stale close | `close()` not followed by a wake-all | Close publishes [S], then `notify(INT_MAX)` ([04-api.md](04-api.md)) |

## Other hazards

| Hazard | Rule |
|---|---|
| Oversubscription and quotas | Spinning while the thread you wait for is descheduled burns the time it needs. Cap the spin; with more runnable threads than CPUs set the budget to zero ([13-numa-and-topology.md](13-numa-and-topology.md)) |
| Priority inversion | A real-time spinner can starve a lower-priority producer that is between claim and publish. `FUTEX_LOCK_PI` covers locks only, not condition waits. Do not spin unbounded under `SCHED_FIFO` |
| Coroutines | An awaiter registers a continuation, then performs the same recheck. Resuming inline runs consumer code on the producer's thread; post to an executor instead. API: [04-api.md](04-api.md) |
| Power | Spin loops hold the core at full power. Parking is the only idle state the OS can use |
| Asymmetric barrier | [`membarrier(2)`](https://man7.org/linux/man-pages/man2/membarrier.2.html) lets the rare waiter side force a barrier on all threads so the notifier needs none. TSan does not model it. Not planned |
