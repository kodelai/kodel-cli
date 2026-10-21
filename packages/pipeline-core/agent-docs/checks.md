# Checks

A node's `checks` run in order after the node says it is done; the first one that fails stops the run
of checks and sends the node back with the reason. Without checks nothing but your word says a step
is done, so give every `agent` node at least one. Every check also takes `on_fail`: the edge label when
it fails (`failed` if absent). A `human` node takes no checks.

Which check for which job:

- "The agent changed what it should": `diff` with `paths`. `mode: changed_only` for a step that writes
  one file (a plan); `max_lines` to keep a step small (tests count too, so leave room); `mode: unchanged`
  to forbid touching files (generated files, the run history).
- "It works": a `command` node after the agent node, with an edge `failed` back to the agent. Use a
  `command` check inside the agent node only for a quick one.
- "An independent look found nothing serious": a `result` check on a review node. The agent reports
  rows through `pipeline_report_result` with the columns you list; `fail_when` names the values of an
  `enum` or `boolean` column that fail the check. Give it its own `on_fail` label and an edge back to
  the implementation. Add `fresh_context: true` on that node so the review is not done by the author.
- "A person agrees": a `human` node. The person approves or rejects with a reason.

A check passes or fails on facts the engine collects itself; what the agent says in its summary
never counts.

<!-- reference -->
