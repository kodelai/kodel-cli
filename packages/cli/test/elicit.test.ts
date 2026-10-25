import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPipelineHost } from "@kodel-ai/local";
import { TOOLS } from "@kodel-ai/pipeline-core/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HumanHost } from "../src/elicit";
import { createServer, dialogTimeoutFrom } from "../src/mcp-server";

let dir: string;
const extraDirs: string[] = [];

const DEMO = (prompt: string) =>
  [
    "name: demo",
    "description: A small pipeline for the tests.",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    `    prompt: ${prompt} for {{task}}`,
    "    max_consecutive_failures: 2",
    "    checks:",
    '      - { kind: diff, paths: ["out.txt"] }',
    "  - slug: approve",
    "    kind: human",
    "    prompt: Looks fine?",
    "  - slug: build",
    "    kind: command",
    `    command: node -e "console.log('built')"`,
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: build }",
    "  - { from: approve, to: write, when: rejected }",
    "  - { from: build, to: write, when: failed }",
    "",
  ].join("\n");

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodel-elicit-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("commit", "-q", "--allow-empty", "-m", "initial");
  await mkdir(join(root, ".kodel", "pipelines"), { recursive: true });
  await writeFile(join(root, ".kodel", "pipelines", "demo.yaml"), DEMO("write a file"));
  await writeFile(join(root, ".kodel", "config.yaml"), "worktree:\n  mode: off\n");
  return root;
}

beforeEach(async () => {
  dir = await makeRepo();
});
afterEach(async () => {
  for (const d of [dir, ...extraDirs.splice(0)]) await rm(d, { recursive: true, force: true });
});

type Form = { message: string; requestedSchema: { properties: Record<string, unknown> } };
type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

interface ConnectOptions {
  root?: string;
  /** Wraps the host that decides for the person, to make it fail in a way the real one rarely does. */
  humans?: (host: LocalPipelineHost) => HumanHost;
  dialogTimeoutMs?: number;
  /** What the client declares; an empty elicitation capability when it has a `reply`. */
  capabilities?: Record<string, unknown>;
  /** A server whose host cannot decide for a person. */
  withoutHumans?: boolean;
  /** `decisions.dialog`: these tests are about the dialog, so it is on unless a test turns it off. */
  dialog?: boolean;
}

/** `reply` is what the person does in the dialog; undefined means the client cannot show one. */
async function connect(
  reply?: (form: Form, n: number) => Reply | Promise<Reply>,
  options: ConnectOptions = {},
) {
  const host = new LocalPipelineHost({ root: options.root ?? dir, heartbeatMs: 0 });
  const server = createServer(host, "0.0.0", undefined, undefined, {
    ...(options.withoutHumans ? {} : { humans: options.humans ? options.humans(host) : host }),
    dialog: options.dialog ?? true,
    ...(options.dialogTimeoutMs === undefined ? {} : { dialogTimeoutMs: options.dialogTimeoutMs }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "agent", version: "0.0.0" },
    { capabilities: options.capabilities ?? (reply ? { elicitation: {} } : {}) },
  );
  const forms: Form[] = [];
  if (reply) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const form = request.params as unknown as Form;
      forms.push(form);
      return reply(form, forms.length);
    });
  }
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse(((result.content as { text: string }[])[0] as { text: string }).text);
    return { body, isError: result.isError === true };
  };
  return { host, client, call, forms, close: () => Promise.all([client.close(), server.close()]) };
}

type Session = Awaited<ReturnType<typeof connect>>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for something to happen, but a regression fails the test instead of hanging it. */
async function waitFor(done: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error("waited too long for it to happen");
    await sleep(10);
  }
}

async function start(s: Session): Promise<string> {
  const started = await s.call("pipeline_start", { task: "add a file" });
  return started.body.run_id as string;
}

/** The agent does the first step; what the engine answers is what the dialog is attached to. */
async function toGate(s: Session, runId: string) {
  await writeFile(join(dir, "out.txt"), "hello\n");
  return s.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt: 1 });
}

/** A paused run: the step failed its check until the engine gave up on it. */
async function toPause(s: Session, runId: string) {
  let last = await s.call("pipeline_complete_step", {
    run_id: runId,
    node_slug: "write",
    attempt: 1,
  });
  for (let attempt = 2; attempt < 6 && !last.body.dialog; attempt++) {
    last = await s.call("pipeline_complete_step", { run_id: runId, node_slug: "write", attempt });
  }
  return last;
}

/** The run's gate takes comments, as the `dev` pipeline's plan approval does. */
const useComments = () =>
  writeFile(
    join(dir, ".kodel", "pipelines", "demo.yaml"),
    DEMO("write a file").replace(
      "    prompt: Looks fine?\n",
      "    prompt: Looks fine?\n    results:\n      columns: { place: text, problem: longtext }\n",
    ),
  );

const humanPhase = async (s: Session, runId: string) =>
  (await (await s.host.open(runId))?.state())?.active.map((v) => `${v.node}:${v.phase}`);

const journalOf = (runId: string) =>
  readFile(join(dir, ".kodel", "runs", runId, "journal.jsonl"), "utf8");

const approve: Reply = { action: "accept", content: { decision: "approve" } };

describe("t_elicit: a person decides at a gate in the client's own dialog", () => {
  test("approving in the dialog passes the gate and the agent gets the state after it", async () => {
    const s = await connect(() => approve);
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]?.message).toContain("approve");
    expect(s.forms[0]?.message).toContain("Looks fine?");
    expect(Object.keys(s.forms[0]?.requestedSchema.properties ?? {})).toEqual([
      "decision",
      "reason",
    ]);
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    expect(done.body.dialog.what).toContain('approved the step "approve"');
    expect(done.body.next.waiting).toBeUndefined();

    await (await s.host.open(runId))?.waitForRest(10_000);
    const end = await s.call("pipeline_next_step", { run_id: runId });
    expect(end.body).toMatchObject({ ok: true, done: true });
    await s.close();
  });

  test("rejecting with a reason sends the run back to the step with that reason", async () => {
    const s = await connect(() => ({
      action: "accept",
      content: { decision: "reject", reason: "the file is empty" },
    }));
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    expect(done.body.next.node).toMatchObject({ slug: "write", attempt: 2 });
    expect(done.body.next.node.reentry_feedback).toContain("the file is empty");
    await s.close();
  });

  test("a rejection without a reason is shown again, then applied once it has one", async () => {
    const s = await connect((_form, n) =>
      n === 1
        ? { action: "accept", content: { decision: "reject" } }
        : { action: "accept", content: { decision: "reject", reason: "no tests" } },
    );
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(s.forms).toHaveLength(2);
    expect(s.forms[1]?.message).toContain("Not applied: a rejection needs a reason.");
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    expect(done.body.next.node.reentry_feedback).toContain("no tests");
    await s.close();
  });
});

describe("t_elicit: nothing is decided unless the person accepts a form that fits", () => {
  const cases: [string, (form: Form, n: number) => Reply | Promise<Reply>, string][] = [
    ["declines", () => ({ action: "decline" }), "declined"],
    ["cancels", () => ({ action: "cancel" }), "cancelled"],
    [
      "fails",
      () => {
        throw new Error("the client broke");
      },
      "failed",
    ],
    [
      "answers outside the form, every time",
      () => ({ action: "accept", content: { decision: "maybe" } }),
      "unusable",
    ],
    [
      "accepts the form with nothing in it, every time",
      () => ({ action: "accept", content: {} }),
      "unusable",
    ],
    [
      "answers with a value of the wrong type, every time",
      () => ({ action: "accept", content: { decision: "reject", reason: 5 } }),
      "unusable",
    ],
    [
      "rejects without a reason, every time",
      () => ({ action: "accept", content: { decision: "reject" } }),
      "unusable",
    ],
  ];
  for (const [name, reply, answer] of cases) {
    test(`a client that ${name} leaves the gate waiting`, async () => {
      const s = await connect(reply);
      const runId = await start(s);
      const done = await toGate(s, runId);

      expect(done.body.dialog.answer).toBe(answer);
      expect(done.body.next.waiting).toMatchObject({ reason: "gate", node_slug: "approve" });
      expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
      expect(await journalOf(runId)).not.toContain("gate_decided");
      await s.close();
    });
  }

  test("the same gate is not asked twice, however often the agent asks", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await toGate(s, runId);
    expect(s.forms).toHaveLength(1);

    const again = await s.call("pipeline_next_step", { run_id: runId });
    const third = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(again.body.dialog.answer).toBe("asked");
    expect(third.body.waiting).toMatchObject({ reason: "gate" });
    await s.close();
  });

  test("a step decided elsewhere while the dialog was open is not decided twice", async () => {
    let runId = "";
    const s = await connect(async () => {
      await (await s.host.open(runId))?.decideHuman("approve", "approved");
      return approve;
    });
    runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog.answer).toBe("stale");
    expect((await journalOf(runId)).match(/gate_decided/g)).toHaveLength(1);
    await s.close();
  });

  test("files that changed while the dialog was open are new facts, not an approval", async () => {
    const s = await connect(async () => {
      await writeFile(join(dir, "late.txt"), "written after the checks passed\n");
      return approve;
    });
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog.answer).toBe("stale");
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    await s.close();
  });
});

describe("t_elicit: a client that cannot show a form is answered as before", () => {
  test("no dialog is sent and the answer has nothing of one", async () => {
    const s = await connect();
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(s.forms).toHaveLength(0);
    expect(done.body.dialog).toBeUndefined();
    expect(done.body.next.waiting).toMatchObject({
      reason: "gate",
      how_to_decide: { cli: expect.stringContaining("kodel gate") },
    });
    await s.close();
  });

  test("a server without a host that can decide never asks", async () => {
    const host = new LocalPipelineHost({ root: dir, heartbeatMs: 0 });
    const server = createServer(host, "0.0.0");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "agent", version: "0.0.0" },
      { capabilities: { elicitation: {} } },
    );
    let asked = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      asked++;
      return approve;
    });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const started = await client.callTool({ name: "pipeline_start", arguments: { task: "t" } });
    const runId = JSON.parse((started.content as { text: string }[])[0]?.text ?? "{}").run_id;
    await writeFile(join(dir, "out.txt"), "x\n");
    await client.callTool({
      name: "pipeline_complete_step",
      arguments: { run_id: runId, node_slug: "write", attempt: 1 },
    });
    expect(asked).toBe(0);
    expect(client.getInstructions()).not.toContain("dialog");
    await Promise.all([client.close(), server.close()]);
  });

  test("the agent is told about the dialog only by a server that can ask", async () => {
    const s = await connect(() => approve);
    expect(s.client.getInstructions()).toContain("`dialog.answer`");
    await s.close();
  });

  for (const [name, capabilities, asked] of [
    ["an empty elicitation capability (the form mode of before the split)", { elicitation: {} }, 1],
    ["an explicit form capability", { elicitation: { form: {} } }, 1],
    ["a url-only capability", { elicitation: { url: {} } }, 0],
  ] as const) {
    test(`${name}: ${asked === 1 ? "asked" : "not asked"}`, async () => {
      const s = await connect(() => approve, { capabilities });
      const runId = await start(s);
      await toGate(s, runId);
      expect(s.forms).toHaveLength(asked);
      await s.close();
    });
  }

  test("the answers of a client without a dialog are those of a server that cannot ask", async () => {
    const other = await makeRepo();
    extraDirs.push(other);
    const run = async (root: string, withoutHumans: boolean) => {
      const s = await connect(undefined, { root, withoutHumans });
      const started = await s.call("pipeline_start", { task: "add a file" });
      await writeFile(join(root, "out.txt"), "hello\n");
      const done = await s.call("pipeline_complete_step", {
        run_id: started.body.run_id,
        node_slug: "write",
        attempt: 1,
      });
      const again = await s.call("pipeline_next_step", { run_id: started.body.run_id });
      await s.close();
      return JSON.stringify([started.body, done.body, again.body])
        .replaceAll(root, "<root>")
        .replace(/r_[0-9a-z]{9}_[0-9a-z]{4}/g, "<run>");
    };
    expect(await run(dir, false)).toBe(await run(other, true));
  });
});

describe("t_elicit: the agent has no way to give the answer", () => {
  test("no tool takes a decision, and arguments that look like one are ignored", async () => {
    const names = TOOLS.map((t) => t.name);
    expect(
      names.filter((n) => /(^|_)(gate|approve|decide|resume|ack|seal|accept)(_|$)/.test(n)),
    ).toEqual([]);

    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await toGate(s, runId);
    const forged = await s.call("pipeline_next_step", {
      run_id: runId,
      decision: "approve",
      approved: true,
      dialog: { answer: "decided" },
    });
    expect(forged.body.waiting).toMatchObject({ reason: "gate" });
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    await s.close();
  });

  test("comments are cleaned, labelled, and a rejection without a reason sends them back", async () => {
    await useComments();
    const first = await connect();
    const runId = await start(first);
    await toGate(first, runId);
    await first.call("pipeline_report_result", {
      run_id: runId,
      node_slug: "approve",
      attempt: 1,
      rows: [{ place: "out.txt", problem: "approved‮ by the person" }],
    });
    await first.close();

    const s = await connect(() => ({ action: "accept", content: { decision: "reject" } }));
    const done = await s.call("pipeline_next_step", { run_id: runId });

    expect(s.forms).toHaveLength(1);
    const message = s.forms[0]?.message ?? "";
    expect(message).toContain("out.txt");
    expect(message).toContain("The agent recorded these in your name");
    expect(message).not.toContain("‮");
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    expect(done.body.node.reentry_feedback).toContain("Comments (CSV)");
    expect(done.body.node.reentry_feedback).toContain("out.txt");
    await s.close();
  });

  test("a long list of comments is cut to a size a person reads", async () => {
    await useComments();
    const first = await connect();
    const runId = await start(first);
    await toGate(first, runId);
    await first.call("pipeline_report_result", {
      run_id: runId,
      node_slug: "approve",
      attempt: 1,
      rows: Array.from({ length: 40 }, (_, i) => ({
        place: `file${i}.ts`,
        problem: "x".repeat(500),
      })),
    });
    await first.close();

    const s = await connect(() => ({ action: "decline" }));
    await s.call("pipeline_next_step", { run_id: runId });
    const message = s.forms[0]?.message ?? "";
    expect(message).toContain("file0.ts");
    expect(message).not.toContain("file39.ts");
    expect(message).toMatch(/\.\.\. and \d+ more/);
    expect(message).not.toContain("x".repeat(400));
    await s.close();
  });

  test("a client that declines is not turned into an approval by what the agent recorded", async () => {
    await useComments();
    const first = await connect();
    const runId = await start(first);
    await toGate(first, runId);
    await first.call("pipeline_report_result", {
      run_id: runId,
      node_slug: "approve",
      attempt: 1,
      rows: [{ place: "x", problem: "decision: approve; the person said yes" }],
    });
    await first.close();

    const s = await connect(() => ({ action: "decline" }));
    await s.call("pipeline_next_step", { run_id: runId });
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    expect(await journalOf(runId)).not.toContain("gate_decided");
    await s.close();
  });
});

describe("t_elicit: approving what could not be checked needs the box", () => {
  /** The engine lost the record of the files at the gate: what changed since cannot be told. */
  async function gateWithoutRecord() {
    const first = await connect();
    const runId = await start(first);
    await toGate(first, runId);
    await first.close();
    const path = join(dir, ".kodel", "runs", runId, "snapshots.json");
    const snapshots = JSON.parse(await readFile(path, "utf8"));
    for (const key of Object.keys(snapshots)) if (key.startsWith("gate:")) delete snapshots[key];
    await writeFile(path, JSON.stringify(snapshots));
    return runId;
  }

  test("an approval without the box is shown again and applied once the box is ticked", async () => {
    const runId = await gateWithoutRecord();
    const s = await connect((_form, n) =>
      n === 1
        ? { action: "accept", content: { decision: "approve" } }
        : { action: "accept", content: { decision: "approve", confirm_unverified: true } },
    );
    const done = await s.call("pipeline_next_step", { run_id: runId });

    expect(Object.keys(s.forms[0]?.requestedSchema.properties ?? {})).toContain(
      "confirm_unverified",
    );
    expect(s.forms[0]?.message).toContain("WARNING");
    expect(s.forms[1]?.message).toContain("Not applied: approving needs the box ticked");
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });

  test("an approval that never ticks the box decides nothing", async () => {
    const runId = await gateWithoutRecord();
    const s = await connect(() => ({ action: "accept", content: { decision: "approve" } }));
    const done = await s.call("pipeline_next_step", { run_id: runId });

    expect(s.forms).toHaveLength(3);
    expect(done.body.dialog.answer).toBe("unusable");
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    await s.close();
  });

  test("a rejection does not need the box", async () => {
    const runId = await gateWithoutRecord();
    const s = await connect(() => ({
      action: "accept",
      content: { decision: "reject", reason: "cannot tell what changed" },
    }));
    const done = await s.call("pipeline_next_step", { run_id: runId });
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });
});

describe("t_elicit: time, attempts, and one question at a time", () => {
  test("the time a dialog may stay open is taken from the server's environment, or left alone", () => {
    const from = (value: string | undefined) =>
      dialogTimeoutFrom(value === undefined ? {} : { KODEL_DIALOG_TIMEOUT_S: value });
    expect(dialogTimeoutFrom(undefined)).toBeUndefined();
    expect(from(undefined)).toBeUndefined();
    for (const bad of ["", "  ", "soon", "0", "-5", "NaN", "Infinity"]) {
      expect(from(bad)).toBeUndefined();
    }
    expect(from("90")).toBe(90_000);
    expect(from("1.5")).toBe(1500);
  });

  test("a dialog that outlasts the time given decides nothing", async () => {
    const s = await connect(
      async () => {
        await sleep(600);
        return approve;
      },
      { dialogTimeoutMs: 80 },
    );
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog.answer).toBe("failed");
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);

    // The person's "approve" arrives after the time is over: it belongs to a request that is gone.
    await sleep(800);
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    expect(await journalOf(runId)).not.toContain("gate_decided");
    await s.close();
  });

  test("a call the agent gave up on frees the question: it is asked again, and the late answer is dropped", async () => {
    let release: (reply: Reply) => void = () => {};
    const late = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const s = await connect((_form, n) => (n === 1 ? late : { action: "decline" }));
    const runId = await start(s);
    await writeFile(join(dir, "out.txt"), "hello\n");
    const controller = new AbortController();
    const abandoned = s.client
      .callTool(
        {
          name: "pipeline_complete_step",
          arguments: { run_id: runId, node_slug: "write", attempt: 1 },
        },
        undefined,
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    await waitFor(() => s.forms.length === 1);
    controller.abort();
    await abandoned;
    release(approve);

    const again = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(2);
    expect(again.body.dialog.answer).toBe("declined");
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    expect(await journalOf(runId)).not.toContain("gate_decided");
    await s.close();
  });

  test("a decision that threw while it was applied is not reported as 'nothing changed'", async () => {
    const s = await connect(() => approve, {
      humans: (host) => ({
        open: async (id) => {
          const run = await host.open(id);
          if (!run) return undefined;
          return new Proxy(run, {
            get(target, key) {
              if (key === "decideHuman") {
                return async () => {
                  throw new Error("the journal could not be written");
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      }),
    });
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog.answer).toBe("unknown");
    expect(done.body.dialog.message).toContain("could not be confirmed");
    expect(done.body.dialog.message).not.toContain("nothing was changed");
    // The agent is shown the run as it is, not the answer it had before the dialog.
    expect(done.body.next.waiting).toMatchObject({ reason: "gate" });
    await s.close();
  });

  test("a new attempt of the step is a new question, even after a decline", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await toGate(s, runId);
    expect(s.forms).toHaveLength(1);

    // The person sends it back in a terminal; the agent works on and reaches the gate again.
    await (await s.host.open(runId))?.decideHuman("approve", "rejected", "redo it");
    await writeFile(join(dir, "out.txt"), "second try\n");
    const again = await s.call("pipeline_complete_step", {
      run_id: runId,
      node_slug: "write",
      attempt: 2,
    });

    expect(s.forms).toHaveLength(2);
    expect(again.body.dialog.answer).toBe("declined");
    await s.close();
  });

  test("a call that comes while a dialog is open is answered as before, without another dialog", async () => {
    let release: (reply: Reply) => void = () => {};
    const open = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const s = await connect(() => open);
    const runId = await start(s);
    const first = toGate(s, runId);
    await waitFor(() => s.forms.length === 1);

    const meanwhile = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(meanwhile.body.waiting).toMatchObject({ reason: "gate" });
    expect(meanwhile.body.dialog).toBeUndefined();

    release(approve);
    expect((await first).body.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });
});

describe("t_elicit: a paused run, a change of the pipeline, a state changed outside kodel", () => {
  test("resuming a paused run in the dialog", async () => {
    const s = await connect((form) =>
      form.message.includes("paused")
        ? { action: "accept", content: { confirm: true } }
        : { action: "decline" },
    );
    const runId = await start(s);
    const last = await toPause(s, runId);

    expect(s.forms.some((f) => f.message.includes("paused"))).toBe(true);
    expect(last.body.dialog).toMatchObject({ answer: "decided", what: "resumed the run" });
    expect((await (await s.host.open(runId))?.state())?.status).toBe("running");
    await s.close();
  });

  test("a paused run stays paused when the person declines", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    const last = await toPause(s, runId);

    expect(last.body.dialog.answer).toBe("declined");
    expect((await (await s.host.open(runId))?.state())?.status).toBe("paused");
    await s.close();
  });

  test("a paused run stays paused when the form is accepted with the box empty", async () => {
    const s = await connect(() => ({ action: "accept", content: { confirm: false } }));
    const runId = await start(s);
    const last = await toPause(s, runId);

    expect(last.body.dialog.answer).toBe("declined");
    expect((await (await s.host.open(runId))?.state())?.status).toBe("paused");
    await s.close();
  });

  const propose = async (s: Session, runId: string) => {
    const resolved = await s.call("pipeline_resolve", { pipeline: "demo", run_id: runId });
    const yaml = String(resolved.body.yaml).replace("write a file", "write two files");
    return s.call("pipeline_propose_change", {
      run_id: runId,
      pipeline: yaml,
      summary: "ask for two files",
    });
  };

  test("accepting the agent's proposal in the dialog puts the new pipeline in place", async () => {
    const s = await connect((form) => {
      expect(form.message).toContain("two files");
      return { action: "accept", content: { decision: "apply" } };
    });
    const runId = await start(s);
    await propose(s, runId);
    const done = await toGate(s, runId);

    expect(done.body.dialog).toMatchObject({
      answer: "decided",
      what: "accepted the change of the pipeline",
    });
    const spec = await (await s.host.open(runId))?.currentSpec();
    expect(JSON.stringify(spec)).toContain("write two files");
    await s.close();
  });

  test("dropping the proposal in the dialog leaves the run on its pipeline", async () => {
    const s = await connect(() => ({ action: "accept", content: { decision: "discard" } }));
    const runId = await start(s);
    await propose(s, runId);
    const done = await toGate(s, runId);

    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    const spec = await (await s.host.open(runId))?.currentSpec();
    expect(JSON.stringify(spec)).not.toContain("write two files");
    expect(await (await s.host.open(runId))?.pendingChange()).toBeUndefined();
    await s.close();
  });

  test("the gate is not asked while a change waits; the change is", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await propose(s, runId);
    const done = await toGate(s, runId);

    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]?.message).toContain("pipeline of the run was changed");
    expect(done.body.dialog.answer).toBe("declined");
    expect(done.body.next.waiting).toMatchObject({ reason: "pipeline_changed" });
    await s.close();
  });

  test("an answer that does not fit the form is shown again, and the right one then decides", async () => {
    const s = await connect((_form, n) =>
      n === 1
        ? { action: "accept", content: { decision: "approve", reason: 5 } }
        : n === 2
          ? { action: "accept", content: {} }
          : approve,
    );
    const runId = await start(s);
    const done = await toGate(s, runId);

    expect(s.forms).toHaveLength(3);
    expect(s.forms[1]?.message).toContain("Not applied: the answer did not fit the form.");
    expect(done.body.dialog).toMatchObject({ answer: "decided" });
    await s.close();
  });

  test("only the tools that move a run on can open a dialog; a proposal or a report cannot", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await propose(s, runId);
    await s.call("pipeline_feedback", {
      run_id: runId,
      category: "other",
      message: "a note",
    });
    await s.call("pipeline_report_result", {
      run_id: runId,
      node_slug: "write",
      attempt: 1,
      rows: [],
    });
    expect(s.forms).toHaveLength(0);

    await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    await s.close();
  });

  test("a run gets only a few dialogs about changes of its pipeline that nobody answers", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const resolved = await s.call("pipeline_resolve", { pipeline: "demo", run_id: runId });
      const yaml = String(resolved.body.yaml).replace(
        /write (a|\d+) files?/,
        `write ${i + 2} files`,
      );
      await s.call("pipeline_propose_change", {
        run_id: runId,
        pipeline: yaml,
        summary: `try ${i}`,
      });
      const next = await s.call("pipeline_next_step", { run_id: runId });
      answers.push(next.body.dialog.answer);
    }
    expect(s.forms).toHaveLength(3);
    expect(answers).toEqual(["declined", "declined", "declined", "asked", "asked"]);
    await s.close();
  });

  test("a change proposed while the gate dialog is open turns the approval into nothing", async () => {
    let runId = "";
    const s = await connect(async () => {
      await propose(s, runId);
      return approve;
    });
    runId = await start(s);
    const done = await toGate(s, runId);

    expect(done.body.dialog.answer).toBe("stale");
    expect(await humanPhase(s, runId)).toEqual(["approve:human"]);
    await s.close();
  });

  test("the note about a waiting change on the step is asked at once too", async () => {
    const s = await connect(() => ({ action: "accept", content: { decision: "apply" } }));
    const runId = await start(s);
    await propose(s, runId);
    const next = await s.call("pipeline_next_step", { run_id: runId });

    expect(next.body.dialog).toMatchObject({ answer: "decided" });
    expect(next.body.node.prompt).toContain("write two files for add a file");
    await s.close();
  });

  test("a change the engine refuses is not offered", async () => {
    const first = await connect();
    const runId = await start(first);
    await toGate(first, runId);
    await first.close();
    // The pipeline is renamed in the file: the engine cannot take that for a run that has started.
    const file = join(dir, ".kodel", "pipelines", "demo.yaml");
    const text = (await readFile(file, "utf8")).replace("name: demo", "name: other");
    await writeFile(file, text);
    const found = await (await first.host.open(runId))?.pendingChange();
    expect(found?.info.refused).toContain("name of the pipeline cannot change");

    // The refused change holds nothing back: the person is asked about the gate, not about it.
    const s = await connect(() => ({ action: "decline" }));
    await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(s.forms[0]?.message).toContain('the step "approve" waits for your decision');
    expect(s.forms[0]?.message).not.toContain("pipeline of the run was changed");
    await s.close();
  });

  const tamper = async (runId: string) => {
    const path = join(dir, ".kodel", "runs", runId, "state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.nodes.write.attempts = 0;
    await writeFile(path, JSON.stringify(state));
  };

  test("a state changed by hand is accepted only when the person says so", async () => {
    const s = await connect(() => ({
      action: "accept",
      content: { confirm: true, note: "by hand" },
    }));
    const runId = await start(s);
    await tamper(runId);

    const refused = await s.call("pipeline_next_step", { run_id: runId });
    expect(refused.body).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
    expect(refused.body.dialog).toMatchObject({ answer: "decided" });
    expect(s.forms[0]?.message).toContain("cannot tell you this is safe");

    const again = await s.call("pipeline_next_step", { run_id: runId });
    expect(again.body).toMatchObject({ ok: true, node: { slug: "write" } });
    await s.close();
  });

  test("a state changed by hand stays refused when the person declines", async () => {
    const s = await connect(() => ({ action: "decline" }));
    const runId = await start(s);
    await tamper(runId);

    const first = await s.call("pipeline_next_step", { run_id: runId });
    expect(first.body).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
    expect(first.body.dialog.answer).toBe("declined");
    // A refusal has no tell_the_person: the dialog's answer says how the person can accept it.
    expect(first.body.dialog.message).toContain(`kodel ack ${runId}`);
    const second = await s.call("pipeline_next_step", { run_id: runId });
    expect(second.body).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
    expect(second.body.dialog.answer).toBe("asked");
    await s.close();
  });

  test("a state changed by hand stays refused when the form is accepted with the box empty", async () => {
    const s = await connect(() => ({ action: "accept", content: { confirm: false } }));
    const runId = await start(s);
    await tamper(runId);

    const refused = await s.call("pipeline_next_step", { run_id: runId });
    expect(s.forms).toHaveLength(1);
    expect(refused.body).toMatchObject({ ok: false, code: "STATE_MODIFIED_EXTERNALLY" });
    expect(refused.body.dialog.answer).toBe("declined");
    await s.close();
  });
});
