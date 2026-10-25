# TASK-CNZ6: command and check output kept in files

## Goal

Keep what each command and each failed check printed, so that afterwards one can judge whether a check
failed for a good reason. Today only the last 2000 characters of a failure survive (`REASON_TAIL`, in
`reason`). The output goes to `artifacts/<node>-<attempt>-command.txt` and
`artifacts/<node>-<attempt>-check<i>.txt` in the run folder (redacted), and `command_finished` and
`check_finished` get `output: { ref, bytes, truncated }`. The 2000-character tail in `reason` stays: the
agent needs it on a retry. The switch is `history.output.enabled` (TASK-CXSE, already merged: the type,
defaults `enabled: true, max_kb: 64` and the effective values in `run_started.history`).

## Facts found in the repository

- `packages/local/src/command.ts`: `runCommand` keeps a bounded tail (`DEFAULT_MAX_TAIL_BYTES = 16 KiB`),
  prefixes `[earlier output omitted]\n` when it cut, strips a leading U+FFFD (a UTF-8 sequence cut in the
  middle), redacts the whole tail in `finish` with `options.redact`. A secret split across two chunks is
  therefore already redacted correctly (redaction runs on the joined text). It resolves with
  `{exit, timedOut, aborted, tail, truncated, durationMs}`; on a timeout or an abort it still resolves with
  what was read.
- `packages/local/src/host.ts`: `LocalRun.runNodeCommand` (~1250) turns the result into a `work_finished`
  event; `builtinCheckRunners().command` (~1700) runs a check command through `host.runner` and returns a
  `CheckVerdict`; `runCheck` (~1275) turns the verdict into `check_finished`. `commandVerdict` is shared.
  `host.maxTailBytes` is an optional injected limit (tests) passed to both.
- `packages/pipeline-core/src/run.ts`: the events `work_finished` / `check_finished` (~190-215) carry
  `exit`, `duration_ms`; the journal records `command_finished` (~760) and `check_finished` (~781) are built
  from them. `report.ts` (~170) reads both records and ignores unknown fields.
- The effective `history` settings live only in the `run_started` journal record, not in the run state;
  `LocalRun` reads the journal with `store.readJournal`.
- `packages/local/src/store.ts`: `FileStore` has `writeAtomic` (tmp file, `fsync`, `rename`), `reportPath` /
  `writeReport` (the pattern to follow for a new per-attempt file), and `redact`.
- The `command` check is the only built-in check that runs a process. The other kinds (`diff`, `result`,
  user-registered) produce no output text, so "check output" means the output of a command check.
- Existing test files for this area: `packages/local/test/command.test.ts`, `host.test.ts`, `store.test.ts`,
  `hardening.test.ts`, `formats.test.ts`; e2e in `tests/e2e`; artifact check in `scripts/check-artifact.mjs`.

## Design decisions

1. **File format and name.** `artifacts/<name>-<attempt>-command.txt`, `artifacts/<name>-<attempt>-check<i>.txt`.
   `<name>` is the node slug passed through a sanitiser (anything outside `[A-Za-z0-9._-]` becomes `_`; a
   name that becomes empty, `.` or `..` becomes `_`) so a node name never escapes `artifacts/` or breaks on
   Windows. Two nodes whose slugs sanitise to the same text would collide, so the sanitised name gets a short
   hash of the original slug appended only when sanitising changed it. `ref` in the event is the path
   relative to the run folder (`artifacts/...`), always with `/`.
2. **Retries and repeats.** The attempt is in the file name, so a retried node writes a new file. The same
   attempt re-run after an engine restart overwrites its file atomically (the last run of that attempt is
   the one whose result counted). Two checks with the same output write two files (index in the name).
3. **What is kept.**
   - Command (node command or `command` check): always, on success and on failure, when output is enabled.
   - Check output: on failure only (the task says so); a passing `command` check writes no file.
   - Timeout, abort, a command killed on engine restart: the tail read so far is written; for a restart the
     killed process's tail is whatever `runCommand` resolved with, nothing if the whole process died (no file,
     no `output` field: absent means "nothing was kept", never an error).
4. **Limit.** `DEFAULT_MAX_TAIL_BYTES` goes from 16 to 64 KiB; the host passes `history.output.max_kb * 1024`
   from the run's recorded `history` as `maxTailBytes` (an injected `host.maxTailBytes` still wins, for tests).
   The recorded value, not the current config, so editing the config mid-run changes nothing for the run.
   `truncated` comes from `CommandResult.truncated`; a truncated file starts with the existing
   `[earlier output omitted]` marker.
5. **Redaction.** The file content is the already-redacted `tail` from `runCommand`, and `writeArtifact` in
   the store redacts once more with the store's rules (idempotent), so no write path skips `redact` (principle 3).
   `bytes` is the byte length of what is stored (after redaction), which can differ from what was read.
6. **Switch.** With `history.output.enabled = false` nothing is written and the events have no `output`
   field. A run recorded without `history` (older run, or an injected test host) behaves as the defaults would
   only if the test says so; the safe reading for an old run is "not recorded": no files, no field.
7. **Command text.** `command_finished` gets `command: <rendered command text>` for command checks, i.e. in
   `check_finished` of a `command` check (the node command is already in the pipeline snapshot). It goes
   through redaction like every other string in an event.
8. **A write error must not change the verdict.** `writeArtifact` failure (disk full, permission) is caught in
   the host; the verdict stays as the command decided, and the event carries `output_error: <short message>`
   instead of `output`. Nothing is thrown out of `runNodeCommand` / `runCheck` for this.
9. **Atomic write.** Reuse `writeAtomic` (tmp, fsync, rename) after `mkdir artifacts`.

## Affected files

Changed:
- `packages/local/src/command.ts`: `DEFAULT_MAX_TAIL_BYTES = 64 * 1024`; make the cut keep a valid UTF-8
  start (already strips U+FFFD); no other behaviour change. Keep the whole-tail redaction.
- `packages/local/src/store.ts`: `artifactPath(runId, name, attempt, kind)`, `writeArtifact(runId, ref
  parts, text)` returning `{ref, bytes}`; the sanitiser; redaction + `writeAtomic`.
- `packages/local/src/host.ts`: read the run's `history.output` once (from the `run_started` record, cached on
  `LocalRun`), pass `maxTailBytes`, write the artifacts in `runNodeCommand` and in the `command` check, attach
  `output` / `command` / `output_error` to the events. The check runner needs a way to hand the output text
  and `truncated` back to `runCheck`: extend `CheckVerdict` with an optional `output?: {text, truncated}` that
  `runCheck` strips before the event is built.
- `packages/pipeline-core/src/run.ts`: optional `output?: {ref, bytes, truncated}`, `command?: string` and
  `output_error?: string` on the `work_finished` / `check_finished` events, copied into the
  `command_finished` / `check_finished` journal records when present. Additive, so the stored format stays v1.
- `packages/pipeline-core/src/report.ts`: carry `output` through to the attempt summary only if it is cheap
  (the `report` command may print "output: artifacts/..."); otherwise leave unchanged.
- `packages/testkit/src/memory-engine.ts`: no change expected (fields optional).

New: none besides tests and, if a fixture is needed, none (no stored field is renamed or retyped).

## Steps

1. Core: the three optional event fields and their journal records; unit tests for the shapes.
2. `command.ts`: the new default; tests for the limit.
3. Store: `writeArtifact`, the sanitiser, atomic write; store tests.
4. Host: resolve the output settings from the journal, write artifacts for commands and failed command
   checks, attach the fields, swallow and record write errors.
5. Report: show the ref if trivial.
6. Hardening and e2e tests (below); `scripts/check-artifact.mjs` run.
7. Real run: start the `dev` pipeline on a scratch task, check `artifacts/` has a file per command and per
   failed check, then repeat with `history.output.enabled: false` and check there are none.

## Test strategy

Test names carry the decision id of the task (`t…` ids come from the local decision log; the task body
gives none, so names carry `cnz6`).

- unit (pipeline-core): the journal records keep `output`, `command`, `output_error` when given and omit them
  when not; a record without them still reads (old runs).
- `command.test.ts`: the default is 64 KiB; `maxTailBytes` is honoured; truncation is marked and starts with
  the omitted marker; timeout and abort keep what was read; a secret split across two chunks is redacted;
  CRLF output stays as it is.
- `store.test.ts`: `writeArtifact` writes redacted text and returns the byte length of what is stored;
  atomic (no half file visible, no `.tmp-` left after success); sanitised names (`../x`, `a b`, `con`, empty,
  two slugs that sanitise the same); attempt in the name; a write into a read-only folder rejects.
- `host.test.ts`: success output kept; failure output kept; failed command check keeps its output, a passing
  one writes none; `enabled: false` writes no file and no `output` field; `max_kb` is taken from the recorded
  history; two checks with the same output give two files; a retried node gives a file per attempt; a failing
  `writeArtifact` keeps the verdict and records `output_error`; a run without recorded `history` writes
  nothing.
- `hardening.test.ts`: a command that prints 100 MB (bounded memory, file at most the limit), binary
  garbage, invalid UTF-8, NUL bytes, ANSI escapes, a last line without a newline.
- Windows (CI matrix): CRLF output; a repository path with spaces.
- e2e: the built `dist/kodel.js` on plain Node runs a pipeline and the files appear;
  `scripts/check-artifact.mjs` passes.

## Risks

- **Old runs.** A run started before this change has no `history.output` in its journal or no `history` at
  all; it must not start writing files or crash. Handled by decision 6.
- **Concurrency.** The same attempt can be re-run after a restart while an old process still writes; the
  atomic rename makes the last writer win, no torn file.
- **Disk growth.** 64 KiB per command and per failed check per attempt; bounded by `max_kb`. Nothing is
  deleted by kodel (history is never rewritten).
- **Secrets.** Redaction happens twice (tail and store); a secret longer than the limit that straddles the
  cut is handled by redacting before the cut is shown only for what is kept: `runCommand` redacts after
  cutting, so a secret cut in half at the start of the kept tail could survive as a suffix. Mitigation: cut
  at the tail start on a boundary after redaction is not possible without keeping more; instead keep a
  margin (read `maxTail + 1 KiB`, redact, then cut to `maxTail`). To be settled in step 2 with a test.
- **`CheckVerdict` extension** must not leak the raw output into the journal; `runCheck` strips it before
  building the event, covered by a test that greps the journal for the secret.
- **Out of scope:** prompts, executor data and tool logs (other tasks of the series), the `report` layout,
  docs in `docs/` (written after the first working version).
