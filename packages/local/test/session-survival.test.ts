import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameInput } from "../src/session-holder";
import { ensurePrivateDir } from "../src/session-paths";
import { PipesSessionAdapter } from "../src/session-pipes";
import { publishSession } from "../src/session-records";

const entry = join(import.meta.dir, "../src/session-holder-entry.ts");
const owner = join(import.meta.dir, "helpers/session-owner.ts");

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kdjs-sv-base-"));
  root = mkdtempSync(join(tmpdir(), "kdjs-sv-root-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const adapterOf = (graceMs?: number) =>
  new PipesSessionAdapter({
    base,
    root,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    pollMs: 50,
    ...(graceMs !== undefined ? { graceMs } : {}),
  });

describe("sessions outlive their owner", () => {
  test("tA_owner_sigkilled_after_start_a_retry_in_a_new_process_joins_one_result", async () => {
    const counter = join(root, "counter");
    const child = spawn(process.execPath, [owner, base, root, "step-one", counter], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const id = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (d) => {
        text += d.toString();
        const m = /started (a_\S+)/.exec(text);
        if (m?.[1]) resolve(m[1]);
      });
      child.on("exit", () => reject(new Error(`owner ended early: ${text}`)));
    });
    child.kill("SIGKILL"); // the consumer dies; the holder and the child must not
    await new Promise((r) => setTimeout(r, 100));
    const retry = adapterOf();
    // the same name: the retry finds the first attempt's session instead of running the command again
    await expect(
      retry.start({ argv: ["true"], cwd: root, name: "step-one" }),
    ).rejects.toMatchObject({
      code: "NAME_TAKEN",
    });
    const [found] = await retry.list({ name: "step-one" });
    expect(found?.id).toBe(id);
    const done = await retry.wait(id, { timeoutMs: 15_000 });
    expect(done).toMatchObject({ state: "exited", exitCode: 0 });
    expect(readFileSync(counter, "utf8")).toBe("x\n"); // one run, one result
  }, 40_000);

  test("tA_lost_is_final_a_late_holder_never_starts_the_child", async () => {
    const adapter = adapterOf(400);
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    const id = "a_000000000_0009";
    const dir = join(adapter.place.dir, id);
    const started = Date.now();
    publishSession(dir, {
      v: 1,
      id,
      mode: "pipes",
      spec: { cwd: root, envNames: [] },
      started,
      root,
    });
    // A real holder whose input is withheld: it can do nothing until the starter's message arrives.
    const holder = spawn(process.execPath, [entry, "holder"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await new Promise((r) => setTimeout(r, 700)); // past the grace
    const settled = await adapter.status(id); // the first reader writes the tombstone
    expect(settled).toMatchObject({ state: "lost", reason: "no_status" });
    const ran = join(root, "ran");
    holder.stdin.end(
      frameInput({
        v: 1,
        dir,
        argv: ["sh", "-c", `touch ${ran}`],
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        graceMs: 400,
        started,
      }),
    );
    await new Promise<void>((resolve) => holder.on("exit", () => resolve()));
    expect(existsSync(ran)).toBe(false); // the holder found the session lost and never spawned the child
    expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).by).toBe("reader");
    expect(await adapter.status(id)).toMatchObject({ state: "lost" }); // and it stays lost
  }, 30_000);
});
