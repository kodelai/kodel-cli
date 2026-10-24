---
name: kodel-run
description: Start a Kodel pipeline for a task, for example "/kodel-run fix the login timeout" or "/kodel-run dev add a --json flag". Use when the person wants a change done through the project's pipeline.
argument-hint: "[pipeline] <task>"
---

# Run a pipeline

The person wants a task done through a Kodel pipeline. Do these steps in order and use only the
`pipeline_*` tools of the `kodel` MCP server.

1. The task is the text the person gave after the skill name, or in the same message. If there is
   none, ask what the task is and stop. Never make a task up.
2. Call `pipeline_list`. If it lists no pipelines, tell the person and stop. If the first word of the
   text is exactly the name of a listed pipeline, that is the pipeline and the rest is the task; to
   use a task that begins with such a word, the person names the pipeline first. Otherwise the whole text is the task: with one pipeline use it, with
   several ask which one and wait for the answer.
3. Call `pipeline_start` with:
   - `task`: the task in the person's own words, not rephrased;
   - `pipeline`: the pipeline from step 2;
   - `cwd`: the absolute path of the directory you are working in;
   - `title`: English, 2-5 words, kebab-case, for example `fix-login-timeout`.
4. From here on follow the instructions the server sent when it connected: they cover the loop, a
   `waiting` answer, a `workdir`, a `choice` and a run that is already finished. Pass `restart: true`
   only if the person asks to run the task again.
