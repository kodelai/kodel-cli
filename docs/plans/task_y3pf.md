# init: do not write MCP permissions into .claude/settings.json

## TL;DR

- `kodel init` stops writing `enabledMcpjsonServers: ["kodel"]` and `permissions.allow: ["mcp__kodel"]` into
  `.claude/settings.json`. It still writes the server entry into `.mcp.json`.
- Instead `init` prints a `note:` that tells the person to enable the server and allow `mcp__kodel` themselves, and the
  `next:` line stops promising that a restart connects the server.
- Small change in `packages/cli/src/init/` and `init.test.ts`. No stored format, no pipeline-core change.
- Critique changed: the `next:` line is reworded (it would mislead), the hint is skipped when `.mcp.json` was not
  written by init, the hint names the personal and the shared settings file, the tests are specified in detail, and
  `addToList` is kept. No finding was rejected as wrong; two are answered as "no change" (see below).

## Decisions needed

None. Choices made without a question to the person: the hint is printed on reruns and dry runs too (like the Codex
trust note); an old `.claude/settings.json` written by an earlier init is left alone.

## Behaviour change

`kodel init --agent claude-code` no longer creates or edits `.claude/settings.json`. When init wrote (or already had) its
own `kodel` entry in `.mcp.json`, it prints a checklist note, in a dry run too:
`Claude Code: make sure the "kodel" server is approved (Claude Code asks once, or list it in enabledMcpjsonServers; a
non-interactive session cannot ask) and that its tools are allowed (permissions.allow: "mcp__kodel"). Put this in
.claude/settings.local.json or ~/.claude/settings.json for yourself, or in .claude/settings.json to share it with the team;
kodel init does not write it. An earlier kodel init may have added these to .claude/settings.json.`
(no words "created"/"updated" in it). The last line is `next: approve the kodel server in the agent, then restart it so that
it connects` (for agents other than Claude Code the old wording stays). When `.mcp.json` was skipped (a different `kodel`
entry, or not plain JSON) there is no hint: the existing "left as it was" note already says what happened.
Everything else init writes is as before. Codex and OpenCode write no permission entries (OpenCode's `enabled: true` is a
field of the server entry, not a grant).

## Risks and invariants

- Principle 6 (humans decide trust): the change goes in this direction; init no longer grants the agent anything.
- Stored data and compatibility: not affected. `.claude/settings.json` is a user file, not run history; no `v` field, run
  state, journal, snapshot or report is touched, so no migration or golden fixture.
- pipeline-core gets no I/O; only `packages/cli/src/init/` changes.
- Hooks write `.claude/settings.local.json`, a different file; the tests assert that file holds no permission either.
- The old init decision (`docs/plans/nado_dobavit_komandu_init_*.md`, lines 36, 64, 78) is superseded by this task; that
  historic plan is left as it is (a record), and the final report says so.
- The repository's own `.claude/settings.json` has the same two entries; it is hand-maintained and not edited (AGENTS.md).
- Real-agent test `tests/agents/hooks.test.ts` runs `init` then `claude -p`: after the change the kodel server is not loaded
  there. It only checks `.kodel/sessions.jsonl` written by the hook, so it is unaffected; verify by reading it, and check
  that `tests/README.md` (line ~64) still describes the flow correctly. Plain `bun test` does not run it.

## Acceptance criteria and tests

All in `packages/cli/test/init.test.ts` (no decision id applies; the names follow the file's style).
- `claude_code_gets_the_server_and_the_config_but_no_permission` (replaces
  `claude_code_gets_the_server_the_permission_and_the_config`): `.mcp.json` has the entry; `.claude/settings.json` does not
  exist; `.claude/settings.local.json` (hooks) contains neither `enabledMcpjsonServers` nor `mcp__kodel`; a `--no-hooks` run
  leaves `.claude/` without settings files.
- `what_the_person_wrote_stays` (updated): the whole text of `.claude/settings.json` is identical before and after.
- `an_old_grant_written_by_an_earlier_init_stays`: a file with the old init output is byte for byte unchanged.
- `init_tells_the_person_to_enable_the_server_and_allow_its_tools`: with claude-code, `out` has `note:`,
  `enabledMcpjsonServers`, `mcp__kodel`, `settings.local.json`; with `--agent codex,opencode` it has neither
  `enabledMcpjsonServers` nor `mcp__kodel`; with `claude-code,codex` the note appears once; a `--dry-run` and a rerun
  print it too. Refutation: the test fails if the note is printed for every agent or only outside a dry run.
- `no_enable_hint_when_the_server_entry_is_kept` (extends `settings_are_not_touched_when_the_server_entry_is_kept`):
  `.claude/settings.json` absent, no `mcp__kodel` in the output; same for a `.mcp.json` that is not plain JSON.
- `the_next_line_asks_to_approve_the_server_for_claude_code` (output of a real run has `approve`, and a codex-only run keeps
  the old wording).
- `a_value_of_the_wrong_type_is_not_replaced` (renamed `a_json_value_of_the_wrong_type_is_not_replaced`): only the
  `.mcp.json` half stays (`mcpServers: []` gives "is not an object").
- `a_second_run_changes_nothing`: `.claude/settings.json` leaves its file list; `again.out` still has no `created|updated`.
- `bun run typecheck`, `bun run lint`, `bun test`, `bun run build && node scripts/check-artifact.mjs` pass.
- Manual (final gate): `kodel init --agent claude-code` in a fresh folder: no `.claude/settings.json`, the note is printed,
  Claude Code asks to approve the server on the next start. A test cannot show that Claude Code's key names in the hint are
  still right; the manual run does.

---

## Steps

1. `agents.ts`: in `claudeCode.connect` delete the `settings.json` block and the "was not changed either" branch (and its
   comment). If the `.mcp.json` change is not `skipped`, push the hint to a new `hints: string[]` on `Context`
   (`files.ts`). Drop the `addToList` import.
2. `index.ts` `report`: print each hint as `note: ...` (dry run too); make the `next:` line depend on whether Claude Code is
   among the agents.
3. Keep `addToList` in `files.ts` unless lint or typecheck flags it as unused (a later plan reuses it).
4. Update `init.test.ts` as listed; re-grep it for `settings.json` and `mcp__kodel` afterwards.
5. Read `tests/agents/hooks.test.ts` and `tests/README.md`; change the README only if it says init pre-approves the server.

## Affected files

- `packages/cli/src/init/agents.ts`, `packages/cli/src/init/index.ts`, `packages/cli/src/init/files.ts` (`Context.hints`)
- `packages/cli/test/init.test.ts`
- maybe `tests/README.md`

## Rejected review findings

- `[scope]` the `enableHint` field on the adapter is more than needed: accepted in the other direction. A `hints` list on
  `Context`, filled by `connect`, replaces the adapter field, because the hint depends on the `.mcp.json` outcome.
- `[gaps]` add a clause telling old-init projects to remove the shared grant: done as the last sentence of the note, not as
  a separate step.
- `[gaps]` a test for `hooks.ts:38` "is not a list" (optional): not done, out of scope for this task.
- `[invariants]` name the superseded decision id: the decision log is not in the repository and the old plan has none; the
  old plan is only mentioned in the final report.

## Findings in the code

- `packages/cli/src/init/agents.ts:67-87`: `claudeCode.connect` writes `.mcp.json`, then `.claude/settings.json` with
  `addToList(... "enabledMcpjsonServers" ...)` and `permissions.allow: ["mcp__kodel"]`; a skipped `.mcp.json` skips it too.
- `packages/cli/src/init/index.ts:240-266`: `report` prints the notes and `next: restart the agent so that it connects the kodel server`.
- `packages/cli/src/init/files.ts:111`: `addToList`, used only by `agents.ts`.
- `packages/cli/test/init.test.ts:75-77, 88, 106-115, 150-163`: the tests that rely on the old behaviour (line numbers are
  approximate); lines 424 and 479-489 only use `settings` files for hooks.
- `tests/agents/hooks.test.ts:57-63,114`: real-agent test that runs init then `claude -p`; other real-agent tests copy the
  repository's own settings (`harness.ts:131`), not init output.
- No doc in `docs/`, `README.md`, `adapters/` or `skills/` says init writes permissions; only historic plans do.
