# Configurable storage of run history (`storage: project | home`)

## TL;DR

- A new scalar key `storage` in `.kodel/config.yaml`: `project` (default, as today) or `home` (`~/.kodel/projects/<project_id>/`). In
  `home` mode `runs/`, outside-a-run `proposals/`, `start.lock` and `sessions.jsonl` live in the home tree; config, pipelines, tasks,
  `worktrees/` and `hooks.log` stay in the project.
- The project id is a **stable `project_id` in the committed config** (the person's choice): renaming, moving or re-cloning keeps the
  history. `kodel init --storage home` writes both keys into a new config; an existing config is edited by hand.
- **One place, named by the config**; the person moves existing runs by hand when switching.
- **What this pass changed:** `root` in `meta.json` is now an honest convenience (not a security claim); two clones make two runs
  (serialised by one lock); outside-a-run proposals are stored per checkout; the config spelling is made unambiguous so the hook and
  the server cannot disagree; the e2e moves into `check-artifact.mjs` (already in CI); a branch checkout that flips the mode is
  named as a decision (Decision 11); the cost of the id-in-config choice is stated (Decision 12); a group-to-decision map is added.
- Risks: `home` has no deny rule until the person adds one; the agent can edit `storage`/`project_id` (accepted); a checkout of a
  branch without the keys flips the mode and stops a running server until it is restarted; the clone rule is a convenience.

## Decisions needed

Answered by the person (kept so the plan is self-contained):

1. **Place: `~/.kodel/projects/<project_id>/`**; by default apart from the integrity hashes (`~/.local/state/kodel`).
2. **Override: `KODEL_STATE_DIR`** replaces `~/.kodel` as the base. With it set, history and hashes share one base; `XDG_STATE_HOME`
   moves the hashes but not the history. Documented.
3. **`sessions.jsonl` and outside-a-run `proposals/` move** with `runs/` (per-run proposals are inside the run folder).
4. **Key: `storage: project | home`** (a scalar; a later object form stays compatible).
5. **One place is read, the one named by the config**; the other is not seen; switching = the person moves runs by hand.
6. **Stable `project_id` stored in the config** instead of a path-derived id.
7. **No extra protection** against an agent editing `storage`/`project_id`; "only a person changes the setting" is met by convention
   (AGENTS.md) and the pull request says so plainly against the task text. **Team-wide, per branch.** **`~/.kodel` is shared with
   another product.** **No config version bump.** **One task.** **Decision id:** the PR records it before merge.

Open, with my choice if the person does not answer:

8. **How a project gets `project_id`.** `kodel init --storage home` writes `storage: home` and a new `project_id` into a *new* config
   (`<folder name lowercased, then sanitized to [a-z0-9._-], leading non-alphanumerics stripped, at most 24 characters, or "p" if nothing
   is left>-<8 random characters>`); `kodel init` alone writes neither (a `project`-mode project stays readable by an older kodel). For
   an existing config nothing is rewritten: with `storage: home` and no `project_id`, every command prints the two lines to add and
   `pipeline_start` fails with `CONFIG_INVALID`. `kodel init --storage home` and the docs say: **upgrade the team's kodel before
   committing the keys**, an older build refuses the config ("unknown key") on every command. If no answer: as written.
9. **Clones with one `project_id` on one machine.** They share the history tree. Hashes and seals are keyed by `project_id` (Decision 10), so no false
   "changed outside kodel". Each run's `meta.json` records `root`, the main checkout that made it (after the worktree mapping; compared with
   `sameDir`, case-folded on macOS/Windows, so `/var` vs `/private/var` is one). `pipeline_start` (`findActive`/`findLatest`) reuses only
   runs whose `root` matches; `resume`/`next_step` on a foreign run fail with "this run belongs to <root>"; `gate`/`ack`/`seal` by id work and
   print a warning that the run is foreign. **Two clones starting a task each get their own run** (the shared `start.lock` only serialises
   them). Outside-a-run proposals are stored per checkout (`proposals/<checkout key>/<name>.json`, key = `sha256(root)` prefix), so one clone
   cannot overwrite or apply another's. `root` is advisory: it sits in the agent-writable `meta.json` and is **not a security boundary**; it
   only stops honest clones from stepping on each other. After a project move or re-clone every old run reads as foreign (finished runs stay
   visible; an open run could not resume after a move anyway because its `workdir` is absolute). If no answer: as written.
10. **Hash keys.** `project` mode: unchanged (path). `home` mode: `sha256("project\0" + project_id)`; a moved project keeps hashes and seals.
    Switching modes, or editing `project_id`, makes moved runs read as *unknown* and be adopted on first use (a trust-reset path, named in
    the docs next to "deleted hash then edit is adopted"); `kodel status` says how many runs have no recorded hash. A relative
    `KODEL_STATE_DIR` stays accepted for the hashes as today; for the history it is `CONFIG_INVALID`. If no answer: as written.
11. **A checkout flips the mode.** The keys are committed, so a branch without them reads as `storage: project`. A running server refuses every
    call that opens or starts a run with `CONFIG_INVALID` ("storage changed since the server started; restart it"), and `kodel status` always
    prints the mode and the place it reads (so the flip is visible); the docs say to commit the keys on the main branch before branching.
    Alternatives: a per-checkout uncommitted override (an env var, e.g. `KODEL_STORAGE`) or a per-call re-read that follows the checkout. **Recommend
    the refusal**: it never writes to a place the person did not expect. If no answer: the refusal.
12. **Cost of Decision 6, for the person to reverse knowingly.** The id-in-config choice is what creates the clone machinery above: `root` in
    `meta.json`, the reuse filter, per-checkout proposals, `project_id`-keyed hashes, the `cwd` filter of the session index, `kodel init --storage`.
    A path-derived id (the task text) would drop all of it but loses history on a move. **Recommend keeping Decision 6.** Say "reverse" to switch.
13. **A human-only `kodel storage home|project|move` command** (edits the config, moves runs and the index): not built. The config stays the
    person's file and a switch is documented as exact `mv`/append lines plus a server restart. **Recommend not building it now.**
14. **Scope.** One task as decided; the steps are two phases and phase A (the core, with the two one-line texts) can land alone. If the PR is
    too large, the cut line is the clone rules (Decision 9) and the session-index move. **Recommend one PR in two phases.**

## Behaviour change

- Nothing changes without the key. With `storage: home`, `runs/`, outside-a-run proposals, `start.lock` and `sessions.jsonl` are in
  `~/.kodel/projects/<project_id>/` (0700), never committed, untouched by `git clean` or a branch switch.
- `status`, `report`, `wait`, `pipeline proposals ...` and the MCP tools look only in the configured place. `kodel status` prints the mode, the
  place (the real folder on a terminal, `<home>` otherwise), "foreign" runs, and how many runs have no recorded hash.
- A run that cannot be found says it may be kept in the other place, by another user, or that `KODEL_STATE_DIR` differs; `kodel wait` fails at
  once with this hint instead of waiting. A hash with no run folder is never reported as "changed outside kodel".
- Switching: runs in the old place are not seen. To carry them: move `runs/<id>`, append the old `sessions.jsonl` to the new one, move
  `proposals/`, restart the server (the docs give the lines). Open runs do not resume after a move (absolute `workdir`), as today.
- Renaming, moving or re-cloning keeps the history and, in `home` mode, the trust; old runs read as foreign (Decision 9).
- Two clones share the history; each starts and continues only its own runs.
- Sandboxed agents: the hook (write), `kodel wait` and the CLI (read) and the MCP server need the home tree reachable. A Codex
  `workspace-write` sandbox or a Claude Code sandbox that confines writes to the workspace cannot write `~/.kodel`: the hook then logs
  and skips (sessions are not recorded), and `kodel wait` says the run is not found there; the docs list this.

## Risks and invariants

- **Principle 4.** Path logic is in `@kodel-ai/local`. `pipeline-core` changes only the text of instruction 5 (`tools.ts:69`, generic, still
  forbidding reading the run files). No new error code (`CONFIG_INVALID` reused), no change to `run.ts`, none to `HookContext`.
- **Principle 6.** `storage` and `project_id` are in the person's config; no MCP tool takes them. An agent that edits them moves new data
  out of the deny rule (`Edit/Write(.kodel/runs/**)` covers `project` only) or points at another project's id. The foreign-root rule is a
  convenience and does **not** limit that (Decision 9). Accepted (Decision 7); the docs give the deny rules for the home tree and for
  `.kodel/config.yaml` (the deny rules live in the person's `.claude/settings.json`; nothing ships them). AGENTS.md lists both keys next to
  `decisions`. Decisions on a foreign run print a warning.
- **Principle 8 and stored data.** One additive field, `root`, in `meta.json` (`META_VERSION` stays 2; before the first release formats may
  break; a missing `root` reads as "owned"); proposals under `proposals/<checkout key>/`; no field is renamed or retyped; old runs stay
  readable; golden runs of `fixtures/formats/v1` open from a copy in a home-style tree. Rule 3: missing folder = "cannot read" with the hint;
  hash mismatch = "changed outside kodel"; no hash = unknown.
- **`project_id` is a folder name, so it is validated** with one function wherever it is read: `^[a-z0-9][a-z0-9._-]{2,63}$`, no `..`, no
  trailing dot, no Windows device name (`con`, `prn`, `aux`, `nul`, `com1`-`com9`, `lpt1`-`lpt9`, case-insensitive, also with an extension);
  uppercase is refused. The base is `realpath(<base>)` (a symlinked `~/.kodel` is allowed); `projects/<id>` and below must not be a link
  that leaves it.
- **Config spelling is unambiguous.** `storage` and `project_id` must be top-level scalar lines (`storage: home`, optional quotes, trailing
  comment). The strict loader refuses a config whose parsed `storage`/`project_id` the small line matcher cannot read (flow mapping, anchors,
  multi-line scalars), with "write it as `storage: home` on its own line". So the hook (which uses the matcher, to stay in its budget) and
  the server can never disagree, and the matcher is also the fallback for read commands when the strict parse fails, with the same enum and
  id validation (a value the matcher accepts and the parser refuses is refused; a matcher `project` never overrides a parser failure).
- **Integrity.** `FileIntegrity` keeps a separate key (Decision 10); `state.json` and seals are covered as today. Adoption of an unseen run
  is today's trust-on-first-use.
- **The store has one root per kind.** `FileStore` takes `runsRoot`, `proposalsRoot`, `lockRoot` and a `checkoutRoot` (used by
  `findActive`/`findLatest` to skip foreign runs; `listRuns` returns them, marked). The embedder API default stays the project place as
  today; the CLI/MCP paths always resolve the place and pass it (a test greps that `cli.ts` builds no host without it); the base is passed
  explicitly like `integrityDir`. `createRun` makes the run directory with a non-recursive `mkdir` and retries on `EEXIST`.
- **Creation.** The home place is created by one function, once, with mode 0700 (`~/.kodel` only if missing); every creator calls it.
- **Environment.** `resolveBase(env, home = homedir())` keeps the `(env, home)` injection and uses `os.homedir()`. Empty `KODEL_STATE_DIR`
  falls back; relative is `CONFIG_INVALID` for the history; an empty `homedir()` fails only `storage: home`. Errors are carried until first
  use (hosts are built synchronously) and never thrown from a constructor, so `kodel mcp` starts.
- **Paths in text.** `host.ts:366,:1680` (and `:1257,:1350,:1720`) scrub `root` to `.`; the home base, raw and realpath forms, is scrubbed to
  `<home>` in the same places; a test scans every file a full run writes for both forms.
- **Session index.** The hook resolves the place with the matcher and writes there, logging and skipping on failure. The local Claude Code
  collector gets the index path through a constructor option (local package; the core contract is unchanged); readers ignore lines whose
  `cwd` is outside this checkout and its worktrees, and `registeredSession` scans back in chunks (bounded, 1 MB) until it finds a matching
  line instead of a fixed 64 KB tail, so another clone's sessions cannot hide this clone's.
- **Environments.** The MCP server (`.mcp.json`), the person's shell, the agent's shell and the hook may differ in `KODEL_STATE_DIR`;
  the docs say to set it in the shell profile (prominent in the waiting flow, since `kodel wait` is the agent's hand-off command);
  `engineEnv` strips `KODEL_*` from engine-run commands.

## Acceptance criteria and tests

Group -> Decision map (the test names keep the `storage_` prefix until the PR records the decision id, then take it): 1->D1,2,3; 2->D1-3;
3->D6,8; 4->D9; 5->D5; 6->D4,5; 7->D4,8; 8->D11; 9->D2; 10->D10; 11->D7; 12->D3; 13->(guard); 14->D1-11.

Each group names what would refute the design.

1. Default: no `storage`: data as today; golden runs open from a copy in a home-style tree; `kodel init` without the flag writes a config
   byte-identical to today's; with only `KODEL_STATE_DIR` set and `storage: project` hash behaviour is unchanged; the default hash dir is not the
   history base. `storage_default_is_project`, `storage_golden_fixture_opens_from_home`, `storage_init_without_flag_is_unchanged`,
   `storage_state_dir_alone_keeps_hashes`, `storage_default_hash_dir_separate_from_history` (refuted if a default project changes).
2. `storage: home`: runs, outside-run proposals, `start.lock` and `sessions.jsonl` are under the home tree; `.kodel/runs` and `.kodel/proposals`
   do not exist; `git status --porcelain` shows only `config.yaml`, `pipelines/`, `tasks/`, `worktrees/`, `hooks.log`; no file a full run writes
   contains the home base (raw or realpath); modes are 0700, a looser pre-existing directory is left alone, `~/.kodel` is not chmodded (POSIX-only);
   two processes creating the place at once leave 0700. `storage_home_writes_outside_repository`, `storage_proposals_move_with_home`,
   `storage_start_lock_follows_place`, `storage_session_index_moves_with_home`, `storage_no_home_path_in_written_files`, `storage_home_dirs_are_0700`,
   `storage_concurrent_place_creation` (refuted if anything but the listed files stays in the repository).
3. `project_id`: `kodel init --storage home` writes valid keys; an existing config is not rewritten; `home` without an id fails with the two lines to
   add; validation rejects `..`, slashes, a trailing dot, uppercase, over-long and device names (also with an extension); generation lowercases then
   sanitizes, falls back to `p` (non-ASCII-only folder, a device name, a name shorter than 3 characters) and really uses the random part (mocked
   RNG); a symlink leaving the base is refused, a symlinked `~/.kodel` is allowed (symlink tests skipped on Windows CI); a moved or renamed project
   keeps the history and the trust; worktrees (linked, run worktrees, `status`/`wait`/the hook from a worktree with another cwd) read the main
   checkout's config. `storage_init_flag_writes_keys`, `storage_init_keeps_existing_config`, `storage_home_needs_project_id`,
   `storage_project_id_validation`, `storage_project_id_generation`, `storage_symlink_rules`, `storage_history_survives_project_move`,
   `storage_worktrees_share_project_id` (refuted if a move or rename loses history or trust, or an invalid id builds a path outside the base).
4. Clones: two clones with one id share trust (alternating runs gives no false "changed outside kodel"); B's `pipeline_start` for the same pipeline
   and task starts its own run; two parallel starts from two real processes (a barrier in the start lock) make **two** runs with distinct ids and a
   consistent listing; `createRun` retries on `EEXIST`; `resume`/`next_step` on a foreign run fail with "belongs to <root>"; `gate`/`ack`/`seal` by id
   work and warn; a run made in a worktree is not foreign to the main checkout and the reverse; `KODEL_ROOT` on a worktree is handled; a moved project
   shows old runs as foreign and a new start makes a new run; a missing `root` reads as owned and a hand-edited `root` is documented as advisory;
   proposals of two clones with one name do not collide and cannot be applied from the other. `storage_clones_share_trust`, `storage_foreign_run_not_reused`,
   `storage_two_clones_two_runs_serialised`, `storage_create_run_retries_on_eexist`, `storage_foreign_run_not_continued`,
   `storage_foreign_run_decisions_warn`, `storage_worktree_run_not_foreign`, `storage_explicit_root_handled`, `storage_moved_project_runs_read_foreign`,
   `storage_missing_root_reads_as_owned`, `storage_proposals_per_checkout` (refuted if a clone can step on another's run or proposal).
5. Single place, table-driven over every surface that finds runs (`status`, `report`, `wait`, `pipeline proposals show|apply|discard`, the MCP tools,
   `findLatest`, the session index): each reads only the configured place (a run planted in the other place is invisible); `mv` makes a run visible; moving
   within `home` between two ids works; a hash with no run folder is not "changed". `storage_surface_<name>_reads_only_configured_place`,
   `storage_mv_makes_run_visible`, `storage_mv_between_ids`, `storage_hash_without_run_is_not_changed` (refuted if any surface shows the other place).
6. Store: `runDir`, `listRuns`, `findLatest`, `withLock`, `removeRun`, proposals and the snapshot readers use the given roots and the `checkoutRoot`;
   a check over `packages/*/src` (a regex for `join(...,"runs"|"proposals")` including `path.join`, template strings and `.kodel/runs` literals, with the
   listed exceptions for the project default and the texts) finds no stray path; `cli.ts` builds no host without resolved storage; per-run proposals stay in
   the run folder; the history collector gets the index path from its constructor option. `storage_store_uses_given_roots`, `storage_no_hardcoded_runs_path`,
   `storage_cli_always_resolves`, `storage_run_proposal_follows_run`, `storage_collector_gets_index_path`
7. Config: `storage: cloud`, an unknown key, a bad `project_id`: refused naming the key; an unreadable config makes `pipeline_start` refuse and never falls
   back, while read commands use the matcher; a table (comments, quotes, CRLF, BOM, tabs, duplicate key, anchor, multi-line scalar, flow mapping
   `{storage: home}`, `storage: "home"  # c`, `homes`, nested `storage:`) pins that the loader and the matcher agree or that the loader refuses; `gate`, `resume`,
   `ack`, `seal`, `next_step`, `report_result`, `complete_step`, `wait`, `pipeline proposals` still work on existing runs of the configured place with a broken
   config. `storage_invalid_value_is_refused`, `storage_broken_config_never_falls_back`, `storage_matcher_agrees_with_loader`,
   `storage_commands_work_on_broken_config` (refuted if a broken config reads as `project`).
8. Server vs CLI vs checkout: after `storage`/`project_id` changes (a branch checkout included), **every** tool of the registry that opens or starts a run
   refuses with the restart message (a table over the registry that fails when a tool is added without a row); a change between the check and the first
   write cannot reach the old place; `kodel status` prints the mode and place; a started run keeps working after a restart; the CLI against the old place shows the
   "elsewhere" hint; `kodel wait` fails at once with it. `storage_changed_under_running_server_refuses_all`, `storage_refusal_table_covers_registry`,
   `storage_change_between_check_and_write`, `storage_status_prints_mode_and_place`, `storage_cli_server_mismatch_hint`, `storage_wait_fails_fast_elsewhere`
9. Env and base: `KODEL_STATE_DIR` replaces `~/.kodel`; empty falls back; relative is `CONFIG_INVALID` for the history only, lazily, `kodel mcp` still starts; a
   file as the base; `homedir()` with the `(env, home)` injection (empty fails only `storage: home`); a missing/unreadable base fails `storage: home` at `start`
   and does not affect a default project; an unwritable base fails `createRun` naming the home place; one `stateDir` for hashes and history in the harness;
   env mismatch between server, hook and CLI is soft; `engineEnv` strips `KODEL_*`. `storage_state_dir_is_base`, `storage_empty_state_dir_falls_back`,
   `storage_relative_state_dir_history_error`, `storage_homedir_injection`, `storage_base_not_a_directory`, `storage_default_ignores_foreign_kodel`,
   `storage_unwritable_home_does_not_fall_back`, `storage_harness_agrees_on_base`, `storage_env_mismatch_is_soft`, `storage_engine_env_strips_kodel`
10. Integrity and seals: an edit of a home run's `state.json` is "changed outside kodel", also with a shared base; a deleted `state.json` is not fresh; a run with
    no hash is unknown, adopted on first use, and a later edit is then detected; a modified `state.json` moved across modes is adopted (documented); deleting
    the hash then editing is adopted (documented, same as today); a tampered `seal.json` is detected in `home` mode, also after a move; `status` counts runs with
    no recorded hash. `storage_home_integrity_detects_edit`, `storage_shared_base_detects_edit`, `storage_deleted_state_not_fresh`,
    `storage_adopt_then_edit_detected`, `storage_moved_modified_state_is_adopted`, `storage_deleted_hash_then_edit_is_adopted`, `storage_seal_survives_move`,
    `storage_status_counts_unhashed_runs` (refuted if integrity gives a false "fine" in `home` beyond the documented trust-reset paths).
11. Texts: instruction 5 stays generic in both modes and forbids reading the run files; the "elsewhere" hint at the host and CLI `UNKNOWN_RUN` sites
    (`pipeline-host.ts:554,694`, `cli.ts` `openRun`, `agent-decisions.ts:44,99`); the home base is scrubbed from tool errors and journal lines (forced
    EACCES/ENOSPC); `kodel status` prints the real path only on a terminal and `<home>` otherwise; the person's dialog names the real folder; no tool schema has
    `storage` or `project_id`; the docs have no statement from a forbidden-string list (`runs live in the project`, `waits in .kodel/proposals/`, ...) and carry
    the required lines (switching, deny rules, restart, upgrade-before-commit). `storage_agent_text_generic`, `storage_not_found_hint`,
    `storage_errors_scrub_home_path`, `storage_status_path_only_on_tty`, `storage_dialog_names_real_folder`, `storage_not_agent_settable`, `storage_docs_consistency`
12. Hook and index: the hook writes to the configured place using the matcher, logs and skips on a failed write; the built hook bundle contains none of the module names
    yaml/zod/store (a grep in `check-artifact.mjs`) and stays within its size and time budgets; readers ignore lines with a `cwd` outside this checkout and
    its worktrees; the tail scan finds this clone's line even when another clone's lines fill 64 KB. `storage_hook_follows_config`, `storage_hook_logs_failed_write`,
    `storage_hook_bundle_clean_and_in_budget`, `storage_index_ignores_foreign_cwd`, `storage_index_scan_back`
13. `HISTORY_PATH_OUTSIDE_PROJECT` is untouched. `storage_session_log_guard_unchanged`
14. End to end: `scripts/check-artifact.mjs` (already run by CI on the three OSes) gets a second scenario with `storage: home`, a temporary `KODEL_STATE_DIR`, start,
    gate, resume, `status` and the hook on the built `dist/kodel.js` on plain Node; the existing scenario gets the temporary base too, so nothing writes the real
    `~/.kodel`; `tests/agents/harness.ts` passes the base explicitly. No separate gated test and no workflow change.

Not shown by a test (stated in the docs): an agent editing `storage`/`project_id` and nothing alerting the person (accepted); the `.env` benefit; path length on Windows;
a full or read-only disk; `~/.kodel` on another volume; two servers appending to one `sessions.jsonl` under real contention; the older-kodel version skew (needs a pinned
old binary).

---

## Steps

Phase A (the core; can land on its own): 1-5 and the two texts of step 7. Phase B (hardening, clones, docs): the rest.

1. `config.ts`: `storage` (`project|home`), `project_id`, strict zod, the spelling rule; `ProjectConfig`.
2. New `storage-paths.ts` (no yaml/zod/store imports): `resolveBase(env, home)`, the line matcher, `validateProjectId`, `generateProjectId`, `placeRoots`, `ensureHomePlace`
   (0700, once), `hashKey`, `checkoutKey`; `integrity.ts` uses `hashKey` and carries an env error until first use.
3. `store.ts`: `runsRoot`, `proposalsRoot`, `lockRoot`, `checkoutRoot`; `createRun` records `root`, uses non-recursive `mkdir` with retry; proposals under `<checkout key>/`; every
   directory creation goes through `ensureHomePlace`.
4. `pipeline-host.ts`, `host.ts`, `cli.ts`: resolve the place before the store (strict parse, matcher fallback); pass the base like `integrityDir`; `findActive`/`findLatest` skip foreign
   runs; continuing a foreign run fails clearly; every opening/starting call compares the place with the startup place and refuses on a change; `kodel wait` fails at once with the hint.
5. `hooks/session-registrar.ts` (resolves the place itself), `history/claude-code/locate.ts` and the collector constructor, `executor.ts` (configured index, `cwd` filter, scan back).
6. `packages/cli/src/init/index.ts`: `--storage home` writes `storage` and `project_id` into a new config; an existing config is not rewritten and the output names the lines and the
   upgrade-before-commit rule.
7. `cli.ts` `status` (mode, place, TTY rule, foreign, unhashed count), `elicit.ts:634` (real folder), `tools.ts:69` (generic; both in phase A), the "elsewhere" hint at the listed sites; the scrub of
   the home base at `host.ts:366,:1680` and the other `describeError` sites; update the pinned tests (`service.test.ts:682`, `claude-code-wait.test.ts:71`, `hardening.test.ts` if it relies on the layout).
8. Docs: a section in `docs/history.md` (where it is kept, `kodel init --storage home`, switching with the exact move/append lines and the restart, files that stay in the project, team-wide
   and per-branch keys, upgrade before commit, clones and forks, deny rules for the home tree and `config.yaml`, `KODEL_STATE_DIR` and its asymmetry with `XDG_STATE_HOME`, the environments,
   sandboxed agents, CI, hashes keyed by `project_id` and the trust-reset paths); fix only statements that became false (`docs/history.md:104,156,205`, `docs/project-root.md:3`,
   `fixtures/formats/README.md:17`, `README.md:13`, `adapters/README.md:23,39`, `tests/README.md:65`, `packages/cli/src/init/index.ts:161`, AGENTS.md "waits in `.kodel/proposals/`" and its rule list,
   `scripts/take-format-fixture.mjs`).
9. Tests as above; a testkit helper that builds a host with a given base directory; `scripts/check-artifact.mjs` and `tests/agents/harness.ts` get a temporary base.

## Affected files

`packages/pipeline-core/src/mcp/tools.ts` (text), `packages/local/src/{config,storage-paths,integrity,store,pipeline-host,host,executor}.ts`, `packages/local/src/hooks/session-registrar.ts`,
`packages/local/src/history/claude-code/{locate,collector}.ts`, `packages/cli/src/{cli,elicit,agent-decisions}.ts`, `packages/cli/src/init/index.ts`, the tests listed,
`packages/pipeline-core/test/service.test.ts`, `packages/local/test/hardening.test.ts`, `tests/agents/claude-code-wait.test.ts`, `tests/agents/harness.ts`, `packages/testkit`,
`scripts/check-artifact.mjs`, `scripts/take-format-fixture.mjs`, `docs/history.md`, `docs/project-root.md`, `fixtures/formats/README.md`, `README.md`, `adapters/README.md`, `tests/README.md`,
`AGENTS.md`. Not changed: `errors.ts`, `run.ts`, the journal records, `.github/workflows/*`, `.gitignore`, `biome.json`, `.claude/settings.json` (a person's file; no deny rules are shipped from `adapters/`),
`skills/`.

## Rejected review findings

Fixed in this pass: agent-writable `root` (stated as advisory, Decision 9); the contradictory clone tests (two clones, two runs); the foreign state after a move (defined and tested); outside-a-run
proposals without an owner (per-checkout folders); `root` definition and `sameDir`; the `createRun` id overwrite (non-recursive `mkdir`); the branch-checkout flip (Decision 11, status header); sandbox
reach and `kodel wait` (Behaviour change, fail fast); silent re-adoption (status count, docs); the store `checkoutRoot` and the collector option; the index tail; decision ids (group map);
the symlink base rule; generation lowercasing; upgrade-before-commit; phase A texts; matcher/loader agreement; test definitions; the e2e location; the gated test (dropped).

Rejected or sent to the person:
- **Ship a deny rule for `.kodel/config.yaml` from `adapters/`**: nothing in `adapters/` ships deny rules (they live in the person's `.claude/settings.json`); the docs give them (Decision 7).
- **A human-only `kodel storage` command / `kodel storage move`**: not built (Decision 13).
- **Drop the matcher and use the strict parser only**: the hook has a size/time budget and cannot import yaml/zod; the matcher stays, with the loader enforcing agreement.
- **Trim validation (device names, symlink rules)**: kept; the id is a folder name on three OSes.
- **A per-checkout uncommitted override or a per-call re-read for the checkout flip**: offered in Decision 11, not built.
- **Split the clone work into a follow-up**: offered in Decision 14; kept in one PR as decided, phase A can land first.
- **Carry the old key's hashes over on a switch**: not built; the trust-reset path is documented and counted by `status`.
- **Raise the 64 KB tail**: replaced by a bounded scan back in chunks.
- Still dropped: dual-place lookup, `project.json`, a salted key, a `runs_place` journal field, a duplicate-id report.

## Findings in the code

- Runs at `join(options.root, "runs", runId)`, `store.ts:149`; the list at `:213`; `findActive`/`findLatest` at `:230-243, :432-446`; per-run proposal at `runs/<id>/pending/proposal.yaml` (`:284-310`; `host.ts:779,799,945,990,1041`);
  outside-a-run proposals at `join(root, "proposals", name + ".json")` (`:312-385`; CLI `cli.ts:785-850`); `start.lock` at `:691`; `lockedRun` makes the folder at `:775-778`; `createRun` at `:189-205` (recursive `mkdir`, then
  a rename over `meta.json`); `newRunId` is ms time plus 4 base36 characters (`:808`); seals at `:526-535`; `runDir` is sync with about 30 callers.
- `FileStore`/hosts are built in sync constructors (`pipeline-host.ts:116-123`, `host.ts:292-312`, `cli.ts:187`, `testkit/src/local-engine.ts`, `tests/agents/harness.ts:419`; about 125 sites); `cli.ts` `project()` is async;
  `start` reads the config (`pipeline-host.ts:500-508`); `mcp` falls back to defaults only for `agent_hints` and `decisions` (`cli.ts:286-299`); `runExists` uses `findActive` (`pipeline-host.ts:624-628`).
- Run reuse: `pipeline-host.ts:680-689`, `host.ts:660-667`; `verifyWorkdir` refuses a foreign worktree with `WORKDIR_INVALID` (`worktree.ts:239-253`); `sameDir` folds case on win32/darwin (`worktree.ts:45-53`); `meta.json` has
  `workdir?` and `branch?`, and the code says the agent can rewrite it while `workdir` is read from the hash-protected state (`host.ts:631-636,:646-648`).
- Integrity: `integrity.ts:35-41` (state dir, accepts a relative value), key `sha256(realpath(storeRoot))` (`:48-74`), files `<dir>/<key>/<run id>.sha256`; no hash is unknown (`:120-124`); first-use adoption
  `host.ts:1099-1103`; `FileIntegrity` is built in the `LocalHost` constructor (`host.ts:297-301`); `engineEnv` strips `KODEL_*` (`host.ts:173-187`).
- Config: strict zod (`config.ts:128-195`); an unknown key names the key and says it may be written for a newer kodel (`:233-241`); `kodel init` writes a **new** config only (`init/index.ts:59-70,115-130`).
- Error texts scrub `root` only at `host.ts:366` and `:1680`; other `describeError` sites `:1257`, `:1350`, `:1720`; `UNKNOWN_RUN` at `service.ts:273`, `pipeline-host.ts:554,694`, `cli/src/agent-decisions.ts:44,99`, `cli.ts` `openRun`.
- `project-locate.ts` skips `$HOME` as a marker (`:92-98`); `via: "explicit"` skips the worktree mapping (`:80-85`); a linked worktree maps to the main checkout's data dir (`:104-111`); `hooks/project.ts:19-37` returns the outermost project, so the hook reads the main checkout's config.
- `sessions.jsonl`: written by the hook (`hooks/session-registrar.ts:13-34`, `appendFile`, absolute `transcript_path` and `cwd`; `HookContext` carries only `root`, `hooks/run.ts:88-92`), read by
  `history/claude-code/locate.ts:77-99` and `executor.ts:34,:119-135` (64 KB tail; `ExecutorContext.root`, `host.ts:1798`); the collector is built without project knowledge (`history/index.ts:11-15`, `collector.ts:39-43`);
  hook budgets in `scripts/check-artifact.mjs:63-64`.
- `HISTORY_PATH_OUTSIDE_PROJECT` guards the agent's session store only (`history/claude-code/collector.ts:57-82`, `scope.ts`).
- CI runs `bun test` and `node scripts/check-artifact.mjs` on the three OSes (`.github/workflows/ci.yml:23,26`); `scripts/test-setup.ts:7` already sets `KODEL_STATE_DIR` to a temp dir for every `bun test`; `tests/e2e/` holds only `.gitkeep`.
- `.claude/settings.json` denies only gate/ack/seal/resume and `Edit/Write` on `.kodel/runs/**` and `.kodel/pipelines/**`; `adapters/` ships no deny rules; `tests/agents/claude-code-wait.test.ts:71` treats `.kodel/runs` text in agent calls as a leak.
- `~/.kodel` on this machine belongs to kodelctl (`config.yaml`, `auth.json`, `runner-claude/`); `projects/` is free today.
- Hard-coded `.kodel/runs`: `tools.ts:69`, `elicit.ts:634`, `service.test.ts:682`, `claude-code-wait.test.ts:71`, `scripts/check-artifact.mjs:198`, `examples/pipelines/feature.yaml:59` (already vacuous: `GitSnapshotter` excludes `.kodel`, `git.ts:191`).

## Implementation notes

Where the built change differs from, or settles, what the plan above says (found while building it and in the review):

- **The checkout root is canonical.** A root given with a symlink in it, or a linked worktree of the project (`--root`, `KODEL_ROOT`), is brought to the real path of the main checkout (`canonicalRoot`) when the place is resolved, so
  `root` in `meta.json` and the folder of the proposals are one per checkout. The plan said `sameDir` does this; `sameDir` only folds case. `locateProject` itself still uses an explicit root as given.
- **A foreign run is refused with `WORKDIR_INVALID`** (no new error code: the plan changes no code in `errors.ts`).
- **`kodel status` prints the mode and the place for `home`, and a one-line `storage: project (...)` note for a project on a machine that keeps history under `~/.kodel`** (the `projects` folder is there, read from the command's own environment). Decision 11 said "always"; a machine with no home history keeps the output it had, so the default project's output is unchanged where nothing can flip. The "may be kept in the other place" hint follows the same rule. A running server refuses the next call that opens or starts a run.
- **The check of the place stops new calls; it does not guard a call that has begun.** A server writes to the place it started with until it is restarted ("a change between the check and the first write cannot reach the old place" is not a promise the design can keep: it cannot reach the *new* place).
- **File-system errors in the home tree become `CONFIG_INVALID`** with the home base replaced by `<home>`, from the places that create folders and files there (the first use, `reserveRunId`, `createRun`, the proposals, the start lock).
- **The collector** gets the index through an `indexLocator` option (a function of the project root), not a string; without it the collector asks the project's config with the line matcher the hook uses.
- **The hook** makes only the project's own folder under `~/.kodel` (`ensurePlace(place, "tree")`), not the folders of the runs and of the proposals.
- **Proposals are not moved by hand** when switching: the folder inside `proposals/` is named by a hash of the checkout, so the docs say to discard and propose again.
- **`kodel pipeline changes apply|discard|restore`** warn on a foreign run like `gate`, `ack` and `seal`. The `UNKNOWN_RUN` texts of `agent-decisions.ts` stay as they are: they go to the agent, and the host sites that carry the "may be kept in the other place" hint are `pipeline-host.ts` and `cli.ts`.
- **The end-to-end scenario** (`scripts/check-artifact.mjs`) starts a run, finishes the agent step, sees the gate, runs `kodel status` and the hook on the built `dist/kodel.js`; it does not decide the gate or resume, because both need a terminal.
- **`tests/agents/harness.ts` is unchanged**: the real-agent scenarios use the default `storage: project`, so `storage_harness_agrees_on_base` has nothing to agree on and was dropped.
- **A bad place does not stop the server.** `kodel mcp` starts when the place cannot be found (`home` without `project_id`, a relative `KODEL_STATE_DIR`, an unreadable config): the pipelines and their documentation are served, and the calls that need the history answer `CONFIG_INVALID` (`storageError` option of the host). The previous build refused every tool, which the plan did not ask for.
- **File-system errors in the home tree are converted in two places:** at the writes of the store (`placeProblem`), and at the boundary of the host (a `Proxy` around the run that the host hands out, and `start`), so an error of a running step reaches the agent as `CONFIG_INVALID` with `<home>` in place of the folder. Only an error of the system (`EACCES`, `ENOSPC`, ...) whose path is under the home base is taken; an error of Node, a parse error, and an error in the project's own files (a pipeline copy, an accepted pipeline) are said as they are. A write that failed with no path is taken only inside the store's writes of the history.
- **An agent does not decide on a foreign run** (`pipeline_decide_gate`, `pipeline_accept_change` answer `WORKDIR_INVALID`); a person's command still may, with a warning.
- **The hint "may be kept in the other place" is for `home` projects, and for projects on a machine that has the `projects` folder.** Setting `KODEL_STATE_DIR` alone (the docs tell people to set it in their profile) does not add it to the text of a default project.
- **The loader and the matcher agree both ways** for `storage` and `project_id`: a top-level line the matcher reads that the parser did not read as that key is refused too.
- **`kodel status --no-headers`** prints no `storage:` line and no note about hashes.
- **Not built:** the testkit helper that builds a host with a given base (several test files carry their own copy); a `storage:` line in `kodel status` for a project that keeps its history in `.kodel`. A call that opens a run resolves the place with three `git rev-parse` calls (`canonicalRoot`): a measurable cost per `pipeline_next_step` on a server, accepted.
- `generateProjectId` for a folder named like a Windows device (`con`) gives `con-xxxxxxxx`, which is valid; the `p` fallback is only for a name that sanitizes to nothing.
- `indexLocator` (the shared home session index filtered by cwd) exists in the collector but no caller passes it yet.
- `tick()` has no `assertOurs`: it only observes, it does not change a run.
- `homeTreeInUse` reads `HOME`/`USERPROFILE` from the command's environment, not `os.homedir()`.
- The count of runs without a hash in `status` is shown in `home` mode only.
- **Changes asked for by the person while trying the change (after the review of the first build):**
  - `kodel init` writes `storage: home` and a generated `project_id` into a NEW config by default (`--storage project` writes neither). The default of the engine does not change: a config without the key means `project`, so projects that exist keep their history in `.kodel/runs`. An existing config is not rewritten and, when `--storage` was not given, nothing is said about it.
  - `kodel status` no longer prints the `storage: home (...)` line (a deviation from Decision 11, which asked for the mode and the place). The `storage: project (...)` hint for a project that lost the keys stays, and so do the foreign marks and the note about runs without a hash. The test `storage_status_prints_mode_and_place` became `storage_status_does_not_print_the_place`.
  - `kodel init --server-command` is the command that starts kodel WITHOUT a subcommand (default `kodel`): init adds `mcp` for the server entry of every agent and `hook <agent>` for the hooks. A value that ends in `mcp` or `hook` is refused with a message. No backward compatibility (the plan did not ask for this; the PR description says so).
