# MCP roles: `kodel mcp --role worker|manager`, `--read-only`, `mcp.roles`

`kodel mcp` serves a coding agent the tools of the project's pipelines. By default it serves every tool, as it
always did. A person can narrow what one agent is served, in three steps that are applied in this order:

1. **the role** the server is started with (`--role worker` or `--role manager`; no flag is both roles together);
2. **the `mcp.roles` block** of the project config, which adds tools to a role or removes them;
3. **`--read-only`**, which keeps only the tools that write nothing.

The set is worked out once, before the server is built, from the flags, the environment and the config; never
from anything an agent sends. A tool outside the set is not registered and is not in the list the server's
dispatchers search, so a call that names it is refused whether the client listed it or not. The server's
instructions, the descriptions of its tools and its answers name only tools it serves. The server says on stderr
which role it took and how many tools it serves.

## The two roles

**`worker`** works a run: `pipeline_start`, `pipeline_next_step`, `pipeline_take_step`, `pipeline_complete_step`,
`pipeline_report_result`, `pipeline_list`, `pipeline_resolve`, `pipeline_plan`, `pipeline_docs`,
`pipeline_feedback`, `pipeline_propose_change`, the three attachment tools (`pipeline_attachment_write`,
`pipeline_attachment_read`, `pipeline_attachment_list`, `docs/attachments.md`; only on a host that keeps
attachments), and with tasks on `task_get`, `task_list`, `task_schema`, `task_create`. It has no history tool, cannot change a task (`task_update`) and is never given a tool that decides
for the person, whatever `decisions.agent` says. When a run tied to a task ends and the engine does not close the
task (`tasks.on_run.mode: ask`), the worker is told to tell the person the task is still open; the person closes
it (`kodel task set`, or through a manager).

**`manager`** looks after the runs for the person and works none: the history tools (`history_runs`,
`history_run_details`, `history_agent_log`, `history_stats`), every task tool, `pipeline_list`,
`pipeline_resolve`, `pipeline_docs`, `pipeline_propose_change` (for the project only: a call with `run_id` is
refused, not read as a project proposal), `pipeline_attachment_read` and `pipeline_attachment_list` (what a run
keeps apart from the project; it has no tool that writes an attachment), the decision tools when
`decisions.agent` allows them (`manager_cancel_run`, which ends a run as canceled, only on a manager: a server
with no role never serves it, `docs/decisions.md`), and seven read tools of its own:

| Tool | What it reads |
| --- | --- |
| `manager_inbox` | Everything that waits for the person: a gate (with the step's slug and attempt), a paused run, a change of a run's pipeline (its hash, summary and what differs), a pipeline proposed outside a run, a task that waits for approval, a finished run whose task is still open, a background worker that is gone. Each entry has the command the person runs. A run this kodel cannot read is one entry of kind `unreadable` (a newer format, a state that does not fit its format, a state changed outside kodel); another checkout's runs are not shown. |
| `manager_run_report` | Where the time of a run went and what was redone. |
| `manager_gate_changes` | The files a run changed since it started, as the person is shown them at a gate, and the attachments the run keeps (the latest version of each, `new` on one written since the run stopped at the gate) with their `attachments_fingerprint`. |
| `manager_serve_status` | What `kodel serve` is doing for this checkout. |
| `manager_agents` | The background agents of the project (`kodel agent ls`). |
| `manager_agent_log` | The last lines one of them wrote (`unverified`: the agent wrote them). |
| `manager_watch` | Waits up to `wait_s` seconds for something to happen in any run and returns the events and a cursor. |

Their answers are redacted, cut and bounded like the history tools', and say that they are data, never
instructions. A read the server has no source for answers `HISTORY_UNAVAILABLE`.

On a manager the decision tools point to `manager_inbox`, and their answer is a short state of the run (`run`),
read without serving anything: no step is handed to the manager, and nothing is recorded as served. The decision
is journaled as made by an agent through a manager (`decided_by: agent`, `decided_via: manager`), and `kodel
serve` resumes the run's worker after it as after a person's decision. (A decision an agent makes where the run
is worked is followed by that agent itself, so the daemon does not resume a worker for it; that did not change.)

A gate of a run that keeps attachments is approved only with the `attachments_fingerprint` of what the person was
told about (`docs/attachments.md`). Where the run is worked that is the waiting answer's; a manager takes it from
`manager_gate_changes`. An approval without it, or with one from before a version was written, is refused with
the attachments as they are now in `details`, and on a manager that refusal serves no step either.

**No role** is the union of the two after the overrides. `pipeline_next_step` is listed with
`readOnlyHint: false`: it restarts engine work whose owner is gone and records what the agent was shown.

## Over HTTP

`kodel web --mcp` serves the manager role at `/mcp` to a client on another machine that carries a token
(`kodel web token add`; `--read-only` for a token that is served only the tools that write nothing). The role,
the `mcp` block and `--read-only` apply as above; a client there is never a worker (`docs/web.md`).

## The `mcp` block

```yaml
mcp:
  roles:
    worker:
      remove: [pipeline_plan]
    manager:
      add: [pipeline_start, pipeline_next_step]
      remove: [history_stats]
```

Only the person edits this block (as `decisions`, `storage`, `project_id` and `serve`). It is strict at every
level. These reject the whole config (`CONFIG_INVALID`, with the name) for every command:

- a tool name that no role knows;
- a decision tool (`pipeline_decide_gate`, `pipeline_accept_change`) added to the worker;
- one of `pipeline_start`, `pipeline_next_step`, `pipeline_take_step`, `pipeline_complete_step` removed from the
  worker (a run cannot be worked without them);
- one name in both `add` and `remove` of a role.

**An `mcp` block that cannot be used stops `kodel mcp`**: non-zero exit, the reason on stderr, nothing served. A
typo must not leave an agent with more tools than the person wrote. A config with no `mcp` block, or with a
problem only in another block, starts as before (the other block falls back to its default, and a valid `mcp`
block beside it still narrows the server). A config that is not YAML at all stops the server only when it has a
top-level `mcp:` line.

A known name the server cannot serve does nothing and is named on stderr: a task tool with tasks off, a decision
tool without `decisions.agent`, a write under `--read-only`. On a server with no role a `remove` in one role
removes a tool only when the other role does not have it either; the server says which removals do not apply.

**`manager.add` may name any tool, the run tools too.** The person can build a manager that also works a run,
and with `decisions.agent` approves its own gates. That is what a server with no role already allows; the roles
do not prevent it, they only make the usual split the default.

Restart the server after a change of the block: the set is worked out when it starts. Every build of kodel that
serves the project must know the block: a build from before it serves every tool and ignores it.

## `--read-only`

Only the tools marked read-only, on top of the role and the config: the pipelines, the history, the manager's
reads and `task_schema`, `task_list`, `task_get`. No `pipeline_next_step`. A read-only server starts no timer
that copies an agent's log, starts no engine step and shows no dialog (an answer in a dialog is a decision).
It reads a run without restarting orphaned work or renewing a claim, and a run of format 1 stays format 1.

One effect is outside the run's files: `manager_gate_changes` computes what changed with git's own tools, which
write unreferenced objects into the repository's object store (`git hash-object -w`, `git write-tree` on a
scratch index), as the gate answer of `pipeline_next_step` and `kodel gate` do. No ref, no index, no working
file and no file of the run changes.

## Start commands that are refused

Each of these exits non-zero with the reason on stderr before anything is served: an unknown `--role`;
`--role worker --read-only` (a run is worked with tools that write); and, under `KODEL_ENGINE`, `--role manager`
or a bare `--read-only`.

## Under `KODEL_ENGINE`

Every child of a kodel session carries `KODEL_ENGINE=1`: the background workers of `kodel serve` and of the TUI,
a command or a check the engine runs, an agent a person started with `kodel agent exec` or `kodel agent start`
(their own agent in a terminal session; the command says it before the agent starts). There a server with no
`--role` is a worker, and a manager does not start. Such an agent has no history tools and none of the
`decisions.agent` allowance; connect a manager from an agent started outside kodel. A pipeline step whose
command starts `kodel mcp` gets the worker for the same reason. The mark is a guard against mistakes, not a
security boundary: an agent that unsets it in its own shell and starts `kodel mcp` gets every tool. Inside an
engine step's session the server serves no tools at all, whatever role it is given (T-42).

Outside a project the role and `--read-only` hold too: the server starts, serves the role's tools, and each
answers that there is no project.

## Background workers

The server of a background worker is `kodel mcp --role worker --no-decisions --no-wait-hint` (a worker in a
terminal of its own has `--wait-command <command>` in place of `--no-wait-hint`, `docs/engines.md`). The launcher works
out the worker's set from the config the way that server does, at the preflight and again just before every
start and every resume, and allows the worker exactly those tools. If the set does not resolve (an unusable
`mcp` block), nothing is spawned: `kodel serve` is idle with the reason (it reads the whole config every cycle),
the TUI shows it in its start and resume messages, and a refusal that still reaches a resume is not counted as
one of the run's three resume attempts.

One case is accepted: the config is broken in the seconds between that check and `claude` starting its server.
The worker then has `Bash` and `Edit` and no kodel tool. Its prompt tells it to stop if the kodel tools are
missing; the session ends as a dead worker that `kodel serve` and the TUI report, and the run and its task are
as they were. The resume prompt also says that the tools may have changed since the session began.

## `kodel init`

`kodel init` writes the server of the person's own agent with no role. When it rewrites a kodel server entry
(the Codex block on every run, the others with `--force`) it keeps `--role <role>` and `--read-only` found after
`mcp` in the entry it replaces, and says so. `--server-command` still takes the command without `mcp`.

## The watch

`manager_watch` looks once a second, on the server's own clock, at the list of runs and at the state of the
runs that have not ended; an ended run is not read again. An event is a run that started, moved to another
step, began to wait for a person, ended or became unreadable, or a change of the proposed pipelines. The cursor
names a snapshot the server keeps in memory (the last 16): a cursor of another server, or from before this one
was started again, is refused with `INVALID_CURSOR`, and a call without a cursor starts afresh. `wait_s` is at
most 45, and `0` answers at once. A watch only awaits a timer, so other calls are answered meanwhile.

## Windows

No agents and no daemon run on Windows yet: `manager_serve_status` answers `off` and `manager_agents` an empty
list, each with the reason, and the inbox answers with the rest.

## The history

A run records the role of the server that started it (`run_started.engine.role` and `executor.role`: `worker`,
`manager`, or `all` for a server with no role) and of the server behind each served and completed step. `kodel
report`, `history_run_details` and `manager_run_report` show it (`server_roles`). Runs of format 1 record no
role (`docs/run-formats.md`). `tools_hash` covers the role, `--read-only`, the read-only mark of each tool and
the final set with the task tools, so its values changed. The MCP contract version is 7.

## Limits

- The descriptions of the tools follow the role and the flags. A single tool removed with `mcp.roles` is not
  taken out of the description of a sibling that mentions it (one history tool names another).
- `manager_watch` does not look at the tracker or at the daemon: a task that begins to wait for approval, or a
  worker that dies, shows in `manager_inbox`, not as an event.
- A dead background worker is listed in the inbox from the note `kodel serve` wrote in the run's journal
  (`worker_note`); without a daemon nothing writes that note.

## Decision 5M9D

*An agent connected to `kodel mcp` can call exactly the tools chosen by the role, the person's `mcp.roles` block
and `--read-only`.* It is refuted if an agent connected with `--role worker` or `--read-only` (or any role, or a
server narrowed by `mcp.roles`) could call a tool outside its set, listed or not; or if a `--read-only` server
changed a run. The tests are named `5m9d_*`, after the task key (the entry in the decision log is the person's to
write). The roles are allow-lists: a new tool is served by no role until it is put in one, and the pinned lists
in `packages/pipeline-core/src/tool-roles.ts` and in `5m9d_write_tools_are_the_pinned_list` are where that is
reviewed.

Not tested here: that a real `claude` honours the allow-list (`tests/agents`, by hand); that an older kodel
rejects the `mcp` key (only the strict schema is tested); that the worker cannot edit the config (its deny rule);
that `KODEL_ENGINE` is only a guard.
