# Engine steps

An engine step is an agent node with `engine: <profile>`. Kodel does not hand it to the coding agent
that drives the run: it runs the profile's program itself, as a detached session, and reads its result.
The step outlives the driver and the MCP server that started it. Decision T-42.

## Off in this build

Engine steps are off. `KODEL_ENGINE_STEPS` in `packages/cli/src/engine-steps.ts` is a constant of the
build, `false`, not a variable of the environment, so an agent cannot switch it on. With it off, every
host is built without engine steps, and a pipeline with an engine step is refused before anything is
written ("this kodel does not run engine steps").

It is turned on in a one-line change once two parts of TASK-KDJS are on main: D-B (a child of an engine
step is not a second kodel client) and D-C (`engines:` is in the list of keys only the person changes).
Everything below describes what runs once it is on; the code and its tests come with the change that
adds engine steps (TASK-NNR3), with the flag off.

## The profile

A profile is a block of `engines:` in the project config (`.kodel/config.yaml`). It is the person's
block, like `decisions`: the agent never edits it.

```yaml
engines:
  claude:
    command: [claude, -p, --output-format, json]
    model_flag: --model
    pass_env: [ANTHROPIC_API_KEY]
    env:
      CLAUDE_CODE_DISABLE_TELEMETRY: "1"
    timeout: 1800
```

- `command`: the program and its fixed arguments. The prompt comes last, as one argument after `--`.
- `model_flag`: how the program is told the node's `model` (here `--model <model>`).
- `env`: literal values for the step's environment.
- `pass_env`: names of the host's variables passed on as they are.
- `timeout`: seconds a step may run when its node does not say (at most 86400).

A profile name is lowercase letters, digits, `-` and `_`. A variable name may not start with `KODEL_`.

## The node

```yaml
- slug: implement
  kind: agent
  engine: claude
  model: sonnet
  prompt: Implement the plan in docs/plans/{{run.slug}}.md.
```

`engine` names the profile; `model` is passed with `model_flag` and is allowed only with `engine`. The
timeout is the node's, else `defaults.timeout`, else the profile's, else 3600 s.

Refused at validation, with a reason:

- `model` without `engine`;
- `fresh_context` (the process starts fresh anyway);
- `outcomes`, a `result` check, or `join` on an engine step;
- an engine step in a pipeline that has any fork or join (not only inside a branch);
- an engine step on a host that does not run them, on Windows, or in a project whose redaction rules
  include one with a function (a session cannot apply it). These are refused before anything is
  written, on start, propose, accept and `proposals apply`;
- an engine step in a run of format 1: `UNSUPPORTED_FORMAT_FEATURE`, and the answer offers
  `kodel migrate`.

Forks, joins, `result` checks and `outcomes` on an engine step are a follow-up task.

## How a step runs

- The session is named `ke-<run id>-<visit id>-<attempt>`. `kodel agent ls` shows it.
- A run has at most one open engine record (`engineSession` in `state.json`). It is written **before**
  the session starts, and any open record blocks a new start until its outcome is known or a person
  resumes.
- Only `kodel mcp` starts a session. A person's command (`gate`, `resume`, an accept) enters the step
  and returns at once; it never waits for the step and never starts it.
- The MCP host's next tick (or `pipeline_next_step`) starts it, under the state lock. This is not a
  restart and counts nothing.
- A later MCP host finds the session by id, or by name when the id was not written yet, and joins it.
  A step that runs as a session is never restarted by the stale rule; a takeover is a join.
- The driver cannot complete an engine step. `status`, `report`, `wait` and `agent ls` only read.
- When the MCP server shuts down it stops waiting (the session runs on) and writes on stderr which sessions
  it waited for, each with `kodel agent stop <id>`. A cancel of the run ends the run, not its session, and
  its answer names the session the same way.
  The host never removes a session record.

The prompt is the node's prompt, what its checks ask, and why the last attempt failed, at most 64 KiB.

## The result

The step succeeds only when the program exits with code 0 and prints on stdout one JSON object with a
string `summary` or `result` (other keys are allowed), at most 128 KiB. `claude -p --output-format json`
prints such an object. Output over the cap fails the step; it is never cut and then read. The checks of
the node then run on the redacted output as on any step.

| Outcome | When | The attempt |
|---|---|---|
| result | exit 0, the child gone, a valid object within 128 KiB | the checks decide |
| failed | non-zero exit, killed, output cut or invalid, the profile cannot be resolved, prompt over 64 KiB, a start that threw and left no session | fails (`source: "command"`) and is retried as usual |
| unknown | anything else: the session cannot be read, belongs to another checkout, is of a newer format, a start whose result cannot be proven | fails (`source: "session"`) and the run pauses |

Kodel never reads a result or a failure while the child is alive.

## Outcome unknown

The attempt fails, the run pauses (`consecutive`) and the record stays. The reason starts with
"outcome unknown, a person decides" (a child's output cannot forge it) and names the session and
`kodel agent logs <id>` and `kodel agent stop <id>` (and "upgrade kodel" for a newer format).

Nothing goes past this pause but a person's `kodel resume`. An accept of a change of the pipeline is
refused while it holds. On `resume` kodel looks the session up:

- still running: refused, "stop it first: `kodel agent stop <id>`";
- ended, or not listed: the record is cleared and the run goes on;
- unreadable, of another checkout or of a newer format: cleared, with a warning that names the session.

The person's resume is the confirmation. It may redo the work of the lost attempt.

## Environment and redaction

The child does not inherit the host's environment. It gets `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`,
`TMPDIR` and `TERM` when they are set, the variables named in `pass_env`, and the profile's `env`.
Everything else is dropped (`SSH_AUTH_SOCK`, `XDG_*`, proxy variables, every `KODEL_*`); the session
holder adds `KODEL_ENGINE=1`, so every human-only command refuses inside the step. The working directory
is the run's workdir.

The values of `pass_env` and `env` that are at least 12 characters long are redacted as literals, with
their JSON-escaped forms (`/` also as `\/`), from everything kodel keeps: the output, what the checks see,
the journal, the session's tails and its argv. A token with `/` in it (base64) is redacted like any other.
Two kinds are not, and this is a gap: shorter values, and paths of this machine (a value that starts as a
path does, whose segments are plain words, and that exists on disk).

## The `kodel mcp` guard

`kodel mcp` started inside the process group of a live host session serves no tools, so an engine step
cannot drive its own run. The group is read with `ps -o pgid=` or `/proc/self/stat`; when both fail the
guard fails open.

Engine steps run on macOS and Linux only.

## Residuals

- A `pass_env` value the person types into the task text stays in the run: `run_started` and the state
  keep the task as typed (redacted by the project's rules only, before any profile is read).
- A secret written into a profile's `command` (an `--api-key` argument, say) is not redacted: only the
  values of `env` and `pass_env` are. It reaches the session record's argv and the input of the `launch`
  hash. Pass secrets through the environment.
- The output of a joined session is the holder's tail, which the holder redacted with the rules it was
  started with; the joining host redacts it again with the project's rules only (it does not know the
  literal values of the start). Another adapter (Kodel Server's runners) must redact its output the same way.
- A lock broken as stale while its holder is frozen inside a start can let a second start through.
- The profile's content is not pinned with the run; a changed launch shows only as another `launch`
  hash in the journal (`engine_session_started`).
- An older kodel, or a `.mcp.json` from a branch without the guard, in the child serves tools.
- The guard fails open when both `ps` and `/proc` fail.
- The guard knows a session's group only once the holder has recorded its child: in the moment between
  the spawn of the child and that record, a `kodel mcp` in the group would serve its tools. Treating every
  starting session as "inside" would withhold the tools from every `kodel mcp` of the person meanwhile, so
  it is not done; the window is the holder's start, far shorter than an agent CLI takes to start one.
- A profile cannot set or pass `HOME` (or `USERPROFILE`), which would move the state base the guard of the
  child's `kodel mcp` looks in. Under a holder (`KODEL_ENGINE=1`) the guard also looks in the account's
  own base (`os.userInfo().homedir`), so a child that changes `HOME` itself does not hide its session
  either; a program that changes the account's home or removes the variable and its group as well is
  not covered. `KODEL_ENGINE=1` alone never withholds the tools: a person's own agents carry it too.
- A descendant that moves to its own process group outlives the child.
- A resume after an unknown outcome may redo work.
- Short values of `pass_env` and `env`, and values that are existing paths of this machine, are not
  redacted.
- An absent exit code is recorded as 0 by the holder.
- `ke-` session records are never removed by the host and grow (the cost of `list()`); follow-up
  "Free finished `ke-` records".
- The child's tool calls are not in the run's history.
- A second host (Kodel Server) must provide the state lock, re-read under it and start by the same rule.

## Known gaps

- The gate report reads `agent_completed` only, so it shows no summary of an engine step.
- Engine runs get no workdir fallback.
