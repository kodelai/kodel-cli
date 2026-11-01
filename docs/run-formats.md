# Run formats: what happens to a run when kodel is updated

A run keeps the format of its stored data (the `v` of `state.json` and of the journal records) from
its start to its end. When you update kodel in the middle of a session, a run that was going goes on:
the new kodel reads and writes it in the format it started with, so the old MCP process that is still
open, the new MCP after a restart and any `kodel` command all work on the same run. A new run starts in
the newest format. `kodel status`, `report` and the history read every run, finished ones too.

There is nothing to migrate for this. The one thing that changes a run's format is a command a person
runs on purpose (below).

## What a run of format 1 cannot do

Format 1 (every run written before forks: the early builds, the published `0.1.0-beta.0`, `main` until
the fork merge) has room for one step at a time, one pause, and no worker claims. When such a run is
asked for something it has no place for, kodel refuses **before anything is written** with
`UNSUPPORTED_FORMAT_FEATURE` and the run stays as it was:

- a pipeline with a fork and a `join` proposed or accepted into it (`pipeline_propose_change`,
  `kodel pipeline changes apply`);
- a second pause, a fork attribution, a worker's claim on a step (`pipeline_take_step` answers that
  there is no step to take).

The answer tells the agent to offer you the way up. The agent does not run it, and you may decline it:
the run then goes on with these limits.

A run of format 1 also keeps the behaviour its engine had where it differed: it does not keep a
declared outcome after a failed check (a recheck then ends as the old engine's did), it reads two edges
for one label as the first one winning, and the stale-result rule uses the version of the run. Every
other fix since applies to every run.

New text always meets today's rules: two edges for one label with no `join` stay an error in a pipeline
file, in a proposal and in a change you apply. Only a pipeline already kept with an old run is read the
old way.

## Limits that a newer kodel cannot lift in an older one

If an older kodel (a session you have not restarted, a `kodel` older on your `PATH`) works on the same
run:

- It refuses a project config with a key it does not know. `main` before forks refuses `agents:`; the
  published beta also refuses `decisions`, `history`, `prompts`, `executor`, `tool_log`, `storage` and
  `project_id`. In a project that uses one of them the older kodel cannot start at all.
- The beta does not see runs kept with `storage: home` and keeps its trusted hashes by path, not by
  project id.
- Neither older kodel retries a lock another process holds: on Windows a call can fail once with
  `EPERM` while the newer one holds it (the state is untouched; try again), and the rename of
  `state.json` can fail while the older process has it open.
- After the newer kodel starts a run of the newest format for a pipeline and task, the older
  `pipeline_start` for that same pair throws instead of starting a run.
- An older `kodel wait` that watches a run that was upgraded is not told what happened.
- An older process that writes back a state it kept in memory after the run was upgraded leaves a run
  the new kodel refuses to read (it says the state is written in an older format than its journal records); finish such a run with the
  kodel that has it open, or upgrade first and close the older session.
- The beta may not read a run after a newer kodel has written it: its shape has grown since.

These are known and are not tested in CI. A run from before pipelines were kept in versions
(`meta.json` format 1) is read and listed, but no kodel except the one that started it can continue it;
it still blocks `pipeline_start` for its task until it is finished.

## The way up

`kodel migrate <run>` (in a terminal, by a person) takes a run that is going to the newest format. It
is one way: the older kodel will not read the run afterwards. Close every older session on the run
first, including one waiting at a gate or in the middle of an agent step, which send no heartbeat.
After it the run can fork and claim like any new run, and its old snapshots still read as before. The
agent is told to offer it and never runs it.

## Pipelines written with `format:`

The key was renamed to `version` before the first runs this repository keeps (`format: 1` is now a
generic unknown-key error). Accepting both keys in pipeline files, with an error when they differ, is
proposed in a follow-up task. No kept pipeline of a supported run uses `format:`, so the reader of kept
pipelines does not accept it.

## Tool calls (TASK-ZKRH)

The record of the agent's tool calls adds an optional `toolCalls` key to `state.json`, two journal events
(`tool_calls_recorded`, `tool_calls_failed`) and `tool_calls` to `run_started.history`, in format 1 and in
format 2 alike (the codec of format 1 keeps them as it keeps `usage`). A run that was going when kodel was
updated has no `tool_calls` in its frozen history, so it reads `not_captured` and goes on as before; a run
started after the update records tool calls. An older kodel that goes on with such a run keeps `toolCalls`
as it is and does not update it, and refuses a project config that has `history.tool_calls` (the `history`
section is strict). Nothing here needs `kodel migrate`.

## When the formats change again

A change of a stored format ships a codec for the previous one, a real fixture and the tests, and
says here what a run in flight does (AGENTS.md, "Stored data and compatibility", rule 5).
