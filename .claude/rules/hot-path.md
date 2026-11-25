---
paths: ["include/**", "src/**", "bench/**"]
---
# Hot-path rules
Detail: `docs/idea/09-cache-friendly-allocation.md`, `docs/idea/12-cpu-and-cache.md`.

- Count contended cache lines per operation. Put the count in the PR.
- Separate producer-written, consumer-written and read-mostly state by the destructive size.
- Cache remote counters in the handle. Reload only on apparent full or empty.
- Slow paths out of line and cold.
- Back off with the pause hint. Never spin unbounded without a policy.
- Batch before you vectorise. Vectorise before you add threads.
- No clock reads, logging, statistics RMW or syscalls in the fast path.
