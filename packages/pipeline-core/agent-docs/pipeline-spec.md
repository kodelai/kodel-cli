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

Checks that decide a step are in (docs:checks); complete pipelines are in (docs:examples).

<!-- reference -->
