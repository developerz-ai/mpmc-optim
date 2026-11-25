---
description: Cut a git release (tag plus GitHub release)
argument-hint: patch | minor | major
---
# /release
Bump: $ARGUMENTS

1. `bun scripts/release.ts <bump> --dry-run`. Refused: fix the cause, never bypass a check.
2. Read `git log <last tag>..HEAD`. Wrong bump for the changes (breaking = major, or minor while 0.x; feature = minor; else patch): say so and stop.
3. Same command without `--dry-run`. It pushes the tag.
4. `gh run watch` on the `release` workflow. Failed gate: no release exists. Report the failure. Fix forward with a new patch tag; never move a pushed tag.
5. Report the release URL.
