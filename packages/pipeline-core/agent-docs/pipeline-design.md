# Building a pipeline for a project

Build the pipeline from what the project already does, not from a template. Read (docs:pipeline-spec)
for the syntax, (docs:checks) for what decides a step and (docs:examples) for complete pipelines.

## 1. Ask how much to ask

Ask the person one question first: build the pipeline **together** (you ask questions about how they
work), or **on your own** (you explore and decide; most people choose this)?

- **On your own**: ask nothing more. Explore, choose a profile (below, `standard` if unsure) and write
  the pipeline. In your summary list every assumption: the commands you found, the profile, the
  steps you left out. The person can answer "stricter" or "no plan gate".
- **Together**: explore first, so you ask only what the repository cannot tell you. Ask in batches of
  a few questions, at most two rounds: how many checks (more checks cost more tokens and time, fewer
  let more through), whether a person approves the plan and the result, who reviews, how branches
  and pull requests work, which commands must never run automatically.

## 2. Explore

Look for the commands that prove a change is good, and use them as they are written there:

- the manifest and its scripts (`package.json`, `Cargo.toml`, `pyproject.toml`, `Makefile`, `go.mod`);
- CI files (`.github/workflows`, `.gitlab-ci.yml`): what CI runs is what "done" means;
- linters, formatters, type checkers and the test runner, and where tests live;
- `AGENTS.md` / `CLAUDE.md`: conventions to put in the prompts instead of repeating them;
- the repository layout, for the `paths` of `diff` checks.

Run a command once before you put it in a `command` node: a command the project does not have fails
the first run.

## 3. Choose a profile

| profile | steps | for |
| --- | --- | --- |
| `lean` | implement, verify | small changes, trusted tasks, low cost |
| `standard` | plan, plan gate, implement, verify, test | the default for feature work |
| `strict` | `standard` plus an independent review and a result gate | risky or shared code |

The complete pipelines are in (docs:examples). Take one and change what the project needs: its
commands, its `paths`, its prompts. Remove a step only for a reason you can state.

## 4. Traps

- `diff` `max_lines` counts tests; a limit set for code alone stops a good change.
- `{{task}}` may not appear in a `command`; use `{{task.slug}}`.
- Every `command` and `human` node needs an edge for its failure label, usually back to the step
  that can fix it.
- A `result` check on an agent node may use any `on_fail` label; the label needs an edge only if you want to
  send the run somewhere else than back to the same node (usually back to `impl`, as in the examples).
- Set `timeout` above what the command really takes (seconds).
- Say in each prompt what the step must not touch, and point to the project's conventions file.

## 5. Hand it over

Call `pipeline_propose_change` without `run_id`: `pipeline` is the whole YAML, `summary` is what you
assumed and why (the commands you found, the profile, the steps you left out). The engine checks it
and keeps it apart; nothing runs and no file is written. Tell the person the command in
`pipeline_proposal.apply`; they read the whole pipeline, with every shell command it runs listed
apart, and accept it themselves. Do not run that command and do not write into `.kodel/pipelines`.
If they want something different, propose again with the same name: the new proposal replaces the old
one. The answer says `kind: new`.

## 6. Changing a pipeline that exists

Read it with `pipeline_resolve` (the pipeline's name, no `run_id`): `yaml` is the file as it is. Change
only what the person asked for, keep the `name`, and send the whole YAML with
`pipeline_propose_change` (no `run_id`). The answer says `kind: change` and what differs per step.
In `summary` say what you changed and why. If the file changes before the person accepts, they are
told to ask you to propose again: read it again and redo the change on the new text.
A pipeline of a run that is going is changed with `run_id` instead, after asking the person.
