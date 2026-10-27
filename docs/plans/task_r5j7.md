# kodel-design: improve the pipeline design dialogue (TASK-R5J7)

## TL;DR

- Text-only change in three embedded files: the `pipeline-design` topic, the `standard` and `strict` examples in
  `examples.md`, and `skills/design/SKILL.md` (its step 7 is replaced, not extended). No engine code, no stored
  format, no new tool. One run covers all five points; the new parts apply to the hand-over of a **new** pipeline only.
- Cost: small. New tests in `packages/pipeline-core/test/docs.test.ts` and `packages/cli/test` (command names are
  checked there, through `<command> --help`, as `cli.test.ts` already does). The topic stays far below 12 000 characters.
- What the critique changed: the commands tutorial now includes `wait` (the task asks for it), is scoped to `kind: new`,
  says `--reason` for a rejection and tells the agent the commands are the person's; the `standard` test no longer
  expects an `approved` edge; the command test has a stated mechanism; both final checks share one slug and prompt.
- Risk: the paid real-agent scenario (`KODEL_AGENT_TESTS=1`) is not run here; how a real agent follows the text is
  shown only by a manual run of `/kodel-design`.

## Decisions needed

1. **When the commands are explained (item 5).** Acceptance is typed by the person after the agent ended its
   turn; nothing calls the agent back. Options: (a) in the hand-over message itself, as "once the person accepts it: ...",
   next to the accept command; (b) when the person comes back. Recommendation: (a). Default: (a). The agent never
   polls or watches proposals.
2. **"On your own" mode vs. the new offers (items 3, 4).** Options: (a) the modes offer and the invitation come at
   the end of the hand-over, after `pipeline_propose_change`, never as a question before it; "ask nothing more" stays
   true; if the person answers with a description of their work, the agent proposes again (same name), it does not
   edit; (b) ask before proposing. Recommendation: (a). Default: (a).
3. **Where the words live.** `SKILL.md` may not contain `gate`, `ack`, `seal`, `resume`, `proposals apply`
   (existing test). Options: (a) the skill says "check"/"approval" and cites topic sections by heading; the
   commands live in the topic; (b) lift the ban. Recommendation: (a). Default: (a).
4. **`strict` after the change.** `standard` gets the final check, so `strict` differs by the joined `verify`/`test`
   and an independent `review`. Options: (a) accept, and say so in the topic ("`strict` mainly adds an independent
   review"); (b) give `strict` more (a plan critique, which needs a new example). Recommendation: (a). The "more
   checks" variants name only what has an example or a documented field. Default: (a).
5. **Which commands item 5 lists.** The first is how to accept: the command in `pipeline_proposal.apply`. Then:
   ask for a run with the `kodel-run` skill (in Claude Code `/kodel-run <task>`); `status`; `report`; `wait <run>`
   (stays until a run stops waiting for a person; it is also what the agent starts in the background);
   `gate <decision> <run>` with `approve` or `reject` (a rejection needs `--reason "..."`; a client with a dialog asks
   there, the command is the fallback); `resume <run>`; `ack`/`seal` in one line each ("after you changed a run's
   files by hand"). Recommendation: as listed, in one short list. Cutting `ack`/`seal` is possible if the person wants it shorter;
   default keeps them (they are in the task's spirit "basic commands" only loosely, one line each).
6. **Subtasks and follow-up.** One run for 6CSZ, B3VV, 4HRH, DHMK, DCK5; the person closes them. A follow-up task for
   the paid scenario (`tests/agents`: a stage-1 assertion on the agent's final text, the extra approve round) is
   filed with `task_create` after the person accepts the plan; this run does not change task statuses.

## Behaviour change

- When an agent designs a **new** pipeline, its hand-over message now: shows a small ASCII diagram (`->`) and one
  plain sentence per step, marking where a person is asked; proposes a `standard` pipeline that ends with a human
  check of the result as well as of the plan; gives the accept command and, as "once the person accepts it", the
  basic commands; and ends with an offer of "more checks" or "faster / cheaper" (concrete variants and their cost)
  and an invitation to describe the way of working in more detail, to find more to automate.
- A change of an existing pipeline (`kind: change`, or a run's pipeline with `run_id`) is not given these parts.
- A new `standard` pipeline has a second human check at the end. Pipelines already accepted do not change.

## Risks and invariants

- Stored data / formats: nothing stored changes; the examples are `version: 1` user-file examples using existing
  fields; the parser is unchanged; no golden fixture needed (`fixtures/formats/v1` holds old `standard` only in run snapshots).
- Principle 4: only markdown embedded as text. The command-name test is in `packages/cli/test`; core imports no CLI.
- Principle 6: the topic will name `gate`, `resume`, `ack`, `seal`, `proposals apply`, and agents read it in other
  flows too. The list is introduced by a fixed sentence, "These are the person's commands; the agent never runs
  them (only `wait` may be started by the agent, in the background)", and the text says "the person", never "you".
  A test checks that rule, with a deliberately bad sentence as a refutation.
- Principle 1: the skill's last line stays.
- `scripts/check-artifact.mjs` pins two sentences ("Build the pipeline from what the project already does" at the top
  of `pipeline-design.md`, "Complete pipelines. Replace the commands" at the top of `examples.md`): kept verbatim.
- The command prefix: `pipeline_proposal.apply` always says `kodel`, while this repository's AGENTS.md uses
  `bun packages/cli/src/main.ts`. Known and pre-existing; the topic says "the same program as the accept command".

## Acceptance criteria and tests

Test names carry `tr5j7`: the decisions above are plan-local, no decision-log id applies.

| # | criterion | test |
| --- | --- | --- |
| 1 | "Hand it over" asks, for a new pipeline only, for a diagram line (with `->`) and one description per step | `tr5j7_design_topic_asks_for_a_diagram_and_a_description_of_each_step` (core `docs.test.ts`) |
| 2 | `standard` (found by `name: standard`) and `strict` end with the same human node (same slug and prompt) with a `rejected` edge to `impl` and no `approved` edge | `tr5j7_standard_and_strict_end_with_the_same_result_check` |
| 3 | the profile table and the `strict` intro: `standard` ends with a result check; `strict` is distinguished by "independent review" and no longer by "a person's approval at the end" | `tr5j7_profile_table_matches_the_examples` |
| 4 | "After the proposal" offers "more checks" and "faster / cheaper" with the variants (`strict`, review, `max_lines`, `max_attempts`, `lean`, dropping `test`, dropping the plan check with its reason); each field exists in the generated reference, `lean` in the table; it says `strict` mainly adds an independent review | `tr5j7_design_topic_offers_more_checks_and_faster_cheaper_modes` |
| 5 | the invitation to describe the way of working is there, with "propose again" for the answer | `tr5j7_design_topic_invites_a_description_of_the_way_of_working` |
| 6 | the new parts are marked "new pipeline (`kind: new`)" and stay out of section 6; they come after the `pipeline_propose_change` instruction; "ask nothing more" is still in "On your own" | `tr5j7_modes_and_commands_belong_to_a_new_pipeline_and_come_after_the_proposal` (string positions) |
| 7 | each command named exists and the argument forms match: `<command> --help` exits 0 for `status`, `report`, `wait`, `gate`, `resume`, `ack`, `seal`; the usage of `gate` is `<decision> <run>` and the accepted values are `approve` and `reject` as the topic says; `kodel-run` is in `SKILLS` | `tr5j7_design_topic_commands_exist_in_the_cli` in `packages/cli/test/cli.test.ts`, reading the topic through `docTopics`; refutation: a topic line with a command the CLI lacks fails |
| 8 | the commands are the person's: the fixed sentence precedes the list, no line has an imperative to the agent ("run `gate`"), no "you"; a deliberately bad sentence fails the same check | `tr5j7_design_topic_says_decisions_are_the_persons` (core) |
| 9 | the skill only proposes, has no banned word, still names `pipeline-design`; every section it cites exists as a heading in the topic | existing `t2t8e_kodel_design_*` plus `tr5j7_skill_cites_headings_that_exist_without_the_banned_words` (CLI test) |
| 10 | size and validity | existing `tNN_*` docs tests; `bun run build && node scripts/check-artifact.mjs` |
| 11 | a real agent hands over with no question before the proposal, the diagram is readable, the descriptions are plain, the variants fit the project | not testable offline; **manual**: run `/kodel-design` once on a sample repository and read the hand-over; the paid scenario is **not run** and the final report says so |

Subtasks: 6CSZ = rows 1, 11; B3VV = 2, 3; 4HRH = 4; DHMK = 5; DCK5 = 7, 8.
Refutation: a failing 2 or 3 means the example or table is changed, not the test; if the 12 000 limit is hit, the new text is shortened.

---

## Steps

1. `examples.md`: `standard` gets a human node `result-approval` after `test` (prompt "Try the result. Approve if it does what was planned, or reject with a reason.", `instructions` naming the plan and the diff), edge `result-approval -> impl` on `rejected`, no `approved` edge. `strict` uses the same slug and prompt in place of its `accept`. Update the `standard` heading and `description:` and the `strict` intro ("Like `standard`, with ..."). Keep the sentinel at the top.
2. `pipeline-design.md`: update the profile table and the line in section 1 ("stricter", "no plan check", "no result check"); extend section 5 with the diagram and step descriptions; add "After the proposal" and "Once the person accepts it" after the `pipeline_propose_change` instruction, marked for a new pipeline; state that `strict` mainly adds an independent review. Keep the top sentence.
3. `skills/design/SKILL.md`: **replace** step 7 by a step that tells the person what was proposed and why, with the diagram and step descriptions, the accept command, the commands and the two offers, "as `pipeline-design` sections 'Hand it over' and 'After the proposal' say", then ends the turn. Only "check"/"approval" words; keep "never write into `.kodel/pipelines/`", "without `run_id`" and the last line.
4. Tests as in the table. Before writing the CLI test, read how `cli("wait", "--help")` is done in `cli.test.ts`.
5. `bun run typecheck && bun run lint && bun test`, `bun run build && node scripts/check-artifact.mjs`. Grep `standard` outside the three files for stale text.

## Affected files

- `packages/pipeline-core/agent-docs/pipeline-design.md`
- `packages/pipeline-core/agent-docs/examples.md`
- `skills/design/SKILL.md`
- `packages/pipeline-core/test/docs.test.ts`
- `packages/cli/test/cli.test.ts` (and `init.test.ts` for the skill test)

## Rejected review findings

- [tests, scope] Add a stage-1 `finalText` assertion to `tests/agents` now: not in this run. The judge sees only the YAML and the summary, the scenario is paid and not run here; it is a follow-up task (decision 6), and the final report says the scenario was not run. The extra approve round per fixture goes in that task.
- [scope] Plan critique as a "more checks" variant: not offered (decision 4).
- [scope] Cut `ack`/`seal`, and the prose tests (rows 1, 6): kept as a choice for the person (decision 5); rows 1 and 6 stay but are small and the plan says they prove only that the text exists.
- [invariants] Record decisions 1 and 5 in the decision log: the log is local notes outside the repository; left to the person.
- [gaps] `every_human_node_has_a_rejected_edge` test is redundant (the human handler requires routes): dropped from the plan.
- [gaps] The prefix rationale was wrong: corrected in Risks (the known mismatch is stated).
- [scope] A mapping of subtasks to rows: added under the table.

## Findings in the code

- The method is `packages/pipeline-core/agent-docs/pipeline-design.md`, embedded as topic `pipeline-design` (`packages/pipeline-core/src/docs.ts:9,110`); the skill `skills/design/SKILL.md` only starts it; shipped by `packages/cli/src/init/skills.ts`, also for Codex and OpenCode.
- `packages/cli/test/init.test.ts:328-350` bans `gate|ack|seal|resume|proposals apply` in the skill only.
- Docs tests: `packages/pipeline-core/test/docs.test.ts:60-95`; the human node handler requires routes (`registry.ts:224`).
- A node with no edge for its label ends the run (`pipeline-spec.md`); `strict`'s `accept` has only a `rejected` edge.
- CLI (`packages/cli/src/cli.ts`): `status [run]` 375, `wait <run>` 451 (no human-only guard), `gate <decision> <run>` 528 (`reject` needs `--reason` unless comments exist, 567), `resume` 595, `ack` 614, `seal` 863, `report` 843; `cli.test.ts:1289` shows `cli("wait", "--help")`.
- The accept command is `kodel pipeline proposals apply <name>` (`pipeline-host.ts:292`); for a run's pipeline it is `pipeline changes apply <run>`.
- `scripts/check-artifact.mjs:49-54` pins sentinel sentences of the topics.
- `tests/agents/design.ts`: the judge sees only the pipeline and the summary; stage 3 approves every `:human` node in up to 8 rounds.
- Stale texts: `pipeline-design.md` lines 13 and 36-38, `examples.md` lines 28, 33, 77.

## Added at the final check (the person's request)

- `skills/design/SKILL.md` step 1: if `pipeline_list` returns an error (for example `NO_PROJECT`), tell the person
  and stop; test `tr5j7_kodel_design_stops_when_pipeline_list_returns_an_error`.
- New agent topic `pipeline-quality` (`packages/pipeline-core/agent-docs/pipeline-quality.md`, registered in
  `docs.ts`, linked from `pipeline-design`): the balance of background work and the person's control, the seven-step
  reference shape, the report (what matters first), the attention budget, ways to raise quality (stronger review
  model, more reviews from different sides, decomposition) and a checklist for judging an existing pipeline.
  Tests: `tr5j7_quality_topic_*`, `tr5j7_the_design_topic_points_to_the_quality_topic`. A version for people in
  `docs/` is postponed by the person.
- Also `packages/pipeline-core/src/registry.ts`: the description of the `instructions` field of a `human` node
  now says it may tell what the agent's message holds and in which order (a text of the generated reference,
  not engine logic); tested in `tr5j7_quality_topic_has_the_reference_shape_the_report_and_the_checklist`.
- Rejected review finding: "TELL_AT_GATE puts the prompt and a short summary before the instructions, so the report
  order is not guaranteed". The engine text is a server text outside this task and stays as it is; the topic now says
  what the engine has the agent write and that the order of the report is asked for in `instructions`, the way
  this repository's own `dev.yaml` does. A change of the gate text is a follow-up if the person wants a stronger
  guarantee. Likewise a worked example of final steps after the last human node is left to a follow-up.

## Added at the second final check (the person's request)

- An empty or unclear project (no manifest, CI, tests or linter) never gets `lean`: it gets the new `minimal` example,
  plan, a plan check by a person, implement, a result check by a person, with no command steps. In the "on your
  own" mode nothing is asked and the assumption is stated first; in the "together" mode one question is asked and the
  form is offered as the default. `lean` stays for projects that have commands to verify with.
  Tests: `tr5j7_minimal_example_*`, `tr5j7_an_empty_project_gets_the_minimal_form_and_the_two_modes_differ`.
- `pipeline-quality`: the decomposition option names the `outcomes` label back to the tests step, and the two limits
  are "whichever is reached first". Test: `tr5j7_decomposition_names_the_way_back_to_the_tests_step`.

## Added at the third final check (the person's request)

- The hand-over says where the pipeline is (`kodel pipeline proposals show <name>`, then
  `.kodel/pipelines/<name>.yaml` in the project root) and that the accept command is run in the project root.
- "Once the person accepts it" lists only `/kodel-run <task>` (with what happens after the start) and `status`
  (no id lists the runs, with an id shows one); `wait`, `report`, `gate`, `resume`, `ack` and `seal` are no longer
  listed, the agent gives a command when one is needed. Test: `tr5j7_design_topic_says_decisions_are_the_persons`
  and `tr5j7_design_topic_commands_exist_in_the_cli`.
- The "stricter" offer is more checks the project already has plus more reviews by subagents; `max_lines` and
  `max_attempts` are no longer offered in the hand-over (they stay in `pipeline-quality` as details).
  Test: `tr5j7_design_topic_offers_stricter_and_faster_cheaper_modes`.
- The remaining minors: section 1 says `minimal` keeps both checks, the reasons for the excluded offers are given
  per offer, skill step 7 is conditional for `minimal`, and a test asserts the `mode: unchanged` check of `impl`.
- Twelfth review: "Once the person accepts it" describes the flow of the pipeline that was proposed (`lean` stops nowhere),
  says the engine, not the agent, runs and judges the checks, gives `kodel status` with the program name, and the
  `minimal` rule and example say the `diff` checks need a git work tree (`git init` first). The command test also
  checks `kodel pipeline proposals show <name>` against the CLI.
