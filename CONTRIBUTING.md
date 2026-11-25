# 🤝 Contributing

Design stage: the most useful contributions are corrections with a source, counterexample interleavings, and answers to [open questions](docs/idea/23-open-questions.md).

- Branch from `main`, one concern per pull request, conventional commit titles.
- Run `bin/setup` once and `bin/check` before opening a pull request. CI runs the same gate on x86-64 and Arm.
- Follow the doc rules in [CLAUDE.md](CLAUDE.md). Link primary sources.
- Found a wrong ordering? Show the interleaving. A snippet that fails under a checker is ideal.
- Do not copy code from GPL or unlicensed projects. Cite the idea and reimplement it.
- AI-assisted work is welcome. You are responsible for checking it.
