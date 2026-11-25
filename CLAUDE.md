# mpmc-optim

Optimised C++23 multi-producer multi-consumer queue, and the engineering notes to build one. **Stage: docs only. Do not scaffold library code until asked.**

## Response rules
- Lead with the answer. Terse. Paths and commands exact.
- Disagree when the docs or the user are wrong; give the correction and the source.
- Report what was checked and what was not.

## Commands
```bash
bin/setup                 # check tools, run the gate
bin/check                 # the gate CI runs: script tests, docs rules, compile doc snippets
bun scripts/help.ts       # list every script
bun scripts/check-docs.ts      # links, anchors, index coverage, fences, secrets
bun scripts/check-snippets.ts  # compile (and run) C++ in docs; accepts file paths
bun scripts/release.ts patch --dry-run   # cut a release: patch, minor or major
```
Run `bin/check` before every commit. The newest `vX.Y.Z` git tag is the version: no version file. Cut a release only when the user asks.

## Where things live
- `docs/idea/README.md`: the map. One topic per file, one owning doc per fact.
- `docs/idea/01-vision.md`: goals, invariants I1-I7, **vocabulary. Use those words.**
- `docs/idea/22-roadmap.md`: phases and exit checks.
- `docs/idea/23-open-questions.md`: undecided choices. Never silently settle one.
- `.claude/rules/`: path-scoped C++ rules. `.claude/agents/`: specialists. `.claude/commands/`: workflows.
- `scripts/`: Bun TypeScript, no dependencies. `scripts/lib/`: reusable, tested.

## Doc rules
- Lead with the rule. Fragments and tables over paragraphs. One topic per file, under 400 lines.
- Cite the source (paper, standard section, repo, talk) for every non-obvious claim. Date what can go stale (`As of 2026-11`).
- No invented numbers. Cite it, measure it, or label it a target or hypothesis.
- Every doc has a row in `docs/idea/README.md`.
- C++ snippets that should compile carry a marker on the first line of the block:
  `// check: compile` (syntax and types, GCC and Clang) or `// check: run` (has `main`, must exit 0).
  No marker means illustrative fragment. Prefer a marker.

## Preventive rules (these bite before any symptom appears)
- **No bare atomic operation.** Always pass a `memory_order` and comment the edge it creates: x86 hides missing acquire/release, Arm does not. Detail: `docs/idea/05-memory-model.md`.
- **"Lock-free" is a proof obligation.** Without a progress proof, write "mutex-free".
- **Tickets are 64-bit.** A 32-bit counter wraps in 43 s at 100M ops/s, and wrap is an ABA bug.
- **Never read a slot before its sequence says so**, including "harmless" prefetch-and-inspect. That is a data race, so UB.
- **SIMD loads are not atomic loads.** The C++ memory model has no racing vector load; scan only with the rules in `docs/idea/14-simd.md`.
- **TSan does not understand `atomic_thread_fence`.** Fence-based code gets false results. Valgrind's Helgrind and DRD do not understand C++ atomics either.
- **Do not hard-code 64, and do not trust `std::hardware_destructive_interference_size`.** It is 64 on x86-64, which misses adjacent-line prefetch. Use one library-owned spacing constant: `docs/idea/09-cache-friendly-allocation.md`.
- **No benchmark number without pinning, machine, compiler, payload, capacity and spread.**

## Hard boundaries
- MIT. Do not copy code from incompatible licences (GPL, unclear). Cite ideas instead.
- No secrets, private hostnames or client names.
- No git worktrees beside the repo. Subagents share this checkout with disjoint files and do no git operations.
