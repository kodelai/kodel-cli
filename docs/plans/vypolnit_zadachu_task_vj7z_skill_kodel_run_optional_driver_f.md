# TASK-VJ7Z: skill `kodel-run`, a launcher for "run pipeline X for task Y"

## Goal

A developer starts a pipeline with one short command and does not have to think about how to word the
request to the agent:

    /kodel-run <task>                 # the project has one pipeline, or the agent asks which
    /kodel-run <pipeline> <task>      # the first word names an existing pipeline

The skill is a thin wrapper over the request. It is not a second copy of the loop rules: those
already travel with the server (`SERVER_INSTRUCTIONS` in `packages/pipeline-core/src/mcp/tools.ts`)
and work only after the request has been phrased, which is exactly what the skill takes off the
developer. The skill therefore says what to ask for and points at the server's rules for the rest.

The task text suggested checking first whether the skill is needed. Result: it is, as a launcher. The
earlier reading (a rules file for agents that ignore MCP instructions) was wrong and is dropped; an
agent that ignores the instructions is a separate matter, to be shown by a real-agent scenario first.

## Behaviour of the skill

`skills/kodel-run/SKILL.md` tells the agent, in this order:

1. Take the text after the skill name as the arguments. If it is empty, ask the person what the task
   is and stop; never invent a task.
2. Call `pipeline_list`. If the first word of the arguments is the name of a listed pipeline, that is
   the pipeline and the rest is the task. Otherwise the whole text is the task: with one pipeline
   use it, with several ask the person which, and wait.
3. Call `pipeline_start` with `task` = the task in the person's own words (not rephrased),
   `pipeline`, `cwd` = the directory the agent works in, and `title` = English, 2-5 words, kebab-case.
4. From here follow the server's instructions (loop, `waiting`, `workdir`, `choice` answers, a run that
   is already `terminal`). The skill repeats none of them beyond one line saying so, so there is a
   single source and the two cannot disagree. In particular `restart: true` is only for when the
   person asks to run it again.

Pipeline names, task and title are data the agent passes to a tool; the skill never builds a shell
command from them.

## Affected files

- `skills/kodel-run/SKILL.md` (new): frontmatter (`name: kodel-run`, a `description` that says when to
  use it, an argument hint `[pipeline] <task>`) and the four steps above. Written in English.
- `packages/cli/src/init/skills.ts`: import the file with `with { type: "text" }` and put it in `SKILLS`
  as `{ name: "kodel-run", text }` (the pattern in the file's own comment). `name` equals the directory
  name and the frontmatter `name`.
- `skills/README.md`: list `kodel-run/`, and fix the sentence "no skill is shipped yet".
- `adapters/README.md`: a line that the launcher is installed for every agent through its `skillsDir`
  (`.claude/skills`, `.agents/skills`, `.opencode/skills`).
- `packages/cli/test/init.test.ts`: the test `expect(SKILLS).toEqual([])` (line ~280) is replaced, see below.
- `README.md` / `docs/`: no change now (English docs are written after the first working version).

No engine change, no new dependency, no new MCP tool and no change to stored formats.

## Steps

1. Write `skills/kodel-run/SKILL.md`.
2. Register it in `SKILLS` (`packages/cli/src/init/skills.ts`).
3. Update the tests (below) and the two README files.
4. Check the build embeds the text and the artifact runs on plain Node:
   `bun run build && node scripts/check-artifact.mjs`. There is no `with { type: "text" }` import in
   the code yet, so this is the first one; if `bun build --target node` or the typecheck refuses a
   `.md` import (a `declare module "*.md"` may be needed), fix it in `packages/cli`, not by reading the
   file at run time, because the artifact is a single JS file.
5. `bun run typecheck && bun run lint && bun test`.

## Test strategy

In `packages/cli/test/init.test.ts` (names carry the task id, as the file's style allows):

- `vj7z_kodel_run_is_shipped`: `SKILLS` contains exactly `kodel-run`; its `text` starts with a
  frontmatter whose `name` is `kodel-run` and which has a non-empty `description`.
- `vj7z_kodel_run_names_the_tools_that_exist`: every `pipeline_*` tool named in the skill text is in the
  tool list of `@kodel-ai/pipeline-core/mcp`, and the skill names `pipeline_list` and `pipeline_start`.
  This is what catches a rename of a tool that the skill would otherwise keep using.
- `vj7z_kodel_run_does_not_copy_the_rules`: the skill text contains none of the forbidden commands
  (`gate`, `ack`, `seal`, `resume`) as instructions and refers to the server's instructions for the
  loop. Cheap guard against the skill growing into a second rule set.
- `vj7z_init_installs_kodel_run_for_every_agent`: `kodel init --yes` for all three agents creates
  `.claude/skills/kodel-run/SKILL.md`, `.agents/skills/kodel-run/SKILL.md` and
  `.opencode/skills/kodel-run/SKILL.md`; a second run reports `unchanged`; an edited copy is kept
  without `--force` (the existing `installSkills` tests already cover the mechanism with a fake skill).
- Build: `scripts/check-artifact.mjs` still passes, and a built `kodel init` in a temp directory
  writes the same skill text (the text really is embedded).

Real-agent scenarios in `tests/agents/claude-code-run-skill.test.ts` (run with `KODEL_AGENT_TESTS=1`,
skipped otherwise, like the other scenarios there). The skill is installed from the shipped text and
the project says nothing about pipelines:

- `/kodel-run <task>` with one pipeline: the agent calls `pipeline_list`, then `pipeline_start` with that
  pipeline, the task as written, a valid kebab-case `title` and the sandbox as `cwd`.
- `/kodel-run <pipeline> <task>` with two pipelines: the first word is taken as the pipeline and is not
  part of the task.
- `/kodel-run <task>` with two pipelines and none named: no run is started, the agent asks which.
- `/kodel-run` with no text: no run is started, the agent asks for the task.

Checked on the real agents (the third run, by hand, not a test: there is no harness for them):
Codex discovers the skill (`$kodel-run`) and calls `pipeline_list` and `pipeline_start` with the right
arguments, but `codex exec` refuses the call under its approval policy; OpenCode loads the skill but did
not connect the `kodel` server in the environment tried. Both adapters stay `verified: false`.

## Risks

- **How the arguments reach the skill differs per agent.** Claude Code passes them as the text after
  `/kodel-run`; Codex and OpenCode may invoke a skill by name from a sentence. The skill therefore says
  "the text the person gave after the skill name, or in the same message" and does not rely on a
  placeholder syntax of one agent.
- **A pipeline whose name is the first word of the task** ("fix login") would be read as a pipeline.
  Only an exact name from `pipeline_list` counts; a task that starts with such a word can be
  written after the name explicitly. Accepted, and noted in the skill.
- **A second place for guidance.** Mitigated by the skill not repeating the loop and by the
  tool-name test above.
- **First `type: "text"` import** may need build or typecheck configuration (step 4).
- **Nobody has run it on Codex or OpenCode.** The skill is plain markdown in their documented
  directories; whether they list and invoke it is unverified, as the rest of those adapters.
