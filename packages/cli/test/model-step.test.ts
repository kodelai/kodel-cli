/**
 * A step that asked for a model (T-43), at the surfaces of the CLI: the line in `kodel report`, the agent's
 * own word about a model through a real MCP call, and what the history tools show.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import type { ModelMarksReport } from "@kodel-ai/pipeline-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { modelLines } from "../src/format";
import { createServer } from "../src/mcp-server";

const plain = (text: string) => text;

describe("t43 the line in the report", () => {
  test("t43_report_line_for_each_result", () => {
    const report: ModelMarksReport = {
      marks: [
        {
          node: "a",
          attempt: 1,
          requested: "sonnet",
          seen: ["claude-sonnet-5-5"],
          result: "match",
          by: "subagent",
        },
        {
          node: "b",
          attempt: 1,
          requested: "sonnet",
          seen: ["claude-opus-4-8"],
          result: "mismatch",
        },
        {
          node: "c",
          attempt: 2,
          requested: "opus",
          seen: [],
          result: "not_observed",
          reason: "usage_missing",
        },
      ],
    };
    expect(modelLines(report, plain)).toEqual([
      "models asked for (information only):",
      "  a #1: model sonnet requested, seen claude-sonnet-5-5 (match, by subagent)",
      "  b #1: model sonnet requested, seen claude-opus-4-8 (mismatch)",
      "  c #2: model opus requested, seen none (not observed (no clean record of use for this attempt))",
    ]);
  });

  test("t43_report_line_says_when_a_kept_copy_was_unreadable", () => {
    const lines = modelLines({ marks: [], no_snapshot: true }, plain);
    expect(lines.join("\n")).toContain("a kept copy of the pipeline could not be read");
  });

  test("t43_no_line_without_model_steps", () => {
    expect(modelLines(undefined, plain)).toEqual([]);
  });

  test("t43_report_line_goes_through_the_text_filter", () => {
    const report: ModelMarksReport = {
      marks: [{ node: "a", attempt: 1, requested: "so\u001bnnet", seen: [], result: "mismatch" }],
    };
    const filtered = (text: string) => text.replaceAll("\u001b", "?");
    expect(modelLines(report, filtered).join("\n")).toContain("so?nnet");
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cli-model-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(dir, ".kodel", "pipelines"), { recursive: true });
  await writeFile(
    join(dir, ".kodel", "pipelines", "one.yaml"),
    "name: one\nnodes:\n  - { slug: a, kind: agent, prompt: do a, model: sonnet }\nedges: []\n",
  );
  await writeFile(join(dir, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const textOf = (result: unknown): string =>
  ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

async function connected() {
  const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0, environment: {} });
  const server = createServer(host, "1.0.0");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { host, client, close: () => Promise.all([client.close(), server.close()]) };
}

/** Every file under a directory, joined, so that a word can be looked for in all of them. */
async function allText(root: string): Promise<string> {
  let out = "";
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await stat(path)).size > 5_000_000) continue;
    out += `\n${await readFile(path, "utf8")}`;
  }
  return out;
}

describe("t43 what the agent says", () => {
  test("t43_agent_stated_model_is_not_recorded", async () => {
    const SENTINEL = "model-sentinel-7f3a91c2";
    const { host, client, close } = await connected();
    const started = JSON.parse(
      textOf(
        await client.callTool({
          name: "pipeline_start",
          arguments: { task: "model words", pipeline: "one" },
        }),
      ),
    );
    // the raw call carries a `model` the tool does not take: it is refused cleanly or dropped, never kept
    const done = await client
      .callTool({
        name: "pipeline_complete_step",
        arguments: {
          run_id: started.run_id,
          node_slug: "a",
          attempt: 1,
          summary: "done",
          model: SENTINEL,
        },
      })
      .catch((error: unknown) => ({ content: [{ text: String(error) }] }));
    expect(textOf(done).length).toBeGreaterThan(0);
    const run = await host.open(started.run_id);
    const journal = (await run?.journal()) ?? [];
    expect(JSON.stringify(journal)).not.toContain(SENTINEL);
    expect(JSON.stringify(await run?.state())).not.toContain(SENTINEL);
    expect(JSON.stringify(await run?.report())).not.toContain(SENTINEL);
    expect(await allText(join(dir, ".kodel", "runs", started.run_id))).not.toContain(SENTINEL);
    // the model the history keeps for the host is only ever one it observed
    for (const record of journal) {
      const model = (record.executor as { model?: { source?: string } } | undefined)?.model;
      if (model !== undefined) expect(model.source).not.toBe("declared");
    }
    await close();
  });

  test("t43_history_tools_show_no_model_mark", async () => {
    const { client, close } = await connected();
    const started = JSON.parse(
      textOf(
        await client.callTool({
          name: "pipeline_start",
          arguments: { task: "history words", pipeline: "one" },
        }),
      ),
    );
    await client.callTool({
      name: "pipeline_complete_step",
      arguments: { run_id: started.run_id, node_slug: "a", attempt: 1, summary: "done" },
    });
    const details = textOf(
      await client.callTool({
        name: "history_run_details",
        arguments: { run_id: started.run_id },
      }),
    );
    expect(details).not.toContain("requested");
    expect(details).not.toContain("asked for");
    await close();
  });
});
