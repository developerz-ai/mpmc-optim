---
paths: ["**/*.{cpp,hpp,h,cc}", "**/CMakeLists.txt", "cmake/**", "CMakePresets.json"]
---
# C++ rules
Detail: `docs/idea/10-raii-and-lifetime.md`, `docs/idea/11-cpp23-craft.md`, `docs/idea/18-hardening.md`.

- C++23. Headers are self-contained and include what they use.
- One RAII owner per resource. Rule of zero; otherwise define or delete all five.
- `noexcept` is a promise: state what happens when an element's move or constructor throws.
- No virtual, `std::function` or allocation on the hot path. Policies are template parameters.
- Constrain templates with concepts. Fail at the call site with a readable message.
- No narrowing. Unsigned wrap is deliberate only on tickets, with a comment.
- Macros only for compiler and platform detection, prefixed `MPMC_`.
- `[[assume]]`, `launder`, `reinterpret_cast`, `restrict`: comment why it is valid.
- Warnings are errors on GCC and Clang. A suppression names the reason on the same line.
