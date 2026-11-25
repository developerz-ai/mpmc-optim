---
description: Turn a roadmap phase into a self-contained plan another agent can execute
argument-hint: <phase or goal>
---
# /planx
Goal: $ARGUMENTS. Plan only, no code.

1. Read `CLAUDE.md`, `docs/idea/22-roadmap.md`, the owning docs, `docs/idea/23-open-questions.md`. A blocking open question: stop and report it.
2. Write `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`: `overview.md` (goal, context, ordered slices, done when, risks), one `<NN>-<aspect>.md` per slice, `status.yml` as the only tracker.
3. Each step ends with `verify:` and an observable check. Reference docs, do not paste them.
4. Each slice names its exclusive file set and the invariants (I1-I7) it must keep.
