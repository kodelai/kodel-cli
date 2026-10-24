# Skills

Agent-facing skills shipped with Kodel:

- `kodel-run/`: `/kodel-run [pipeline] <task>` starts a run, so the person does not have to word the request. It leaves the loop and the `waiting` rules to the server's instructions.
- `design/`: `/kodel-design [what it is for]` inspects a project and proposes a pipeline for the person to accept. It starts the method in `pipeline_docs` (`pipeline-design`) and proposes with `pipeline_propose_change`; it never writes into `.kodel/pipelines/`.
- `analyze/`: calls `kodel_analyze`, proposes a diff to the pipeline file, applies it only after approval.

`kodel init` installs the skills listed in `packages/cli/src/init/skills.ts` (`SKILLS`); `kodel-run` and `kodel-design` are shipped so far. To
ship one, put it in `skills/<name>/SKILL.md` and add it to that list: it is embedded in the build as text.
