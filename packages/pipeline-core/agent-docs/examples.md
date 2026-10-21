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

## standard: a plan a person approves

```yaml
version: 1
name: standard
description: Plan, get the plan approved, implement, verify and test.
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
    files: ["docs/plans/{{task.slug}}.md"]
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
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: verify }
  - { from: verify, to: test }
  - { from: verify, to: impl, when: failed }
  - { from: test, to: impl, when: failed }
```

## strict: an independent review and a result gate

Like `standard`, with tests joined to `verify`, an independent review after it, and a person's approval at the end.

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
    files: ["docs/plans/{{task.slug}}.md"]
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
  - slug: accept
    kind: human
    prompt: Try the result. Approve if it does what was planned, or reject with what is wrong.
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: verify }
  - { from: verify, to: review }
  - { from: verify, to: impl, when: failed }
  - { from: review, to: accept }
  - { from: review, to: impl, when: blocking_findings }
  - { from: accept, to: impl, when: rejected }
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
