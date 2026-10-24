# Skills

Agent-facing skills shipped with Kodel:

- `kodel-run/`: `/kodel-run [pipeline] <task>` starts a run, so the person does not have to word the request. It leaves the loop and the `waiting` rules to the server's instructions.
- `design/`: inspects a project and proposes a pipeline for the user to approve.
- `analyze/`: calls `kodel_analyze`, proposes a diff to the pipeline file, applies it only after approval.

`kodel init` installs the skills listed in `packages/cli/src/init/skills.ts` (`SKILLS`); only `kodel-run` is shipped so far. To
ship one, put it in `skills/<name>/SKILL.md` and add it to that list: it is embedded in the build as text.
