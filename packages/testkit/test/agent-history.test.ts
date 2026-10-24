import { afterEach, beforeEach, describe, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeCollector } from "@kodel-ai/local/history";
import {
  agentHistoryContract,
  CLAUDE_FIXTURE_SESSION,
  FAKE_DIR,
  fakeAgentCollector,
  type HistorySubject,
  installClaudeSession,
} from "../src";

const MARKER = join(".kodel", "config.yaml");

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "kodel-contract-")));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function project(name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(join(root, ".kodel"), { recursive: true });
  await writeFile(join(root, MARKER), "version: 1\n");
  return root;
}

async function claudeSubject(): Promise<HistorySubject> {
  const configDir = join(base, "claude");
  const root = await project("mine");
  const other = await project("other");
  await installClaudeSession({ configDir, cwd: root });
  const foreign = await installClaudeSession({
    configDir,
    cwd: other,
    sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
    subagents: false,
  });
  const torn = await installClaudeSession({
    configDir,
    cwd: root,
    sessionId: "99999999-0000-4000-8000-000000000009",
    subagents: false,
  });
  const plain = join(base, "plain"); // sessions of the agent, but no Kodel marker
  await mkdir(plain, { recursive: true });
  await installClaudeSession({
    configDir,
    cwd: plain,
    sessionId: "88888888-0000-4000-8000-000000000008",
    subagents: false,
  });
  const events = 17;
  await appendFile(
    torn,
    '{"type":"assistant","timestamp":"2026-10-21T10:00:09.000Z","message":{"id":"msg_T',
  );
  return {
    collector: claudeCodeCollector({ configDir }),
    projectRoot: root,
    otherProjectRoot: other,
    notAProject: plain,
    foreignRef: {
      agent: "claude-code",
      session_id: "bbbbbbbb-0000-4000-8000-000000000002",
      project_root: root,
      path: foreign,
    },
    torn: {
      ref: {
        agent: "claude-code",
        session_id: "99999999-0000-4000-8000-000000000009",
        project_root: root,
        path: torn,
      },
      events,
    },
  };
}

async function fakeSubject(version: string): Promise<HistorySubject> {
  const root = await project("mine");
  const other = await project("other");
  const dir = join(root, FAKE_DIR);
  await mkdir(dir, { recursive: true });
  await mkdir(join(other, FAKE_DIR), { recursive: true });
  const plain = join(base, "plain");
  await mkdir(join(plain, FAKE_DIR), { recursive: true });
  const body =
    version < "2"
      ? [
          { t: 1_700_000_000_000, k: "msg", text: "hello" },
          { t: 1_700_000_001_000, k: "tool", id: "t1", tool: "Shell", done: 1_700_000_003_000 },
          { t: 1_700_000_004_000, k: "use", id: "u1", total_in: 120, cached: 100, out: 30 },
          {
            t: 1_700_000_005_000,
            k: "tool",
            id: "t2",
            tool: "Shell",
            done: 1_700_000_005_500,
            ok: false,
          },
          { t: 1_700_000_006_000, k: "use", id: "u2", total_in: 10, cached: 0, out: 5 },
        ]
      : [
          { at: "2023-11-14T22:13:20.000Z", type: "message", text: "hello" },
          {
            at: "2023-11-14T22:13:21.000Z",
            type: "call",
            id: "t1",
            name: "Shell",
            ended: "2023-11-14T22:13:23.000Z",
          },
          {
            at: "2023-11-14T22:13:24.000Z",
            type: "usage",
            id: "u1",
            input: 20,
            cache_read: 100,
            output: 30,
          },
          {
            at: "2023-11-14T22:13:25.000Z",
            type: "call",
            id: "t2",
            name: "Shell",
            ended: "2023-11-14T22:13:25.500Z",
            ok: false,
          },
          { at: "2023-11-14T22:13:26.000Z", type: "usage", id: "u2", input: 10, output: 5 },
        ];
  await writeFile(join(dir, "s1.json"), JSON.stringify({ version, entries: body }));
  await writeFile(join(other, FAKE_DIR, "x.json"), JSON.stringify({ version, entries: body }));
  await writeFile(join(plain, FAKE_DIR, "s.json"), JSON.stringify({ version, entries: body }));
  return {
    collector: fakeAgentCollector(),
    projectRoot: root,
    otherProjectRoot: other,
    notAProject: plain,
    foreignRef: {
      agent: "fake-agent",
      session_id: "x",
      project_root: root,
      path: join(other, FAKE_DIR, "x.json"),
    },
  };
}

for (const [name, make] of [
  ["claude-code", claudeSubject],
  ["fake agent, version 1 shape", () => fakeSubject("1.4.0")],
  ["fake agent, version 2 shape", () => fakeSubject("2.0.0")],
] as const) {
  describe(`vh9g history collector contract: ${name}`, () => {
    for (const c of agentHistoryContract(make)) test(`vh9g_${c.name.replaceAll(" ", "_")}`, c.run);
  });
}

describe("vh9g history collector contract: the fake agent proves the interface is not Claude-shaped", () => {
  test("vh9g_the_two_shapes_of_the_fake_agent_give_the_same_facts", async () => {
    const read = async (version: string) => {
      const subject = await fakeSubject(version);
      const [ref] = await subject.collector.locate(subject.projectRoot);
      const out = [];
      for await (const e of subject.collector.read(ref as NonNullable<typeof ref>)) out.push(e);
      return out.map((e) =>
        e.kind === "usage"
          ? [e.kind, e.message_id, e.output, e.cache_read]
          : [e.kind, "id" in e ? e.id : ""],
      );
    };
    const { expect } = await import("bun:test");
    expect(await read("1.4.0")).toEqual(await read("2.0.0"));
  });

  test("vh9g_overlap_and_additive_usage_are_both_expressible", async () => {
    const { expect } = await import("bun:test");
    const semantics = async (version: string) => {
      const subject = await fakeSubject(version);
      const [ref] = await subject.collector.locate(subject.projectRoot);
      for await (const e of subject.collector.read(ref as NonNullable<typeof ref>))
        if (e.kind === "usage") return e.semantics;
    };
    expect(await semantics("1.4.0")).toBe("overlap");
    expect(await semantics("2.0.0")).toBe("additive");
    void CLAUDE_FIXTURE_SESSION;
  });
});
