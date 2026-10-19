# Tests

- Unit and contract tests live next to the code in `packages/*/test`.
- `e2e/`: the built binary driven by scripted and adversarial fake agents (macOS, Linux, Windows).
- `agents/`: scenarios on real agents, run nightly and before releases; assert on run state, not on text.
- `../fixtures/formats/`: golden fixtures per format version.

Every decision in `prd/open-questions.md` has a test plan; test names carry the decision id (e.g. `t12_...`).
