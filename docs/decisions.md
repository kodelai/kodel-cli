# Who decides: the dialog and the agent's decisions

A gate, a pause, a change of a run's pipeline and a state changed outside kodel wait for a person.
By default the person decides with a command (`kodel gate`, `resume`, `pipeline changes apply`, `ack`),
after the agent has told them what is asked. The project config can change how, in one strict block.
Every switch is off by default, and a misspelled key is an error that names it.

```yaml
decisions:
  dialog: false            # the form in the coding agent's own interface
  agent:
    gate: false            # the agent may approve or reject a gate when the person tells it to
    pipeline_change: false # the agent may accept a change of a run's pipeline when told to
```

The server reads the block when it starts, so a change applies the next time the agent connects. If the
config cannot be read (a typo in a key, for example), the server starts with everything off and the
dialog off, without an error; a command that reads the config names the problem. Only the person edits this block:
a project should tell its agent not to (this repository does, in `AGENTS.md`), since a switch the agent
can turn on for itself protects nothing.

## `decisions.dialog`

A client that can show a form (MCP elicitation) is asked there when a call would answer `waiting`, and
the call stays open until the person answers or 10 minutes pass. The answer is the same decision as the
command. It is off by default because the open call stops the person from asking the agent a question
first. With it off, the agent answers `waiting`, writes what is asked, and the person decides when ready.
`KODEL_DIALOG_TIMEOUT_S` in the server's environment changes how long a dialog stays open.

## `decisions.agent`

With a switch on, the server serves one more tool and tells the agent about it in its instructions
and in the `tell_the_person` of the matching `waiting` answer:

| switch | tool | what it does |
| --- | --- | --- |
| `gate` | `pipeline_decide_gate` | approves or rejects the step a run waits at |
| `pipeline_change` | `pipeline_accept_change` | accepts the change of the run's pipeline that waits, named by its `change_hash` |

The agent is told to call a tool only when the person has said so in the chat, and to pass their words
as `instruction`. The engine cannot check that. These switches are protection against a mistake, not
against an agent that ignores its instructions: turn one on only where you accept that.

The gate tool takes the step's `node_slug` and `attempt` from the `waiting` answer (every gate answer
has both). What the engine does check is the same as for the command: the run is waiting at that step
and attempt, no other change of the pipeline holds the run, a rejection has a reason (or recorded
comments), an approval when the engine could not tell what changed needs `confirm_unverified`, and a
change is taken only if it is still the version named by `change_hash`. The waiting text offers
`pipeline_accept_change` only for a change that has a hash and was not refused.

The tools work with the dialog off too (then they never wait on a form). With it on, the dialog and the
agent's decision never both decide: from the moment an answer needs the person until the form is dealt
with, the tools answer `waiting` and decide nothing; while the agent is applying a decision, no form is
started for it. The check is for the whole server, not per run: a form open for one run holds the agent's
decisions on every run until it is answered. A state changed outside kodel is refused for the agent as
for anyone: only `ack` accepts it, and that stays with the person.

A decision made this way is written to the journal with `decided_by: agent` and the `instruction`
(redacted like any other text; at most 1000 characters, and 2000 for the `reason`). `kodel report` lists such decisions, gates and accepted changes of the
pipeline alike, and `kodel status <run>` shows a `by agent:` line for each. A person's decision is written
as before and carries no mark.

**What "no mark" does not prove.** A dialog (`decisions.dialog: true`) is answered by whoever can type into the
client that shows it. If that client runs inside a terminal session (`kodel agent exec --pty`), any process of the
same user can type into it through the session's attach socket (`docs/session-formats.md`), the agent in that
session included, and the journal cannot tell such an answer from the person's: it is written with no
`decided_by: agent`. Nothing in kodel stops or marks this. A project that needs the difference keeps `dialog` off
for agents it runs in terminal sessions.

There is no switch for `ack`, `resume` or `seal`: they stay with a person, and the config refuses a key
for them. An agent that can propose a change of the pipeline and also accept it can weaken the checks
that judge its own work; prefer to leave `pipeline_change` off.

## Roles of the server (5M9D)

The two tools are served by a server with no role and by a manager (`kodel mcp --role manager`), never by a worker:
a server started with `--role worker`, and any server under `KODEL_ENGINE` (a background worker, an agent started
with `kodel agent exec`), decides nothing for the person whatever this block says, and its texts have no word of the
tools. On a manager the tools point to `manager_inbox`, their answer is a short state of the run and no step, and the
journal marks the decision `decided_via: manager`; `kodel serve` then resumes the run's worker as after a person's
decision. The `mcp.roles` block cannot give the worker a decision tool, and it can give a manager the tools that work
a run: such a manager, with `decisions.agent` on, approves the gates of its own work, which is what a server with no
role already allows (`docs/mcp-roles.md`).

## `kodel serve` decides nothing (T-44)

The daemon (`docs/serve.md`) starts and resumes background workers by the person's `serve` block: one pure
function plans, one launcher starts each run's agent once, one lock admits a start, one owner resumes. It
decides nothing about a run (no gate, pause, change of the pipeline or `ack`; a resume after your decision only
gives the run an agent again) and writes only the fact that a worker is gone (`worker_note`). A task an agent
made or changed waits until a person runs `kodel task approve`, and the `serve` block is the person's, like this
one: the agent is told not to edit it and not to run `kodel serve` or `kodel task approve`. Test plan: the `t44_*`
tests; the refutation criteria are at the end of `docs/serve.md`.

The person decided that a rule of the block may start tasks an agent wrote without an approval:
`serve.start[].match.approval: any` (the default stays `required`). Only the person edits the `serve` block, so
this is a person's decision made once for a rule, not one the agent can make; a task that waits for approval
and is not taken by a `required` rule may be taken by a later `any` rule
(`t44_rule_approval_required_skips_and_any_takes_an_agents_task`,
`t44_rule_with_approval_any_starts_an_agents_task_with_its_pipeline`).

T-47 (below) revised T-44; `docs/serve.md`, "T-44 as revised by T-47", keeps the old lines and
says why each was replaced.

## A background agent in a terminal decides nothing either (T-47)

*Every background agent of a run, whether the TUI, `kodel serve` or `kodel agent start --pipeline` started it,
is started by one launcher from one profile, as a terminal session a person can open and leave
(`engines.claude.worker: terminal`, the default) or as a print process (`print`); nothing switches between the
two by itself. A terminal agent stays alive at a gate and goes on after the person's decision; it cannot
decide. Kodel never types into a session.*

What keeps such an agent from deciding:

- **Its kodel server serves no decision tool.** The server of a background agent is `kodel mcp
  --no-decisions`, whatever `decisions.agent` says, and it is the only MCP server of the session
  (`--strict-mcp-config`). It shows no dialog; with `decisions.dialog` on, every background agent is refused
  at its start.
- **Its lists.** An allow list without the decision tools, and a deny list with them, with every command that
  is a person's (in the spellings `kodel`, `main.ts` and `kodel.js`, also behind `env X=…`) and with the files
  that are yours (`.kodel/config.yaml`, the pipelines, the runs, `.mcp.json`, `.claude/settings*.json`).
  Patterns are substrings: a variable or a decoded string passes them. The files of a terminal worker are
  denied with `Edit(<path>)` rules alone, which cover every file-editing tool of Claude Code (it prints a
  warning on the agent's screen for each `Write(<path>)` rule); a print worker's list keeps both.
- **The three guards of a person's command.** `gate`, `resume`, `ack`, `seal`, `migrate`, `task approve`, the
  `pipeline changes|proposals` decisions and the person's `agent` commands refuse:
  1. **the mark**: with `KODEL_ENGINE` in the environment, which every process of an agent session has
     (`this command is for a person; it will not run from a command the engine runs`). A program that unsets
     it (`env -u`) passes this one;
  2. **the session**: when one of the command's parent processes is the holder of a live kodel agent session
     or the process that holder started, or when the command runs on the terminal of one (`this command is
     for a person; it will not run inside a kodel agent session`), whatever its environment and its terminal
     say. A holder is known by its own command line, so a session is found whatever state base its record
     is under (a session's environment gets no `KODEL_STATE_DIR`); the records of the state base the command
     resolves also name an agent whose holder is gone, also one whose holder recorded `killed` or `lost`
     while the process it started still runs. Where the process table cannot be read (a sandbox)
     this guard says nothing and the other two decide: a person there must still be able to decide;
  3. **the terminal**: without a terminal on stdin and stdout (`this command is for a person at a terminal;
     it will not run from a script or an agent`). The shell commands of Claude Code have no terminal.

  With a print agent the third guard refused every command of the agent. An agent in a terminal of its own
  has one, so the second guard was added: getting past needs what it needed before, a process that leaves its
  session and gets itself a terminal of its own. **These are guards against mistakes, not a security
  boundary**: a program run by the same user can arrange what each one looks at.

What stays open, stated and not closed:

- **`kodel mcp` by hand in a shell is accepted.** An agent with a shell can start a kodel server of its own
  (`kodel mcp` with no `--no-decisions`) and speak to it; with `decisions.agent` on, that server serves the
  decision tools. The person accepted this: the switches of `decisions.agent` are already "protection against
  a mistake, not against an agent that ignores its instructions" (above), and with them off, as by default,
  no server decides.
- A process that left its session and has a pseudo-terminal of its own passes all three guards.
- An agent whose holder is gone, in a session that was started under a `KODEL_STATE_DIR` its own environment
  does not have, is not found by the second guard (no holder runs, and its record is in another state base);
  the mark, the deny list and, for its shell commands, the missing terminal remain. Claude Code ends when
  its terminal hangs up, so it does not outlive its holder.
- A worker's shell can edit `.kodel/config.yaml`, which is why `engines` is used only as committed; an agent
  that can commit to the checkout's branch still changes it.
- The attach socket is no boundary (`docs/session-formats.md`): any process of the same user can type into a
  session.
- A person can switch a worker's permission mode in the agent's own interface; the lists then hold as that
  mode says.
- A plain `kodel agent start` (no `--pipeline`) is your own agent, not a worker: it uses the project's own
  kodel server, which may decide when `decisions.agent` is on, and shows its dialogs in its own terminal. The
  command says both.

Test plan: the `t47_*` tests, the `tA_*` tests of the sessions and the real-terminal rows of
`tests/pty/worker-terminal.test.ts`. What they cannot show is in `tests/README.md`. The decision is refuted
if: with `worker: terminal`, a worker started by the TUI or the daemon is not attachable, or a `-p` worker is
started instead; a worker decides its own gate; after a detach or an ended agent the TUI is not where it was,
or the terminal is broken; kodel types into a session; a decided run with a live worker neither goes on nor
is reported within 2 minutes; a run left at a gate by a reboot is not resumed after the decision; a resumed
session loses its name or its conversation; a person's command decides when run by a process whose parents
still include its session's holder; a session is held alive for good by a process that is not its own, or
`kodel agent stop` cannot end one whose process runs.
