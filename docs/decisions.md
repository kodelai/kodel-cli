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
