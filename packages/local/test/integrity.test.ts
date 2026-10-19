import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePipeline } from "@kodel-ai/pipeline-core";
import { defaultIntegrityDir, FileIntegrity, LocalHost, MemoryIntegrity, sha256 } from "../src";

let dir: string;
let stateDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-integrity-"));
  stateDir = await mkdtemp(join(tmpdir(), "kodel-integrity-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

// An agent node that waits, so there is an active run to tamper with.
const WAITING = parsePipeline(
  [
    "name: waits",
    "nodes:",
    "  - slug: work",
    "    kind: agent",
    "    prompt: do it",
    "  - slug: ask",
    "    kind: human",
    "    prompt: ok?",
    "  - slug: redo",
    "    kind: agent",
    "    prompt: again",
    "edges:",
    "  - { from: work, to: ask }",
    "  - { from: ask, to: redo, when: rejected }",
    "",
  ].join("\n"),
);

const host = () => new LocalHost(WAITING, { root: dir, heartbeatMs: 0, integrityDir: stateDir });

const statePath = (h: LocalHost, runId: string) => join(h.store.runDir(runId), "state.json");

async function edit(h: LocalHost, runId: string, change: (state: Record<string, unknown>) => void) {
  const state = JSON.parse(await readFile(statePath(h, runId), "utf8"));
  change(state);
  await writeFile(statePath(h, runId), `${JSON.stringify(state, null, 2)}\n`);
}

describe("noticing changes made behind kodel's back", () => {
  test("an untouched run is never reported as modified", async () => {
    const h = host();
    const { run } = await h.start("t");
    for (let i = 0; i < 3; i++) await run.tick();
    await run.completeStep("work", 1);
    expect(await run.integrityStatus()).toBe("ok");
    expect((await run.nextStep()) && true).toBe(true);
  });

  test("an edit to the state file is refused with STATE_MODIFIED_EXTERNALLY and changes nothing", async () => {
    const h = host();
    const { run } = await h.start("t");
    await edit(h, run.runId, (s) => {
      (s.nodes as Record<string, { attempt: number }>).work = {
        ...(s.nodes as Record<string, { attempt: number }>).work,
        attempt: 7,
      } as never;
    });
    const before = await readFile(statePath(h, run.runId), "utf8");
    const result = await run.completeStep("work", 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
    expect(await readFile(statePath(h, run.runId), "utf8")).toBe(before);
    expect(await run.integrityStatus()).toBe("modified");
  });

  test("next_step refuses too, so the agent is told and does not carry on", async () => {
    const h = host();
    const { run } = await h.start("t");
    await edit(h, run.runId, (s) => {
      s.status = "completed";
    });
    await expect(run.nextStep()).rejects.toMatchObject({ code: "STATE_MODIFIED_EXTERNALLY" });
  });

  test("a state file that is no longer valid JSON is the same problem", async () => {
    const h = host();
    const { run } = await h.start("t");
    await writeFile(statePath(h, run.runId), "{ not json");
    const result = await run.tick();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STATE_MODIFIED_EXTERNALLY");
  });

  test("every kind of event is refused, not only the ones that look harmless", async () => {
    const h = host();
    const { run } = await h.start("t");
    await edit(h, run.runId, (s) => {
      s.nextVisitId = 99;
    });
    for (const result of [
      await run.completeStep("work", 1),
      await run.decideHuman("ask", "approved"),
      await run.resume(),
      await run.cancel(),
      await run.tick(),
      await run.feedback({ category: "other", message: "x" }),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  test("another process sees the same refusal, because the hash is outside the repository", async () => {
    const h = host();
    const { run } = await h.start("t");
    await edit(h, run.runId, (s) => {
      s.nextVisitId = 99;
    });
    const result = await host().open(run.runId).tick();
    expect(result.ok).toBe(false);
  });
});

describe("accepting a change on purpose", () => {
  test("ack takes the file as it is, journals a manual edit, and work goes on", async () => {
    const h = host();
    const { run } = await h.start("t");
    await edit(h, run.runId, (s) => {
      s.nextVisitId = 42;
    });
    expect((await run.tick()).ok).toBe(false);

    const acknowledged = await run.acknowledge("fixed the visit counter by hand");
    expect(acknowledged.ok).toBe(true);
    expect(await run.integrityStatus()).toBe("ok");
    expect((await run.state()).nextVisitId).toBe(42);
    const journal = await h.store.readJournal(run.runId);
    expect(journal.at(-1)).toMatchObject({
      event: "manual_edit",
      note: "fixed the visit counter by hand",
    });

    expect((await run.completeStep("work", 1)).ok).toBe(true);
  });

  test("ack cannot rescue a file that is not valid JSON", async () => {
    const h = host();
    const { run } = await h.start("t");
    await writeFile(statePath(h, run.runId), "garbage");
    const result = await run.acknowledge();
    expect(result.ok).toBe(false);
  });
});

describe("where the hash lives", () => {
  test("it is written outside the repository, and not under .kodel", async () => {
    const h = host();
    const { run } = await h.start("t");
    const repoKeys = await readdir(stateDir);
    expect(repoKeys).toHaveLength(1);
    const files = await readdir(join(stateDir, repoKeys[0] as string));
    expect(files).toEqual([`${run.runId}.sha256`]);
    const stored = (
      await readFile(join(stateDir, repoKeys[0] as string, files[0] as string), "utf8")
    ).trim();
    expect(stored).toBe(sha256(await readFile(statePath(h, run.runId))));
    expect(stateDir.startsWith(dir)).toBe(false);
  });

  test("two repositories never share a hash", async () => {
    const other = await mkdtemp(join(tmpdir(), "kodel-integrity-other-"));
    try {
      await new FileIntegrity(stateDir, join(dir, ".kodel")).set("r_000000001_aaaa", "aaa");
      await new FileIntegrity(stateDir, join(other, ".kodel")).set("r_000000001_aaaa", "bbb");
      expect(await new FileIntegrity(stateDir, join(dir, ".kodel")).get("r_000000001_aaaa")).toBe(
        "aaa",
      );
      expect(await new FileIntegrity(stateDir, join(other, ".kodel")).get("r_000000001_aaaa")).toBe(
        "bbb",
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("a run seen for the first time on this machine is adopted, not refused", async () => {
    const h = host();
    const { run } = await h.start("t");
    // A clone: the files are there, the trusted hash is not.
    const fresh = new LocalHost(WAITING, {
      root: dir,
      heartbeatMs: 0,
      integrityDir: await mkdtemp(join(tmpdir(), "kodel-fresh-")),
    });
    const reopened = fresh.open(run.runId);
    expect(await reopened.integrityStatus()).toBe("unknown");
    expect((await reopened.tick()).ok).toBe(true);
    expect(await reopened.integrityStatus()).toBe("ok");
  });

  test("the default directory follows the environment", () => {
    expect(defaultIntegrityDir({ KODEL_STATE_DIR: "/x/state" }, "/home/u")).toBe("/x/state");
    expect(defaultIntegrityDir({ XDG_STATE_HOME: "/x/xdg" }, "/home/u")).toBe("/x/xdg/kodel");
    expect(defaultIntegrityDir({}, "/home/u")).toBe("/home/u/.local/state/kodel");
  });

  test("a memory store behaves the same way", async () => {
    const memory = new MemoryIntegrity();
    expect(await memory.get("r")).toBeUndefined();
    await memory.set("r", "h");
    expect(await memory.get("r")).toBe("h");
  });
});

describe("sealing a finished run", () => {
  const finishRun = async (h: LocalHost) => {
    const { run } = await h.start("t");
    await run.completeStep("work", 1);
    await run.decideHuman("ask", "approved");
    expect((await run.state()).status).toBe("completed");
    return run;
  };

  test("a run that finishes is sealed at once", async () => {
    const h = host();
    const run = await finishRun(h);
    expect(await h.store.checkSeal(run.runId)).toBe("sealed");
  });

  test("a run still in progress has no seal", async () => {
    const h = host();
    const { run } = await h.start("t");
    expect(await h.store.checkSeal(run.runId)).toBe("unsealed");
  });

  test("a change to the journal or the state afterwards shows as modified", async () => {
    const h = host();
    const run = await finishRun(h);
    const journalPath = join(h.store.runDir(run.runId), "journal.jsonl");
    await writeFile(
      journalPath,
      `${await readFile(journalPath, "utf8")}{"v":1,"seq":99,"ts":0,"event":"forged"}\n`,
    );
    expect(await h.store.checkSeal(run.runId)).toBe("modified");
  });

  test("other runs are not affected by a change to one", async () => {
    const h = host();
    const first = await finishRun(h);
    const { run: second } = await h.start("another task");
    await second.completeStep("work", 1);
    await second.decideHuman("ask", "approved");
    await edit(h, first.runId, (s) => {
      s.nextVisitId = 5;
    });
    expect(await h.store.checkSeal(first.runId)).toBe("modified");
    expect(await h.store.checkSeal(second.runId)).toBe("sealed");
  });

  test("seal after a deliberate edit accepts it, journals it and seals again", async () => {
    const h = host();
    const run = await finishRun(h);
    await edit(h, run.runId, (s) => {
      s.nextVisitId = 5;
    });
    expect(await h.store.checkSeal(run.runId)).toBe("modified");
    await h.seal(run.runId);
    expect(await h.store.checkSeal(run.runId)).toBe("sealed");
    const journal = await h.store.readJournal(run.runId);
    expect(journal.at(-1)).toMatchObject({ event: "manual_edit" });
  });

  test("only a finished run can be sealed", async () => {
    const h = host();
    const { run } = await h.start("t");
    await expect(h.seal(run.runId)).rejects.toThrow("only a finished run can be sealed");
    await expect(h.seal("r_000000009_aaaa")).rejects.toThrow("there is no run");
  });
});
