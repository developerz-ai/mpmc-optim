---
paths: ["**/*.{cpp,hpp,h,cc}", "docs/idea/0[3567]-*.md"]
---
# Atomics rules
Detail: `docs/idea/05-memory-model.md`.

- Explicit `memory_order` on every operation. No operator forms (`x++`, `x = v`, implicit load).
- Comment the pairing edge on every acquire and release.
- `compare_exchange`: pass both orders. `weak` in loops, `strong` otherwise.
- `seq_cst` only for a store-load (Dekker) pattern, with the pattern named.
- No `consume`. Avoid `atomic_thread_fence`: TSan cannot see it.
- Never mix atomic and plain access to one object outside its exclusive window.
- Assert `is_always_lock_free` for every atomic on the hot path.
- Comparing tickets: subtract, then compare as signed.
