# Building a pipeline for a project

Build the pipeline from what the project already does, not from a template. Read (docs:pipeline-spec)
for the syntax, (docs:checks) for what decides a step and (docs:examples) for complete pipelines.

## 1. Ask how much to ask

Ask the person one question first: build the pipeline **together** (you ask questions about how they
work), or **on your own** (you explore and decide; most people choose this)?

- **On your own**: ask nothing more. Explore, choose a profile (below; `standard` if unsure, except for a
  project that gives no commands, which section 3 settles first) and write the pipeline. In your summary
  list every assumption: the commands you found, the profile, the steps you left out. The person can
  answer "stricter", "no plan check" or "no result check" (the `minimal` form keeps both checks).
- **Together**: explore first, so you ask only what the repository cannot tell you. Ask in batches of
  a few questions, at most two rounds (one question for a project that gives no commands, see
  section 3): how many checks (more checks cost more tokens and time, fewer let more through), whether a person approves the plan and the result, who reviews, how branches
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
| `lean` | implement, verify | small changes, trusted tasks, low cost; the project has commands to verify with |
| `standard` | plan, plan check by a person, implement, verify, test, result check by a person | the default for feature work |
| `strict` | like `standard`, tests joined to `verify`, plus an independent review before the result check | risky or shared code |

**A project that gives no commands** (no manifest, CI, tests or linter, or a layout that is not a usual
project): do not choose `lean`, it would leave the person with no check at all. Use the smallest form, the
`minimal` example: plan, a plan check by a person, implement, a result check by a person, with no `verify`
and no `test` because there is no command to run (never invent one). Its `diff` checks need a git work
tree, and each run works in a copy made from the last commit: if the project is not a git repository,
say in the message that `git init` and a first commit of the project's files come first. In the "on your own" mode ask nothing:
say first in the message that the project looked empty and that this form was assumed, and that they should
say if they wanted something else. In the "together" mode ask once what they are building and offer this
form as the default. When commands appear later, the person asks for `verify` and you propose it.

What a good pipeline looks like, and a checklist for judging one, is in (docs:pipeline-quality).
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

For a **new** pipeline (`kind: new`; not for a change of an existing one) the message to the person also has:

- A diagram in one line of plain text, with `->` between steps and the steps where a person is asked
  marked, for example `plan -> [person: plan check] -> impl -> verify -> test -> [person: result check]`.
- One plain sentence for each step: what it does and what decides it. Write for someone who has never
  seen Kodel, not a list of slugs.
- Where the pipeline is. To read all of it: `kodel pipeline proposals show <name>` (the whole YAML, with
  every shell command listed apart). Once accepted it is the file `.kodel/pipelines/<name>.yaml` in the
  project root.
- The accept command from `pipeline_proposal.apply`, on a line of its own, with the words that it is run
  in the project root (the folder that holds `.kodel`).
- Then the part "Once the person accepts it" and the part "After the proposal", below. All of it goes in the
  same message: nothing calls you back when the person accepts, so do not wait for it, poll for it or
  ask first. Even in the "on your own" mode this is an offer after the proposal, never a question before it.

### Once the person accepts it

For a new pipeline only. Tell the person, briefly, what to do next. The commands are the person's; the
agent never runs them.

- Ask for a run with the `kodel-run` skill (in Claude Code: `/kodel-run <task>`). Say what happens then,
  for the steps of the pipeline that was proposed and not for another one: where the agent works alone, which
  checks the engine runs and judges (the engine, not the agent, decides that a step is done), and where
  the run stops for the person (in `standard`, `strict` and `minimal` at a plan check and at a result
  check; `lean` has no planned stop). Any run also pauses for the person when a step keeps failing. At each
  stop the agent says what is to be decided and with which command.
- `kodel status` lists the runs; `kodel status <run>` shows one run.

Nothing else is listed: the agent gives the command when one is needed.

### After the proposal

For a new pipeline only. End the message with two offers, each with concrete variants, and one invitation.
Offer only what fits the pipeline you proposed. For the `minimal` form (a project with no commands) the only
offer is to add checks as soon as the project has commands (`verify`, `test`, then `standard`), or reviews by
subagents. Do not offer `lean`, `strict`, leaving out `test` or leaving out either check by a person there:
nothing would be left to check, or the project has no commands to check with.

- **Stricter** (more tokens and time, fewer mistakes get through): more checks that the project already has
  (tests, linter, build) if the pipeline lacks them; more reviews by subagents: an independent review in a
  fresh context (profile `strict`) and, if wanted, more reviews from different sides, such as security or
  a business role. More in (docs:pipeline-quality). Offer the ones that fit, with what each costs.
- **Faster and cheaper** (fewer checks, more trust): `lean`; leaving out the `test` step; leaving out the
  plan check by a person (say what it costs: a wrong plan is found only after the code is written).
- **Tell me more**: invite the person to describe how they work in more detail (who reviews, how branches
  and releases go, what they repeat by hand), to find more to automate. If they answer, propose again with
  the same name; do not edit anything.

## 6. Changing a pipeline that exists

Read it with `pipeline_resolve` (the pipeline's name, no `run_id`): `yaml` is the file as it is. Change
only what the person asked for, keep the `name`, and send the whole YAML with
`pipeline_propose_change` (no `run_id`). The answer says `kind: change` and what differs per step.
In `summary` say what you changed and why. To judge the pipeline first, use the checklist of
(docs:pipeline-quality). If the file changes before the person accepts, they are
told to ask you to propose again: read it again and redo the change on the new text.
A pipeline of a run that is going is changed with `run_id` instead, after asking the person.
