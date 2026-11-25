# ⚡ mpmc-optim

> **A C++23 multi-producer multi-consumer queue, designed to be fast, provably correct and honestly measured.**

[![ci](https://github.com/developerz-ai/mpmc-optim/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/mpmc-optim/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🚧 **Status: design stage.** This repo holds the engineering notes and agent setup. There is no library to use yet, and every performance number is a target unless a source is cited.

## 🧠 The idea

A lock-free queue that passes its tests on x86 can still be wrong on Arm, and published benchmarks rarely compare. So we write down the whole craft first: algorithms, memory orderings, allocation, hardware, verification and measurement. Then we build from it, with the checkers in place before the queue.

## ✨ Principles

- ✅ **Correct first:** every ordering names the edge it creates and the test that fails without it.
- 📦 **Bounded by default:** no allocation on the hot path.
- 💤 **Lazy memory:** reserve early, commit on touch, prefault only if you ask.
- 🏎️ **Mechanical sympathy:** cost is counted in contended cache lines.
- 🪶 **Pay for what you use:** policies resolve at compile time.
- 📏 **No claim without evidence:** cited, measured, or labelled a target.

## 📚 Docs

| Topic | Start here |
|---|---|
| 🎯 Goals, invariants, vocabulary | [Vision](docs/idea/01-vision.md) |
| 🔀 Algorithms, API, memory model, reclamation, waiting | [The queue](docs/idea/README.md#-the-queue) |
| 🧱 Arenas, allocators, cache-friendly and lazy allocation, RAII, C++23 | [Memory and lifetime](docs/idea/README.md#-memory-and-lifetime) |
| ⚙️ CPU, NUMA, SIMD | [Hardware](docs/idea/README.md#-hardware) |
| 🛡️ Static analysis, sanitizers, Valgrind, model checking | [Correctness](docs/idea/README.md#-correctness) |
| 🏎️ Benchmarks, profiling, Ninja, ccache, LTO, PGO, BOLT | [Performance and shipping](docs/idea/README.md#-performance-and-shipping) |
| 💡 How others do it, tricks, papers | [Direction](docs/idea/README.md#-direction) |
| 🗺️ What comes next | [Roadmap](docs/idea/22-roadmap.md) · [Open questions](docs/idea/23-open-questions.md) |

C++ snippets marked `// check:` are compiled by CI with GCC and Clang, on x86-64 and Arm. Those marked `run` are executed too.

## 🤖 Built for coding agents

[`CLAUDE.md`](CLAUDE.md) routes, `.claude/agents/` holds specialists (lock-free, memory, SIMD, performance, verification, review), `.claude/commands/` holds workflows (`/algo`, `/ordering-audit`, `/hunt`, `/bench`, `/idea`, `/planx`, `/release`), and `.claude/rules/` loads C++ rules by path.

## 🚀 Work on it

```bash
bin/setup                                # check tools, run the gate
bin/check                                # the gate CI runs
bun scripts/release.ts patch --dry-run   # cut a release
```

Needs [Bun](https://bun.sh), Clang and GCC with C++23. Bun is repo tooling only. See [CONTRIBUTING.md](CONTRIBUTING.md).

## 📄 License

[MIT](LICENSE)
