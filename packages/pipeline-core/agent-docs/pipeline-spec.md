# The pipeline file

A pipeline is one YAML file, `.kodel/pipelines/<name>.yaml`: a list of `nodes` (steps) and the `edges`
between them. The engine runs the first node, decides itself whether it is done, and follows an edge.

- A node has a `kind` that says who works: `agent` (you), `command` (the engine runs a shell command),
  `human` (a person decides: `approved` or `rejected`).
- A node ends with a label: `passed` (an agent or command node that did its work and passed its checks),
  `approved` or `rejected` (a human node), `failed` or the `on_fail` of a check (something did not hold).
  An agent node may list `outcomes`, other labels it can finish with.
- An edge `{ from, to, when }` is taken when the node ended with `when`. `when` defaults to the node's
  success label. A node with no edge for its label ends the run.
- A failed `command` or `human` node must have an edge for the failure label. A failed agent node with
  no edge for it is given back to the agent with the reason.
- An edge's `when` must be a label its node can end with (`approved` on an agent node is refused), and an
  edge from a node to itself is refused.
- Every node must be reachable from the first one.
- Text fields may use `{{task}}` (the user's words), `{{task.slug}}` (a short file-name form of it),
  `{{run.slug}}` (the name the agent gave the run when it started it, or one made from the task text:
  lowercase letters, digits and dashes, at most 40 characters) and `{{run.start_date}}` (the UTC day the
  run started, `YYYY-MM-DD`). `{{task}}` is not allowed in a `command`: it is free input and would be
  injected into the shell; the others are safe there.
- `{{run.slug}}` is a label, not an identity: two runs may have the same one. A path that must differ
  between runs (`docs/plans/{{run.start_date}}-{{run.slug}}.md`) is the pipeline's to make different.
  In a dry run (`pipeline_plan`) there is no run yet, so `{{run.start_date}}` shows as `YYYY-MM-DD`.
- Times (`timeout`, `expected_duration`) are in seconds, and `expected_duration` may not exceed `timeout`.
  `max_consecutive_failures` may not exceed `max_attempts`.
- To write a literal `{{` in a text field, write `\{{`.
- `version` is the file format. Leave it as `1`.

## Forks: steps that run at the same time

Several edges with the same `from` and `when` start their targets together (a fork); the branches meet at
a node with `join: all`, which starts once every branch has arrived. Rules the parser enforces:

- Every branch must reach the join, and only the join: no edge leaves a branch to a node outside it, no
  edge enters a branch from outside, the branches share no node, and a branch cannot route a failure to a
  node before the fork. A `human` node in a branch routes `rejected` inside the branch or to the join.
- Only the branches enter the join: a node after the join cannot route back into it (`j --failed--> fix
  --> j` is refused, "enters the join from outside the fork"). To repair what the join found, give the
  repair its own check node after the join (`j --failed--> fix --> verify`), or route back to a node
  before the fork, which runs the fork again.
- A branch arrives by any label with an edge to the join, `failed` included: the join then starts with a
  `reentry_feedback` naming every failed branch. A branch with no edge for its label is dead: the run
  ends `failed` once the other branches have settled.
- An `agent` join may finish with the reserved outcome `restart_failed` (do not list it in `outcomes`;
  it needs no edge): after the join's checks pass, the failed branches start again and the join waits
  for them. A branch a person rejected at a gate is not restarted this way. The join's `max_attempts`
  bounds how often.
- Nested forks are refused: a fork inside a branch is a deliberate limit of this engine, as are two forks
  from one node and a join reached from two forks. A second edge with the same `from` and `when` used to
  be ignored; without a `join: all` node where the branches meet it is now an error.
- Agent steps of several branches are open at once: `pipeline_next_step` lists them in `steps` and says
  in `execution.mode` whether this project works them in parallel (one worker per step, each taking its
  step with `pipeline_take_step` and completing it with the `claim_token`; a claim lapses after
  `agents.claim_ttl_s`, 900 s by default, and `agents.max_parallel`, 8 by default, caps the steps in
  flight: with that many held, `pipeline_next_step` hands nothing out, a take by slug answers
  `status: "queued"`, and a take without a slug answers `status: "none"` whose `next` is a `running`
  summary with `queued` (how many open steps wait), until a step is handed in) or one by one; the `agents.subagents` setting of the project config decides (`yes`, `no`, or `auto`, the default: in parallel once the agent passes `subagents: {can: true}` to `pipeline_next_step`, which the one-by-one instruction tells it to do if it can start subagents).
  A claim keeps two workers off one step; the engine never refuses a completion for a missing one.
- The branches share one working tree. A `diff` check in a branch is not a check of that branch alone:
  it sees what the other branches wrote, and a baseline that could not be recorded fails the check. Put
  the verdict in the join's checks and the rework after the join. The patches kept for hand-ins of
  open steps may overlap, and what a gate lists as changed may be another branch's work (the answer
  says so). No node is shared between branches, so a repair step cannot serve two branches: give each
  its own, or repair after the join.

Checks that decide a step are in (docs:checks); complete pipelines are in (docs:examples).

<!-- reference -->
