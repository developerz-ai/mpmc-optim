---
description: Research a topic and land it in docs/idea, sourced and compiled
argument-hint: <topic or question> [+ URLs]
---
# /idea
Topic: $ARGUMENTS

1. Find the owning doc in `docs/idea/README.md`. Already covered: revise it. New topic: next free number plus a row in the README.
2. Research primary sources. Read the code, not the README. Unsourced number: label it a hypothesis or drop it.
3. Write per the doc rules in `CLAUDE.md`: when to use, when not, how it fails, how to check.
4. Mark snippets `// check: compile` or `// check: run`. Run `bun scripts/check-snippets.ts <file>`.
5. Undecided? Add a row to `docs/idea/23-open-questions.md` with the experiment that settles it.
6. `bin/check`, then have the `reviewer` agent read the diff.
