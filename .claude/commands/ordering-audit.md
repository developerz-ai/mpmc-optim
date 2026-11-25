---
description: Audit every atomic operation in a file for pairing, strength and tests
argument-hint: <file>
---
# /ordering-audit
Target: $ARGUMENTS

Build one table, one row per atomic operation:

| line | object | op | order | pairs with | what breaks if weaker | test that fails |
|---|---|---|---|---|---|---|

Then list: operations with no pairing edge, orders stronger than needed, fences (TSan-blind), and rows with no failing test. Propose the smallest fix for each. Change nothing without being asked.
