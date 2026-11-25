---
description: Design or evaluate a queue algorithm end to end
argument-hint: <algorithm or variant>
---
# /algo
Subject: $ARGUMENTS

1. `architect`: restate the contract, progress guarantee, FIFO strength and cost per op.
2. `lockfree-engineer`: slot state table, pseudocode, every ordering with its pairing edge.
3. `verifier`, without the previous reasoning: find an interleaving that breaks an invariant.
4. Loop 2-3 until a round finds nothing new. A round that resolves nothing: stop and report.
5. Land the result in `docs/idea/03-algorithms.md` and `05-memory-model.md`, with a `// check: run` snippet that is TSan clean.
