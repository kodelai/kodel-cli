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

The server reads the block when it starts, so a change applies the next time the agent connects.

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

The gate tool takes the step's `node_slug` and `attempt` from the `waiting` answer. What the engine does check
is the same as for the command: the run is waiting at that step and attempt,
no other change of the pipeline holds the run, a rejection has a reason (or recorded comments), an approval
when the engine could not tell what changed needs `confirm_unverified`, and a change is taken only if it
is still the version named by `change_hash`. While a dialog is open for the run, the tools answer
`waiting` and decide nothing.

A decision made this way is written to the journal with `decided_by: agent` and the `instruction`, and
`kodel report` marks an accepted change of the pipeline as made by the agent. A person's decision is
written as before.

There is no switch for `ack`, `resume` or `seal`: they stay with a person, and the config refuses a key
for them. An agent that can propose a change of the pipeline and also accept it can weaken the checks
that judge its own work; prefer to leave `pipeline_change` off.
