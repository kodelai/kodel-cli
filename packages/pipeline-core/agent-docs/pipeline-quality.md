# What makes a pipeline good

Use this when you design a pipeline (docs:pipeline-design) and when you judge one that exists. The idea is a
balance: the agent works alone as long as it can and checks itself, and the person decides in two places
only, the plan and the result. Every extra question to the person costs their attention; every missing
check costs a mistake that gets through.

## The reference shape

1. **Plan, read only.** The agent studies the task and writes a plan. It changes no file except the plan.
2. **Plan check by the person.** They read the plan, ask, correct it and accept it. A wrong plan is the most
   expensive mistake, so this is the place for the person's time.
3. **Implement.** The agent does the work alone, without questions. What it was unsure about it decides,
   and writes down in the report.
4. **Feedback loop.** Checks of its own result: build, type check, lint, tests, an independent review. A
   failed check sends the agent back to the step that can fix it, with the reason, and the person is not
   asked. Only a step that keeps failing (`max_consecutive_failures` or `max_attempts`, whichever is reached first) pauses the run
   for the person.
5. **Report.** The agent writes what the person reads at the next step (below).
6. **Result check by the person.** They accept the result, or send it back with what is wrong.
7. **Final steps.** What follows acceptance and needs no thought, for example a commit or a pull request.
   A task tied to the run is moved to done by the engine when the run completes (unless the project's
   config says otherwise); no step does it.

In a pipeline file the plan is an `agent` node whose `diff` check (`mode: changed_only`) lets only the plan
file change; the person's checks are `human` nodes (a rejection goes back to the step that fixes it); the
feedback loop is `command` nodes and a `result` check on an `agent` node whose failure label leads back to
`impl`. The report is the message the agent writes to the person at the `human` node of the result check.
The engine has the agent write there the question, a summary of the run, the node's `instructions` in the
agent's own words, and how to decide; so the order of the report is asked for in `instructions`, as in the
examples (docs:examples), and the summary leads with what matters.
The final steps are `command` or `agent` nodes after the last `human` node: give the `approved` label an
edge to them (without an edge the run ends there), and every `command` node there an edge for `failed`.

## The report

The person has little time. The report is complete but ordered by what they must know (a summary the
person can stop reading after the first lines):

- First: what was done in a few lines, what is risky, what needs their decision.
- Then: the problems met and what was decided about each, and why.
- Then: the checks that ran and their result; what was not checked.
- Last: details (files, commands), to be read only in doubt.

Put the report where the person looks: in the message at the step that waits for them, with the path of any
file. A report that makes them open five files to learn what changed has failed.

## Attention budget

- Few questions, all at the two checks. Anything the agent can decide and explain, it decides.
- Wait for the person only at `human` nodes. Never end a step by asking something in the middle of it.
- Make the plan answer what the agent would have asked: assumptions, open questions with a recommendation
  and a default, so a person who does not answer still gets the default.
- Checks that can be run by a command are `command` nodes, not questions.

## Better quality, at a price

Offer these when the person wants a more reliable result, and say what each costs:

- **A stronger model for the review.** More tokens, slower; fewer mistakes the author did not see. The
  model is a setting of the agent or its client, not a field of the pipeline: do not invent one. Ask for
  it in the review's `prompt` ("on the most capable model you can choose") and tell the person to set it.
- **More reviews from different sides.** A security review, or a review from the point of view of each business
  role that the change touches. Each is one more step, or one more role in the review, with its own text.
- **Decompose the work.** For example write the tests apart from the main change, by another step with a
  fresh context (`fresh_context: true`), so the tests do not copy the code's mistakes. Then say in the prompt of `impl`
  that it does not write tests, and enforce it with a `diff` check of `mode: unchanged` on `test/**` in
  `impl`; the tests step has its own `diff` check on `test/**`. Without that check the split is only asked for.
  Give `impl` an `outcomes` label (say `tests_wrong`) with an edge to the tests step, and tell it in its prompt to
  finish with that label when a failing test is the test's fault, or such a run loops until it pauses.
- **A tighter limit.** A lower `max_lines` on `impl` stops a large change and sends the step back (tests
  count too); a task that really needs more loops until it pauses, so set it from the usual change.

The opposite, for a faster and cheaper pipeline: fewer steps (`lean`), no `test` step, a lower
`max_attempts` or `max_consecutive_failures` (the second may not exceed the first). Say what is given up.

## A checklist for a pipeline that exists

Read the pipeline and answer. A "no" is a finding when the project's risk calls for the step; a pipeline
may leave one out for a stated reason (`lean` does), and then the finding is only that the reason is
missing. One question at a time:

- Is there a plan step whose `diff` check lets only the plan file change, and does a person accept it
  before any code is written?
- Can the agent finish a step without asking the person, so that the person is asked only at the checks?
- Is there a feedback loop with commands that the project really has, and does a failure go back to the step
  that fixes it without the person?
- Is a review independent of the author, in a fresh context (`fresh_context: true`)?
- Does the `instructions` of the result check ask for a report that puts what matters first?
- Does the person check the result at the end, and can they send it back with a reason?
- If the project has final steps (commit, pull request), are they automatic and after the person's acceptance?
- Does every `human` node earn its place, given the risk of the change?
- Do the limits (`max_lines`, `max_attempts`, `timeout`) fit the size of the usual change?
