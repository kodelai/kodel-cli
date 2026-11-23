# Run attachments: tools to keep a plan, a screenshot and similar files with the run, shown beside the changed files

## TL;DR

- Three MCP tools (`pipeline_attachment_write`, `_read`, `_list`) keep files in the run's own folder
  (`<runs>/<run id>/attachments/`): text given in the call, or an image taken from the run's working
  directory. Every write is a new version in its own file with one journal event; the history of a name can
  be listed, read and stepped through. A check kind `attachment` lets a pipeline require one.
- The "changes" of a run (gate answer, `kodel gate`, the dialog, the TUI) show attachments as a second
  group; text opens as a diff from its previous version and takes line comments like code; an image shows
  type, size and the path to open. `kodel attachment ls|show` reads them in a plain terminal.
- The second critique changed: images are stored **unscanned and marked so** (the byte scan and PDF are
  dropped, decision 1); the file the agent names is opened once and checked on the handle; a write counts
  for a check only with the claim's own token; a same-bytes write is a no-op only inside one visit of one
  step; background workers get the tools; `pipeline_decide_gate` gets the look-again rule; five commits.
- Cost: about 1200-1500 lines with tests. `CONTRACT_VERSION` 5 -> 6; format 2 gains one journal event and no
  new state field; format 1 refuses.
- The aim "the plan lives with the run" is reached only after a later change of `dev.yaml` that you accept.
  Risky: decisions 1 and 2 (both are limits of an invariant that I ask you to accept).

## Decisions needed

1. **An image cannot go through `redact`** (principle 3: nothing reaches history without it). A scan of the
   bytes would find nothing in compressed pixels and would only look like protection, so the plan stores
   PNG, JPEG, GIF and WebP as they are, marks every one `not scanned for secrets` in the record and in every
   list, and documents it as the one exception to principle 3; PDF is out. (a) So. (b) No binaries in this
   change. Recommendation: (a), you asked for screenshots. Without an answer: (a).
2. **The journal of an open run is writable by the agent** (only `state.json` has a trusted hash). An agent
   that writes run files against rule 5 can forge an `attachment_written` line and its file, around the
   redaction, the type check and the limits, and so pass the check: the same trust level as the patches
   today (`docs/changes.md`). (a) Accept, document, pin with a test. (b) Anchor each name's latest hash in
   `state.json`: a new state field, so a new run format 3. Recommendation: (a). Without an answer: (a).
3. **Limits.** Text 256 KB a version, an image 2 MB, a run 20 names, 200 versions, 16 MB, never reset. A
   project that tracks `.kodel/runs` in git commits these files. Without an answer: so.
4. **The decision id** for the test names: `T-45` (T-44 is the newest in the tests; the log is in your
   notes). I ask before building; without an answer: `T-45`.

Not in this change (follow-ups): `.kodel/pipelines/dev.yaml`; attachments in `history_run_details` and
`kodel report`; the web UI.

## Behaviour change

- **Write.** `pipeline_attachment_write(run_id, node_slug, attempt, name, content | path, claim_token?)`.
  `content` is text. `path` names a regular file inside the run's working directory, which the host reads; it
  is the only way for an image (base64 through the model would cost tens of thousands of tokens for one
  screenshot and invite corrupted bytes). Taken only for an open agent step at its current attempt.
- **Type** is the host's finding: an allowed extension whose bytes agree (magic bytes for the four image
  types; valid UTF-8 without NUL for `.md .txt .json .yaml .yml .csv .log`). A mismatch is refused.
- **Versions.** Each accepted write is the next version of its name. Writing the bytes of the latest version
  is a no-op only when that version verifies and was written by this step in this visit; otherwise it is a
  new version that points to the same stored file (so a step entered again, a second branch, or a rewrite
  after a file was changed outside kodel all get their own record).
- **History.** `pipeline_attachment_list(run_id)`: the latest version of each name; with `name`: every
  version (number, step, attempt, time, bytes, lines, hash). `pipeline_attachment_read(run_id, name,
  version?)`: a text version, marked as data an agent wrote; for an image the facts only, never bytes.
- **Check.** `checks: [{ kind: attachment, name: plan.md, min_lines: 10 }]` passes only when this step wrote a
  version of the name in this visit (and, if the step is claimed, with the claim's token).
- **At a gate** every place lists all attachments of the run apart from the project files: the MCP gate
  answer (`waiting.attachments`, `attachments_fingerprint`), `kodel gate` and the dialog (marking those
  written since the run stopped there), the TUI (Report block, second group on Code). A text opens as the
  diff from its previous version, `[` and `]` step through versions, the header names the step that wrote
  each. An image shows type, size, `not scanned for secrets` and the path of the stored file. A new version
  after the look refuses the approval, in forks too, and for `pipeline_decide_gate` as well.
- **Comments.** On a text attachment the comment key works as on a code diff and records
  `attachment:<name>@<version>:<line>`; on an image, `attachment:<name>@<version>`. They go back with a
  rejection like any comment. An agent's finding may use the same form to point at a line of an attachment.
- **CLI.** `kodel attachment ls <run> [name]`, `kodel attachment show <run> <name> [--version n]` (plural
  alias `attachments`). Read-only. For an image a person on a terminal gets the path; under `KODEL_ENGINE`
  (an agent) only the facts, since the path is a run file.
- Nothing appears in the working tree. Format 1 refuses the write with `UNSUPPORTED_FORMAT_FEATURE`. A host
  that keeps no attachments offers neither the tools nor the check kind. Old pipelines and runs are unchanged.

## Risks and invariants

- **1. Agent input is untrusted.** `name`: `[a-z0-9][a-z0-9._-]{0,63}`, an allowed extension, no
  Windows-reserved stem, and refused if a redact rule matches it (it goes into the journal and a file name).
  `path`: the file is opened once (`O_NOFOLLOW`), and everything is judged on the handle: `fstat` says
  regular file, one link, size under the cap; the path is resolved with `realpath.native` and must name the
  same device and inode as the handle, inside the working directory and under none of `.git/` and `.kodel/`
  (compared by the inodes of the ancestors, so case does not matter); the bytes are read from the handle.
  A swap before the check gives another inode and is refused; a swap after it is not read. Windows has no
  `O_NOFOLLOW`: there the inode comparison alone guards, which is said in the doc. `read` wraps text as
  agent-written data; names, types and paths shown to a person go through `plain`; image bytes are never
  printed or returned.
- **2. Fail closed.** A version is an `attachment_written` record whose file exists and hashes to the
  journaled `sha256`; anything else is "missing" or "changed outside kodel", with no content and no path.
  The check passes only on a verified version written by its own node since the node's latest entry that is
  not a retry, and, when a claim was live at the write, only if the record says the token matched. Limit:
  decision 2 (a forged journal line).
- **3. Redact at every write path.** Text is redacted in the store, then hashed and named; the event holds
  no content. `appendJournal` redacts whole records (`store.ts` ~1035, exempting `tree` and `changes`):
  `sha256` and `ref` join the exemptions; `name` cannot hold a match; `type` is an enum. Images: decision 1.
  The agent's own log and the tool-call previews also hold the first 500 redacted characters of a written
  text, outside the 16 MB bound; the doc says so.
- **4/5. Core without I/O.** `pipeline-core`: tool definitions, the event, pure rules (names, type table,
  limits as exported constants, location parsing, history from records), the check handler, optional
  `RunHandle` methods. `@kodel-ai/local`: files, hashing, sniffing, the handle checks, the version diff, the
  check runner.
- **6. Humans decide trust.** No decision opens to the agent. `attachmentsFingerprint` (name -> `seq` of its
  latest record) is compared on its own in `kodel gate`, the dialog and `pipeline_decide_gate` (which must
  send back the `attachments_fingerprint` of the gate answer when the run has attachments; today it compares
  nothing, `cli/src/agent-decisions.ts` ~83). A branch of a fork that keeps writing makes the person look
  again each time; a no-op does not; the 200 bound ends it.
- **7. Kinds are adapters.** The check kind is exported by the core and registered by a host that keeps
  attachments (the local host; not the default registry), with its runner. On a host without it a pipeline
  with the check is an unknown kind: refused at `pipeline_start` and at every accept, so no step waits for a
  check that cannot run. `CheckHandler.agentFed` marks a check only an agent can feed; the parser refuses
  it on a `command` node and on a step with `engine:`. The rule for `result` stays as it is.
- **Forks and the check.** The check judges the version its own node wrote, so two branches writing
  `plan.md` do not fail each other and a sibling's later write changes nothing for a passed check. A worker
  cannot write as another claimed step: without that step's token its version does not count.
- **8 / stored data.** No bump and no new state field. Like every event, the write advances the existing
  `state.seq` and `state.json` is written again; no other field changes. Format 2 gains
  `attachment_written` `{node, attempt, name, version, ref, type, bytes, lines?, sha256, scanned, claim?}`.
  Rule 5: an engine that ignores it decides every step the same and has nothing to drop on a write-back;
  bounds and history come from the journal. A pipeline with the check read by a build without the kind:
  the kept snapshot says "written by a newer kodel, upgrade kodel" (`newerKeptCopy`, `store.ts` ~207).
  Format 1: capability `attachments: false`, the event in `V2_ONLY_EVENTS`, `PipelineFeature` `attachment`
  refused where `join`/`engine`/`model` are (`host.ts` ~1489-1596, `run.ts` ~2847). Fixture
  `fixtures/formats/v2-attachment/`, taken from a real run of the built engine (two text versions, a PNG,
  the check). `kodel migrate` leaves `attachments/` alone; removing a run removes it.
- **An older format-2 build** lists no attachments and approves a gate without the attachment look. It
  decides every step as before; what it lacks is a protection that did not exist when it was built. No
  published build writes format 2, so this is a dev session not restarted; `docs/run-formats.md` says it.
- **Crash and concurrency.** Under the run lock (`locked` + `decideAndWrite`): state, journal, capability,
  limits, the no-op rule; remove files in `attachments/` that no record points to (what a crash or a
  refusal left; so they cannot pile up); create `<sha256>-<name>` exclusively, or reuse the file a verified
  record already points to, or, when that file was changed outside kodel, write beside it
  (`<sha256>~<n>-<name>`); then the event (state, then journal, as every event). A crash before the journal
  line leaves a file the next write removes. A record's file is never replaced. Reads take no lock.
- **Comments.** Gate comments stay rows of the step's report; `location` is free text for the engine (no
  path rule in `registry.ts` or `result.ts`), so stored data does not change. A location is an attachment's
  only if it parses as `attachment:<name>@<v>[:<line>]` **and** the run has that name; anything else is a
  project path. The TUI writes a project path that starts with `attachment:` as `./attachment:...`, and
  counts comments by the parsed place, not by `startsWith` (`tabs.ts` ~538).
- **Workers and surface.** `cli/src/worker-factory.ts` (~29) and `mcp-server.ts` (~112, the surface hash)
  build the tool list with `toolsFor`: both pass `attachments`, or a background worker could never satisfy
  the check. `serverInstructions({ attachments })` names the tools only on a host that has them.
  `PIPELINE_TOOL_NAMES` is every name a host may register: its test becomes "registered names are in the
  list, and a host with everything on registers all of it".
- **What tests cannot show:** a kill on a real disk (a faulting store stands in); the path race on a real
  scheduler (a hook between open and check stands in) and on Windows; a secret in an image; the web UI.

## Acceptance criteria and tests

Commit 1, storage and tools:

| criterion | test |
| --- | --- |
| A text write stores the redacted text under its hash and journals one event with no content; `redacted: true` when it differs | `t45_write_keeps_redacted_text_and_journals_its_hash` |
| Under a hex-matching redact rule the journaled `sha256` and `ref` are intact | `t45_redaction_does_not_bend_hash_or_ref` |
| A name a redact rule matches is refused | `t45_a_name_is_not_a_place_for_a_secret` |
| Versions are kept, numbered, readable; `list` with a name gives the history | `t45_versions_are_kept`, `t45_list_gives_the_history_of_a_name` |
| Same bytes: no-op in the same visit of the same step; a new record reusing the file in a new visit, from another step, and after the file was changed outside kodel | `t45_no_op_only_within_one_visit` (four cases) |
| Names table (`PLAN.md`, `con.md`, `plan.md.`, trailing space, NUL, `..`, `a/b.md`, no extension, `.exe`, `.pdf`, 65 chars) | `t45_name_table` (core) |
| Type: PNG as `.png` passes; PNG as `.md`, text as `.png`, ELF as `.gif`, invalid UTF-8 or NUL as `.txt` are refused | `t45_type_is_sniffed_not_believed` |
| `path` table: outside the directory, `..`, a link out, a link inside to outside, a hard link, a directory, a FIFO, `.git/x`, `.GIT/x` and `.kodel/RUNS/x` on a case-insensitive disk, `.kodel/config.yaml`, over the cap (not read whole) | `t45_path_stays_in_the_workdir` |
| The file swapped for a link between open and check is refused and nothing of the target is stored | `t45_path_swap_is_refused` (hook) |
| An image is stored byte for byte with `scanned: false`; `read` returns facts, no bytes | `t45_image_is_kept_unscanned_and_marked`, `t45_read_never_returns_binary` |
| Limits: exactly 256 KB, 2 MB, the 20th name, the 200th version, 16 MB pass; one more refuses, names the limit, leaves no file and no event, and does not spend the bound | `t45_limits_at_and_over_the_bound` |
| Unreferenced files are removed at the next write and count toward nothing | `t45_leftovers_are_swept_under_the_lock` |
| Not an open agent step, wrong attempt, at a gate: refused | `t45_write_needs_an_open_agent_step` |
| A write never releases or renews a claim; only `seq` of the state moves | `t45_write_never_touches_the_claim` |
| Format 1: refused before a file or an event, `how_to_upgrade` given | `t45_format_1_refuses_an_attachment` |
| A fault between file and event, and a refused event, leave no version and keep the previous one; A, B, A refused keeps version 1 | `t45_crash_between_file_and_journal_is_never_content`, `t45_refused_reuse_keeps_the_earlier_version` |
| No record, missing file, edited file, link in place of folder or file: no content, no path | `t45_read_trusts_the_journal_not_the_folder` |
| Decision 2 pinned: a forged journal line with its file reads as an attachment | `t45_limit_a_forged_journal_line_is_an_attachment` |
| An edit after the seal shows | `t45_edit_after_seal_shows` |
| `read` is marked data; works on a finished run; another project's run is `UNKNOWN_RUN` | `t45_read_is_data_and_stays_in_the_project` |
| A read during a write returns the last journaled version | `t45_read_during_a_write_sees_the_last_journaled_version` |
| Two writes at once give two versions; limits hold | `t45_concurrent_writes_are_serialized` |
| `storage: home`; `kodel migrate` leaves `attachments/`; removing a run removes it | `t45_attachments_follow_the_storage`, `t45_migrate_and_remove` |
| Nothing in the tree; `diff` `changed_only` still passes | `t45_attachment_is_not_a_project_change` |
| A handle without the methods answers `{ok: false}`, never throws; tools and instruction rule only on a host with attachments; the MCP server and a background worker both list them and hash the same surface | `t45_host_without_attachments`, `t45_worker_gets_the_attachment_tools`, `t40_contract_version_and_surface_snapshot`, the tool-name registry test |
| Key tables, real fixture, round trip (the `seq` of the state moves, nothing else); the fixture reads the same by an engine that skips the event | `t41_*` (updated), `t45_v2_attachment_fixture_round_trips`, `t45_fixture_reads_without_the_event` |

Commit 2, gate answer, texts, CLI:

| criterion | test |
| --- | --- |
| `attachments` beside `changes`, also without git and with `changes_unavailable`; over the cap `attachments_omitted` | `t45_gate_answer_lists_attachments_as_their_own_group`, `t45_gate_answer_without_git`, `t45_gate_answer_caps_the_list` |
| `kodel gate` and the dialog list name, type, size, new-since-stop and the unscanned mark, through `plain` (dialog included) | `t45_gate_text_lists_attachments`, `t45_gate_and_dialog_text_are_plain` |
| A new version after the look refuses approval: plain / shared tree / no git / same-size rewrite | `t45_write_after_the_look_refuses_approval`, `t45_look_again_in_a_shared_tree`, `t45_look_again_without_git`, `t45_look_again_on_a_same_size_rewrite` |
| In a fork: each new version asks for a new look, a no-op does not, the loop ends at the bound | `t45_fork_branch_that_keeps_writing` |
| `pipeline_decide_gate` refuses a missing or stale `attachments_fingerprint` and returns the fresh answer | `t45_agent_decision_needs_the_fresh_look` |
| What the gate showed is what is read later (plain run and fork); the file list does not move | `t45_what_the_gate_showed_is_what_is_read`, `t45_file_list_does_not_move` |
| CLI: lists, versions, prints text through `plain`; image path on a terminal, facts only under `KODEL_ENGINE`; plural alias; unknown run, unknown name, `--version` out of range and outside a repository fail with a message; `storage: home` | `t45_cli_attachment_reads_only`, `t45_cli_attachment_for_an_agent`, `t45_cli_attachment_errors`, `t45_cli_attachment_storage_home` |

Commit 3, TUI and comments:

| criterion | test |
| --- | --- |
| The version diff is made with no repository config, attributes or hooks; without git the whole text | `t45_version_diff_is_hardened`, `t45_version_diff_without_git` |
| Report names the group; Code lists two groups under one cursor | `t45_tui_report_names_attachments`, `t45_tui_code_lists_both_groups` |
| A text opens as a diff; `[`/`]` change the version; the header names the writer | `t45_tui_steps_through_versions` |
| An image card: type, size, mark, verified path through `plain`, never bytes; a changed one shows no path | `t45_tui_shows_an_image_by_its_facts` |
| Location parser: with a line, without a line, bad forms | `t45_attachment_location_table` (core) |
| A line comment records `attachment:<name>@<v>:<line>`, shows on that line of that version and still under that version after a newer one exists; an image takes a lineless comment; a comment on a name that no longer verifies is listed, not lost | `t45_comment_on_an_attachment_line`, `t45_comment_on_an_image`, `t45_comment_survives_versions_and_damage` |
| Project files `attachments/plan.md`, `attachment:x.md` and `attachment` keep their own comments | `t45_comment_locations_do_not_collide` |
| An agent's finding with an attachment location shows on that line; the gate instruction explains the form | `t45_finding_may_point_at_an_attachment`, `t45_gate_instruction_explains_attachment_locations` |

Commit 4, the check kind (commits 1-3 pass without it):

| criterion | test |
| --- | --- |
| Schema; `min_lines` only for a text name, counted on the stored (redacted) text | `t45_check_kind_schema`, `t45_min_lines_counts_what_is_stored` |
| Fails with no version; with another node's; with one from an earlier entry | `t45_check_fails_without_a_write`, `t45_check_wants_this_visit_of_this_node` |
| Passes after a retry in the same visit with no fresh write; passes in a new visit when the same bytes are written again | `t45_check_survives_a_retry_in_the_same_visit`, `t45_check_passes_on_same_bytes_in_a_new_visit` |
| Fails under `min_lines`, on a hash mismatch, on an unreadable journal | `t45_check_fails_closed` (three named cases) |
| Fork: both branches pass; a sibling's later write does not fail a passed check | `t45_check_in_a_fork_judges_its_own_node` |
| A version written for a claimed step without its token does not count | `t45_check_wants_the_claims_token` |
| Refused on a `command` node and on a step with `engine:` | `t45_check_needs_an_agent_fed_node` |
| A host without attachments refuses the pipeline at start and at accept | `t45_no_attachment_store_no_attachment_check` |
| A v1 run refuses a pipeline with the check: proposal, apply, edited file | `t45_format_1_refuses_a_pipeline_with_the_check` |
| A kept snapshot with the kind, read without it, says "newer kodel" | `t45_unknown_check_kind_in_a_kept_copy_says_upgrade` |
| The prompt gets the instruction; `pipeline_docs` lists the kind | `t45_check_adds_its_instruction`, `t45_docs_list_the_attachment_check` |
| A scripted agent writes a plan, the check passes, a later step reads it | `t45_e2e_plan_written_checked_and_read` |

Commit 5, docs: `t45_docs_name_the_limits` (limits and types equal the exported constants; the doc names
the principle-3 exception; `docs/run-formats.md` names the older-build limit).
Manual at the final gate: the TUI layout on a real run; opening a stored PNG by the path shown; one real
agent (`tests/agents`, outside the sandbox) writing a screenshot by `path`.
Refutation of T-45: an attachment the gate showed differs from what a later step read (also in a fork); a
project file list that changes because an attachment was written; a file stored under a type its bytes are
not; bytes from outside the working directory in the history.

---

## Steps

1. **Core**: `attachments.ts` (pure: name rule, type table, limits as constants, records, history,
   `attachmentsFingerprint`, `parseAttachmentLocation` with and without a line); `RunEvent`
   `attachment_written` in `run.ts` (open agent visit, attempt, capability; the token is compared with a live
   claim only to fill `claim: "matched" | "foreign" | "none"`); `FormatCapabilities.attachments`; the event
   in `V2_ONLY_EVENTS`.
2. **Service and tools**: optional `RunHandle.writeAttachment/readAttachment/listAttachments`; service
   methods; three descriptors behind `toolsFor({ attachments })`; `serverInstructions({ attachments })`;
   `CONTRACT_VERSION` 6; `PIPELINE_TOOL_NAMES`; `worker-factory.ts` and `mcp-server.ts` pass the option.
3. **Store**: `createAttachment`, `readAttachmentFile`, `sweepAttachments`, `attachmentPath`; journal
   exemptions for `sha256` and `ref`.
4. **Run** (`local/host.ts`): `openInWorkdir(path)` (handle checks), sniffing, `LocalRun.writeAttachment`,
   `listAttachments`, `readAttachment`. Fixture from a real run; testkit `attach`. **Commit 1.**
5. **Gate answer and texts**: `NextStep` gate answer `attachments?`, `attachments_omitted?`,
   `attachments_fingerprint?`; `decide-text.ts`; `gate-decision.ts`, `elicit.ts`, `agent-decisions.ts` and
   `mcp/decision-tools.ts` compare the fingerprint. **CLI** `kodel attachment ls|show`. **Commit 2.**
6. **TUI**: `attachmentDiff(name, version)` in local (hardened git of `git.ts`, else whole text); optional
   `GateDetail.attachments`; `tabs.ts`, `view.ts`, `diffview.ts`, `demo.ts`. **Commit 3.**
7. **Check kind**: `attachmentCheck` exported by the core (`agentFed`), registered with its runner by the
   local host; the parser rule; `PipelineFeature` `attachment`. **Commit 4.**
8. **Docs**: `docs/attachments.md` and the note in `docs/run-formats.md`; one line each in `docs/history.md`,
   `docs/changes.md`, `AGENTS.md`. **Commit 5.**
9. `bun run typecheck && bun run lint && bun test && bun run build && node scripts/check-artifact.mjs`.

## Affected files

- `packages/pipeline-core/src/`: `attachments.ts` (new), `run.ts`, `service.ts`, `next-step.ts`,
  `registry.ts`, `pipeline.ts`, `index.ts`, `tool-calls.ts`, `mcp/tools.ts`, `mcp/decision-tools.ts`,
  `mcp/register.ts`, `formats/types.ts`, `formats/v1.ts`, `formats/v2.ts`
- `packages/local/src/`: `store.ts`, `host.ts`, `pipeline-host.ts`, `git.ts`, `index.ts`
- `packages/cli/src/`: `cli.ts`, `mcp-server.ts`, `worker-factory.ts`, `agent-decisions.ts`,
  `decide-text.ts`, `gate-decision.ts`, `elicit.ts`, `tui/session.ts`, `tui/gate.ts`, `tui/tabs.ts`,
  `tui/view.ts`, `tui/diffview.ts`, `tui/demo.ts`
- `packages/testkit/src/`: `dsl.ts`, the scripted agent, the local engine's registry
- tests: new `pipeline-core/test/attachments.test.ts`, `local/test/attachments*.test.ts`,
  `cli/test/attachment-cli.test.ts`; updated `service.test.ts`, `format-codecs.test.ts`, `checks.test.ts`,
  `docs.test.ts`, `tool-calls-registry.test.ts`, `changes-mcp.test.ts`, `gate-comments.test.ts`,
  `gate-decision.test.ts`, `elicit.test.ts`, `agent-decisions.test.ts`, `tui-gate.test.ts`,
  `tui-diffview.test.ts`, `tui.test.ts`, `tests/agents/claude-code-worker.test.ts`, one e2e scenario
- `fixtures/formats/v2-attachment/`, `fixtures/formats/README.md`
- `docs/attachments.md` (new), `docs/run-formats.md`, `docs/history.md`, `docs/changes.md`, `AGENTS.md`
- Not touched: `.kodel/pipelines/dev.yaml`, `.mcp.json`, the config and its schema, `worktrees/web-ui`.

## Rejected review findings

Fixed in this pass (not rejected): the binary rule (scan and PDF dropped, unscanned and marked, decision 1,
option (b) with a config key gone, so its tests are moot); the path race; credit by claim token; `state.seq`;
the name through redact; the path under `KODEL_ENGINE`; leftovers swept; the no-op deadlock; workers and the
surface hash; the forged journal line (decision 2); a host without attachments; `pipeline_decide_gate`;
case-insensitive paths, hard links, `.kodel/` whole; journal exemptions; the `attachment` root file; the
meaning of the tool-name test; instructions per host; previews in the agent log; commit 2 split; why `path`;
the lineless location; the TL;DR and follow-ups; docs cut to two files and one-liners; every test asked for.

The person's rejection of attempt 1 stays answered as before (check kind, CLI, comments, binaries, history).

Rejected:

- *Refuse approval in an older format-2 build.* An older build cannot be changed. It decides every step as
  before and lacks a new protection; no published build writes format 2. Stated in Risks and in the docs.
- *Escape the `attachment:` namespace on every write path.* An agent's finding that points at a line of an
  attachment is wanted (a plan critique does exactly that). A location is display only and is an
  attachment's only when the run has that name.
- *Move the `result` rule onto `agentFed`.* It would tighten the parsing of kept snapshots that carry a
  `result` check on a `command` node (stored data, rule 2). `agentFed` is set for `attachment` only.
- *A false-positive corpus for the byte scan; tests of `history.attachments.binary`.* Both pieces are gone.
- *Anchor attachments in the state.* A new state field that an older engine drops changes what the newer
  one decides, so it needs format 3: offered as decision 2 (b), not done by default.
- *The check kind and the CLI are scope.* The person put both back.
- Earlier, unchanged: binding a name to its first writer; resetting the 200 bound; `read` only for running
  runs; "an older engine gives a plain invalid-pipeline error" (`newerKeptCopy` says "upgrade", tested now).

## Findings in the code

- The dev pipeline's plan is a repository file: `.kodel/pipelines/dev.yaml` writes
  `docs/plans/{{task.slug}}.md` and checks it with `diff` / `changed_only`.
- Local tasks have no files. "Session" here is a `kodel agent` process, machine-local and removable.
- The run folder keeps `reports/`, `artifacts/`, `changes/*.patch`, `served/` (`local/src/store.ts`). The
  seal covers `state.json` and `journal.jsonl`; while a run is open only `state.json` has a trusted hash
  (`store.ts` ~587, `integrity.ts`), so the journal is at the agent's trust level, as the patches are.
- Every event advances `state.seq` (`run.ts` ~1062) and the state is written with it; `appendJournal`
  (`store.ts` ~1035) redacts whole records except `tree` and `changes`; `redactEvent` (`host.ts` ~457)
  redacts the free-text fields of an event.
- Precedent for the write: `LocalRun.reportResult` -> `acceptReport` -> `store.writeReport` ->
  `apply({type: "report_accepted"})` (`host.ts` ~3968-4037). `applyLocked` is
  `locked(() => decideAndWrite(...))` (~1954).
- A completion's claim path (`claimCrossed`, `run.ts` ~2439-2456) releases the claim and counts in
  `claimEvents`. An edge opens a new visit of a node (`run.ts` ~1252, ~1556-1592).
- Format 2 is read leniently (`formats/v2.ts`); format 1 has key tables and an event list. `newerKeptCopy`
  (`store.ts` ~207) maps `unknown (node|check) kind` in a kept copy to "written by a newer kodel".
- Check kinds: `CheckHandler` in `registry.ts`; a step with `engine:` refuses a `result` check (~303);
  runners in `local/src/host.ts` ~4100-4181, called from `runCheck` (~2899), which fails a check that has no
  runner. The host uses `engine.registry ?? defaultRegistry()`.
- Tool lists are built by `toolsFor` in `cli/src/mcp-server.ts` (~112, also hashed as the surface) and in
  `cli/src/worker-factory.ts` (~29) for background workers; `PIPELINE_TOOL_NAMES` (`tool-calls.ts`) is kept
  equal to the registered names by `tool-calls-registry.test.ts`.
- `pipeline_decide_gate` (`cli/src/agent-decisions.ts` ~83) compares nothing with what the person was shown.
- Gate comments are rows of the human step's report with a free-text `location`; the TUI builds the place in
  `tui/view.ts` (~2165), counts by path prefix in `tabs.ts` (~538), matches a line in `diffview.ts` (~325).
- Changes come from git trees (`LocalRun.changesSinceStart` ~3418, `changesSinceGate` ~2179, `ChangeReport`
  ~505) and surface in the gate answer (`host.ts` ~3141), in `kodel gate` and the dialog (`decide-text.ts`,
  `gate-decision.ts` ~200-216, `elicit.ts` ~531-538) and in the TUI. A file's diff is made by
  `GitSnapshotter.patchSince` (`local/src/git.ts` ~456), hardened as `docs/changes.md` says.
- `kodel web` is not in `main`: uncommitted work in `worktrees/web-ui`, reading the same `GateDetail`.
- Not read by me, taken from the critique: the line numbers in `worker-factory.ts`, `agent-decisions.ts`,
  `integrity.ts` and `tool-calls-registry.test.ts`; the implementation starts by confirming them.

## Implementation notes

Decisions taken at the gate: 1 (a), 2 (a), 3 as written, 4 `T-45`.

Where the work differs from the plan:

- **The fixture and the test kit's `attach` are in commit 4, not commit 1.** The fixture holds the check
  (a failed and a passed `check_finished`), which does not exist before commit 4, and a fixture is not
  edited after it is taken. `t45_v2_attachment_fixture_round_trips` and `t45_fixture_reads_without_the_event`
  moved with it; commit 1 has `t45_an_engine_that_skips_the_event_decides_the_same` on the machine instead.
- **The fingerprint is plain text** (`plan.md@12;shot.png@15`: each name with the journal number of its latest
  record), not a hash: the core has no crypto, and it is at most a few hundred characters.
- **`pipeline_decide_gate` in a fork.** While a sibling step is open the answer to the agent is that step with
  `also_waiting`, which lists no attachments (as it lists no changes). So the refusal of a missing or stale
  fingerprint carries the attachments and the fingerprint as they are now in `details`, besides `details.next`.
- **The look-again rule holds an approval only.** A rejection sends the work back whatever was written since,
  so it is never refused for a new version (`t45_a_rejection_is_not_held_back_by_a_new_version`).
- **`kodel attachment show --version n`.** `--version` is the program's own flag wherever it stands, so after
  `attachment show` it is passed on under a hidden name (`attachmentShowArgs` in `cli.ts`). The command line is
  as the plan says.
- **The Report names the attachments in one line** under the changed files, not in a block: a block pushed the
  decision off the first screen of the sample run (`task_9pns_it_opens_on_the_agents_answer_...`). The Code tab
  has the group with its rows, and its label counts them apart (`Code 5+2`).
- **A comment on a line a version removed** records that line of the version before
  (`attachment:plan.md@1:3`), not `...@2:3 (removed line)`: the location then always parses.
- **The diff of a version is read under the key `/attachment:<name>@<version>`**: a project path is relative,
  so no file can have it, and the `load_diff` effect needed no new field.
- **The format rule for the check is generic.** `CheckHandler.feature` names the pipeline feature a run's
  format must list, and `unheldCheckFeature` refuses by it in the machine and in the host, so nothing matches
  on the kind `attachment` (principle 7). `PipelineFeature` gained `attachment` as planned.
- **A registry for the local host.** The host had none of its own (`engine.registry ?? defaultRegistry()`), and
  several places parsed a pipeline with the built-in kinds. `localRegistry()` is now the default of
  `LocalHost` and `LocalPipelineHost`, every parse in them names it, the store reads a kept copy with the
  host's extra check kinds (`parseSnapshot(..., { extraChecks })`), and `PipelineHost.registry` gives it to the
  service for `pipeline_docs` and `pipeline_plan`.
- **No new error code.** Refusals of a write use `INVALID_ARGUMENTS`, `NODE_NOT_RUNNING`, `ATTEMPT_MISMATCH`,
  `UNKNOWN_NODE` and `UNSUPPORTED_FORMAT_FEATURE`; a refused write is journaled as `call_refused`, like the
  refusals of the other tools ("no event" in the criteria means no `attachment_written`).
- **Tests.** `t45_limits_at_and_over_the_bound` is two tests (sizes and bytes; names and versions in
  `t45_limits_of_names_and_versions`). The end-to-end test runs the real MCP server in memory
  (`packages/cli/test/run-attachment-mcp.test.ts`), since `tests/e2e` builds the binary; the test kit has one
  scenario of its own on the local engine. The new behaviour is in new test files, so of the files the plan
  listed as updated only these changed: `service.test.ts`, `format-codecs.test.ts`,
  `tool-calls-registry.test.ts`, `tui.test.ts`, `agent-log.test.ts`, `engine-steps.test.ts`,
  `history-tools.test.ts`, `cli/test/executor.test.ts`, `local/test/formats.test.ts` and
  `tests/agents/claude-code-worker.test.ts` (the served tool names). No real-agent scenario was added: it is
  in the manual part of the final gate.
- **The test files are named `run-attachment*.test.ts`**, not `attachment*.test.ts` as the plan has them: a
  test file whose name starts with `attach` is read as a session test, whose names must carry the session
  decision's id (`session_test_names_carry_the_decision_id`). The TUI's is `tui-attachments.test.ts`.
- **Two small commits follow the five**: the sample data of the TUI named a path under `.kodel/runs`
  (`storage_no_hardcoded_runs_path`), and the rename of the test files above.
- **Not done:** attachments in `history_run_details` and `kodel report`, the web UI, and the change of
  `.kodel/pipelines/dev.yaml` (follow-ups, as the plan says).

Line references of the plan that were checked: `store.ts` `appendJournal` is at ~1030 (the exemptions for
`sha256` and `ref` are there); `newerKeptCopy` at ~208; `worker-factory.ts` builds the list at ~30 (now
`workerToolNames`); `agent-decisions.ts` `decideGate` at ~55-110 compared nothing with what the person was
shown, as the critique said; `tool-calls-registry.test.ts` held `PIPELINE_TOOL_NAMES` equal to the registered
names. `integrity.ts` needed no change.

### After the independent review (attempt 3)

1. **The no-op and the claim (fixed).** The same-bytes no-op now also needs the latest record to stand to the
   step's claim as the new write does. A version written without the token of the worker that holds the step
   (`claim: "foreign"`) no longer swallows the holder's write of the same bytes: that write is a new version
   that counts for the check (`t45_same_bytes_with_the_token_after_a_foreign_write_counts`).
2. **The sweep (fixed).** `sweepAttachments` removes only what is known to be a leftover: a temporary file,
   and a `<sha256>-<name>` file whose hash no line of the journal names, looked up in the journal as text.
   The file of a record this kodel cannot read stays, and so does any file the store did not make
   (`t45_leftovers_are_swept_under_the_lock`, `t45_sweep_keeps_the_file_of_a_record_it_cannot_read`).
3. **The look-again check under the lock (fixed).** `LocalRun.decideHuman` takes what the person was shown
   (`seen.attachments`) and compares it with the journal under the run's lock, right before the decision is
   written (`apply` got a `guard`). `kodel gate`, the TUI, the dialog and `pipeline_decide_gate` pass it for an
   approval; their earlier comparison stays, for the refusal in plain words
   (`t45_decision_is_held_against_the_attachments_under_the_lock`).
4. **`pipeline_attachment_write` is not idempotent (fixed):** `idempotent: false`. The surface hash of a run is
   computed from the tools, and no test pinned the old value.
5. **Docs (done):** `docs/attachments.md` says that the path is opened before the working-directory check, so
   a refusal's wording can reveal whether an outside path exists, and that only `.git` and `.kodel` directly
   under the working directory are closed.
6. **The fixture (documented, not regenerated).** `fixtures/formats/v2-attachment/` was taken by
   `scripts/take-v2-attachment-fixture.mjs`, which drives the sources through `LocalPipelineHost` under Bun,
   as the scripts of `v2`, `v2-engine` and `v2-model` do. It was not taken from the built `dist/kodel.js`: the
   script needs the host's methods, which the single-file artifact does not export, and this step may not run
   the build. The plan's words "a real run of the built engine" are met in that sense only; the README of the
   fixtures says so.
