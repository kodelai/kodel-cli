# Examples

Complete pipelines. Replace the commands and `paths` with the project's own.

## lean: implement and verify

```yaml
version: 1
name: lean
description: Make a change and prove it with the project's own commands.
nodes:
  - slug: impl
    kind: agent
    prompt: |
      Task: {{task}}
      Make the change. Add or update tests for the changed behavior.
    checks:
      - { kind: diff, paths: ["src/**", "test/**"], min_lines: 1 }
  - slug: verify
    kind: command
    command: "npm run lint && npm test"
    timeout: 600
edges:
  - { from: impl, to: verify }
  - { from: verify, to: impl, when: failed }
```

## minimal: for a project with no commands to run

Use it when the project gives no manifest, CI, tests or linter: there is nothing to prove a change with, so
the only checks are the person's two. Never invent a command to fill the gap. The `diff` checks need a git
work tree and each run works in a copy made from the last commit: a project that is not a git repository
needs `git init` and a first commit of its files before the first run.

```yaml
version: 1
name: minimal
description: Plan, get the plan approved, implement, and get the result approved.
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Task: {{task}}
      Explore the repository and write a plan to docs/plans/{{task.slug}}.md: goal, files, steps,
      risks, and what you cannot check. Change no other file.
    checks:
      - { kind: diff, paths: ["docs/plans/{{task.slug}}.md"], mode: changed_only, min_lines: 10 }
  - slug: plan-approval
    kind: human
    prompt: Review the plan. Approve to start implementing, or reject with a reason.
    instructions: "Read docs/plans/{{task.slug}}.md."
  - slug: impl
    kind: agent
    prompt: |
      Implement the approved plan in docs/plans/{{task.slug}}.md and keep to it.
      Do not change docs/plans.
    checks:
      # all it can say about the layout of a project it does not know; the person's result check does the rest
      - { kind: diff, paths: ["docs/plans/**"], mode: unchanged }
  - slug: result-approval
    kind: human
    prompt: Try the result. Approve if it does what was planned, or reject with what is wrong.
    instructions: |
      The message to the person is the report. It leads with what was done, what is risky and what needs
      their decision; then the problems met and what was decided; then the checks that ran; details last.
      It points to docs/plans/{{task.slug}}.md and the diff of the change for the doubtful parts only.
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: result-approval }
  - { from: result-approval, to: impl, when: rejected }
```

## fork: verify and test at the same time

Two command steps start together after the change and meet at a join that sees which of them failed.
The join is an agent step: it fixes what failed and finishes with `restart_failed` to run only the failed
branches again, or with `passed` when both passed. The commands here are valid in a POSIX shell and in
`cmd.exe` alike (`node -e`).

```yaml
version: 1
name: fork
description: Make a change, then verify and test it at the same time; fix what failed.
nodes:
  - slug: impl
    kind: agent
    prompt: |
      Task: {{task}}
      Make the change. Add or update tests for the changed behavior.
  - slug: verify
    kind: command
    command: node -e "process.exit(0)"
    timeout: 600
  - slug: test
    kind: command
    command: node -e "process.exit(0)"
    timeout: 900
  - slug: fix
    kind: agent
    join: all
    prompt: |
      Verify and test ran at the same time on your change. If a branch failed, the feedback names it
      and says why: fix the cause, then finish with the outcome restart_failed so that only the failed
      steps run again. If both passed, finish normally.
edges:
  - { from: impl, to: verify }
  - { from: impl, to: test }
  - { from: verify, to: fix }
  - { from: verify, to: fix, when: failed }
  - { from: test, to: fix }
  - { from: test, to: fix, when: failed }
```

## standard: a plan and a result a person approves

```yaml
version: 1
name: standard
description: Plan, get the plan approved, implement, verify, test and get the result approved.
defaults:
  timeout: 900
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Task: {{task}}
      Explore the repository and write a plan to docs/plans/{{task.slug}}.md: goal, files, steps,
      tests, risks. Change no other file.
    checks:
      - { kind: diff, paths: ["docs/plans/{{task.slug}}.md"], mode: changed_only, min_lines: 10 }
  - slug: plan-approval
    kind: human
    prompt: Review the plan. Approve to start implementing, or reject with a reason.
    instructions: "Read docs/plans/{{task.slug}}.md."
  - slug: impl
    kind: agent
    prompt: |
      Implement the approved plan in docs/plans/{{task.slug}}.md and keep to it.
      Add or update tests for the changed behavior.
    checks:
      - { kind: diff, paths: ["src/**", "test/**"], min_lines: 1, max_lines: 800 }
  - slug: verify
    kind: command
    command: "npm run typecheck && npm run lint"
    expected_duration: 30
  - slug: test
    kind: command
    command: "npm test"
    expected_duration: 60
    timeout: 900
  - slug: result-approval
    kind: human
    prompt: Try the result. Approve if it does what was planned, or reject with what is wrong.
    instructions: |
      The message to the person is the report. It leads with what was done, what is risky and what needs
      their decision; then the problems met and what was decided; then the checks that ran; details last.
      It points to docs/plans/{{task.slug}}.md and the diff of the change for the doubtful parts only.
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: verify }
  - { from: verify, to: test }
  - { from: verify, to: impl, when: failed }
  - { from: test, to: impl, when: failed }
  - { from: test, to: result-approval }
  - { from: result-approval, to: impl, when: rejected }
```

## strict: an independent review before the result check

Like `standard`, with tests joined to `verify` and an independent review after it; the person's approval at the end is the same.

```yaml
version: 1
name: strict
description: Plan, implement, verify, review independently, and let a person accept the result.
defaults:
  timeout: 900
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Task: {{task}}
      Write a plan to docs/plans/{{task.slug}}.md: goal, files, steps, tests, risks.
    checks:
      - { kind: diff, paths: ["docs/plans/{{task.slug}}.md"], mode: changed_only, min_lines: 10 }
  - slug: plan-approval
    kind: human
    prompt: Review the plan. Approve to start implementing, or reject with a reason.
    instructions: "Read docs/plans/{{task.slug}}.md."
  - slug: impl
    kind: agent
    prompt: Implement the approved plan in docs/plans/{{task.slug}}.md, with tests.
    checks:
      - { kind: diff, paths: ["src/**", "test/**"], min_lines: 1, max_lines: 800 }
  - slug: verify
    kind: command
    command: "npm run typecheck && npm run lint && npm test"
    timeout: 900
  - slug: review
    kind: agent
    fresh_context: true
    prompt: |
      Review the change against the plan in docs/plans/{{task.slug}}.md. Report every problem.
    checks:
      - kind: result
        columns:
          severity: { enum: [blocker, major, minor, info] }
          location: location
          description: text
        fail_when: { severity: [blocker, major] }
        on_fail: blocking_findings
  - slug: result-approval
    kind: human
    prompt: Try the result. Approve if it does what was planned, or reject with what is wrong.
    instructions: |
      The message to the person is the report. It leads with what was done, what is risky and what needs
      their decision; then the problems met and what was decided; then the checks that ran; details last.
      It points to docs/plans/{{task.slug}}.md and the diff of the change for the doubtful parts only.
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: verify }
  - { from: verify, to: review }
  - { from: verify, to: impl, when: failed }
  - { from: review, to: result-approval }
  - { from: review, to: impl, when: blocking_findings }
  - { from: result-approval, to: impl, when: rejected }
```

## another way to end: an outcome besides passed

A step may finish with a label the prompt names, here when the task needs no change. Each outcome needs
an edge; here a person confirms it, which is this example's choice, not a rule.

```yaml
version: 1
name: with-outcome
nodes:
  - slug: plan
    kind: agent
    outcomes: [nothing_to_change]
    prompt: |
      Task: {{task}}
      Write a plan to docs/plans/{{task.slug}}.md. If the task needs no change, write why, with the
      evidence, and finish the step with the outcome nothing_to_change.
    checks:
      - { kind: diff, paths: ["docs/plans/{{task.slug}}.md"], mode: changed_only, min_lines: 5 }
  - slug: plan-approval
    kind: human
    prompt: Review the plan. Approve to go on, or reject with a reason.
  - slug: confirm-nothing-to-do
    kind: human
    prompt: The plan says nothing needs changing. Approve to end the run, or reject with what was missed.
  - slug: impl
    kind: agent
    prompt: Implement the approved plan in docs/plans/{{task.slug}}.md.
edges:
  - { from: plan, to: plan-approval }
  - { from: plan, to: confirm-nothing-to-do, when: nothing_to_change }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: confirm-nothing-to-do, to: plan, when: rejected }
```
