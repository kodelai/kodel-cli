/** Sample data for the Pipeline screen: two pipelines, a proposal and a change of a run. */
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { type PipeEntry, sortEntries, stepsOf, unifiedDiff } from "./pipelines";
import type { Session } from "./session";

const DEV_YAML = `version: 1
name: dev
description: Plan, implement and verify a change, with a human gate on the plan and on the result.
nodes:
  - slug: plan
    kind: agent
    prompt: |
      Task: {{task}}
      Explore the repository and write an implementation plan to docs/plans/{{task.slug}}.md.
      Do not change any other file.
  - slug: plan-approval
    kind: human
    prompt: "Review the plan. Approve to start implementation, or reject with a reason."
  - slug: impl
    kind: agent
    prompt: "Implement the approved plan. Keep the change small."
  - slug: verify
    kind: command
    command: "bun run typecheck && bun run lint"
    timeout: 300
  - slug: test
    kind: command
    command: "bun test"
    timeout: 900
  - slug: final-approval
    kind: human
    prompt: "Read the result. Approve to publish, or reject with what is wrong."
  - slug: publish
    kind: agent
    prompt: "Open a pull request."
edges:
  - { from: plan, to: plan-approval }
  - { from: plan-approval, to: impl, when: approved }
  - { from: plan-approval, to: plan, when: rejected }
  - { from: impl, to: verify }
  - { from: verify, to: test }
  - { from: verify, to: impl, when: failed }
  - { from: test, to: final-approval }
  - { from: test, to: impl, when: failed }
  - { from: final-approval, to: publish, when: approved }
  - { from: final-approval, to: impl, when: rejected }
`;

/** The same pipeline with a lint step before the tests: what the agent proposes for a run. */
const DEV_WITH_LINT_YAML = DEV_YAML.replace(
  "  - slug: test\n",
  `  - slug: lint
    kind: command
    command: "bun run lint packages/ tests/"
    timeout: 300
  - slug: test\n`,
).replace(
  "  - { from: verify, to: test }\n",
  "  - { from: verify, to: lint }\n  - { from: lint, to: test }\n  - { from: lint, to: impl, when: failed }\n",
);

const DOCS_YAML = `version: 1
name: docs
description: Write or fix a page of the documentation.
nodes:
  - slug: write
    kind: agent
    prompt: "Task: {{task}}. Change only files under docs/."
  - slug: links
    kind: command
    command: "bun run docs:links"
  - slug: read-through
    kind: human
    prompt: "Read the page. Approve if it is correct and clear."
edges:
  - { from: write, to: links }
  - { from: links, to: write, when: failed }
  - { from: links, to: read-through }
  - { from: read-through, to: write, when: rejected }
`;

const RELEASE_YAML = `version: 1
name: release
description: Cut a release from main.
nodes:
  - slug: prepare
    kind: agent
    prompt: "Update the changelog and the version. Do not tag."
  - slug: checks
    kind: command
    command: "bun run typecheck && bun test && bun run build"
    timeout: 900
  - slug: approve-release
    kind: human
    prompt: "Read the changelog. Approve to tag and publish."
  - slug: tag
    kind: command
    command: "./scripts/tag-release.sh"
edges:
  - { from: prepare, to: checks }
  - { from: checks, to: prepare, when: failed }
  - { from: checks, to: approve-release }
  - { from: approve-release, to: tag, when: approved }
  - { from: approve-release, to: prepare, when: rejected }
  - { from: tag, to: approve-release, when: failed }
`;

export function demoPipelines(sessions: Session[]): PipeEntry[] {
  const dev = parsePipeline(DEV_YAML);
  const docs = parsePipeline(DOCS_YAML);
  const withLint = parsePipeline(DEV_WITH_LINT_YAML);
  const release = parsePipeline(RELEASE_YAML);
  const editing = sessions.find((s) => s.need === "pipeline_edit");
  const entries: PipeEntry[] = [
    {
      id: "pipeline:dev",
      group: "pipeline",
      name: "dev",
      ...(dev.description === undefined ? {} : { description: dev.description }),
      steps: stepsOf(dev),
    },
    {
      id: "pipeline:docs",
      group: "pipeline",
      name: "docs",
      ...(docs.description === undefined ? {} : { description: docs.description }),
      steps: stepsOf(docs),
    },
    {
      id: "proposal:release",
      group: "proposal",
      name: "release",
      kind: "new",
      description: "A release pipeline: checks, a human gate, then the tag.",
      steps: stepsOf(release),
      diff: unifiedDiff("", RELEASE_YAML),
      commands: [
        { where: "checks", command: "bun run typecheck && bun test && bun run build", isNew: true },
        { where: "tag", command: "./scripts/tag-release.sh", isNew: true },
      ],
      note: ["The agent proposes a new pipeline."],
      accept: "kodel pipeline proposals apply release",
      discard: "kodel pipeline proposals discard release",
    },
  ];
  if (editing) {
    entries.push({
      id: `change:${editing.id}`,
      group: "change",
      name: `dev · ${editing.title}`,
      kind: "change",
      runId: editing.id,
      steps: stepsOf(withLint),
      diff: unifiedDiff(DEV_YAML, DEV_WITH_LINT_YAML),
      note: [
        "The agent proposes to change the pipeline of this run.",
        "A new step «lint» runs before «test». Nothing runs again.",
      ],
      accept: editing.command ?? `kodel pipeline changes apply ${editing.id}`,
      discard: `kodel pipeline changes discard ${editing.id}`,
    });
  }
  return sortEntries(entries);
}
