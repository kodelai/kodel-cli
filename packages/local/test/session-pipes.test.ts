import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRecord, SessionError } from "@kodel-ai/pipeline-core";
import { liveProcess, machineId, processIdentity } from "../src/process-table";
import { ensurePrivateDir } from "../src/session-paths";
import { PipesSessionAdapter } from "../src/session-pipes";
import { publishSession, replaceRecord } from "../src/session-records";

const entry = join(import.meta.dir, "../src/session-holder-entry.ts");
const tableAvailable = processIdentity(process.pid) !== undefined;
const needTable = !tableAvailable && process.env.KODEL_REQUIRE_PROCTABLE !== "1";
const tableTest = test.skipIf(needTable);

let base: string;
let root: string;
let adapter: PipesSessionAdapter;
const made: string[] = [];

const eventually = async (check: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not reached");
};

const make = (over: Partial<ConstructorParameters<typeof PipesSessionAdapter>[0]> = {}) =>
  new PipesSessionAdapter({
    base,
    root,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    pollMs: 50,
    ...over,
  });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "kdjs-base-"));
  root = mkdtempSync(join(tmpdir(), "kdjs-root-"));
  made.push(base, root);
  adapter = make();
});

afterEach(async () => {
  for (const entryName of existsSync(adapter.place.dir) ? readdirSync(adapter.place.dir) : []) {
    await adapter.stop(entryName).catch(() => {});
  }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (script: string, extra: Record<string, unknown> = {}) => ({
  argv: ["sh", "-c", script],
  cwd: root,
  timeoutMs: 20_000,
  ...extra,
});

describe("pipes adapter, real processes", () => {
  test("tA_pipes_start_wait_exit_code_and_tail", async () => {
    const { id } = await adapter.start(sh("echo hello; echo oops >&2; exit 3"));
    const done = await adapter.wait(id, { timeoutMs: 15_000 });
    expect(done).toMatchObject({ state: "exited", exitCode: 3 });
    const tail = await adapter.tail(id);
    expect(tail.text).toContain("hello");
    expect(tail.text).toContain("oops");
  });

  test("tA_pipes_child_runs_in_the_given_cwd_with_the_engine_mark", async () => {
    const { id } = await adapter.start(
      sh('touch here.txt; echo "engine=$KODEL_ENGINE state=${KODEL_STATE_DIR:-unset} own=$MINE"', {
        env: { MINE: "yes" },
        inheritEnv: true,
      }),
    );
    await adapter.wait(id, { timeoutMs: 15_000 });
    expect(existsSync(join(root, "here.txt"))).toBe(true);
    const { text } = await adapter.tail(id);
    expect(text).toContain("engine=1 state=unset own=yes");
  });

  test("tA_pipes_timeout_kills_with_reason", async () => {
    const { id } = await adapter.start(sh("sleep 30", { timeoutMs: 400 }));
    const done = await adapter.wait(id, { timeoutMs: 15_000 });
    expect(done).toMatchObject({ state: "killed", reason: "timeout" });
  });

  tableTest("tA_pipes_stop_kills_the_child_and_marks_stopped", async () => {
    const { id } = await adapter.start(sh("sleep 60"));
    await eventually(() => readdirSync(adapter.place.dir).length > 0);
    const running = await adapter.wait(id, { timeoutMs: 300 });
    expect(running.state).toBe("running");
    const stopped = await adapter.stop(id);
    expect(stopped).toMatchObject({ state: "killed", reason: "stopped" });
    expect(stopped.childAlive).toBeUndefined();
  });

  tableTest("tA_stop_kills_setsid_grandchild", async () => {
    const pidFile = join(root, "grandchild.pid");
    const py = `import subprocess,time;p=subprocess.Popen(['sleep','60'],start_new_session=True);open('${pidFile}','w').write(str(p.pid));time.sleep(60)`;
    const { id } = await adapter.start({
      argv: ["python3", "-c", py],
      cwd: root,
      timeoutMs: 30_000,
    });
    // the file exists before the pid is written into it
    await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(liveProcess(pid)).toBe(true);
    await adapter.stop(id);
    await eventually(() => !liveProcess(pid), 6_000);
  });

  test("tA_pipes_holder_outlives_the_intermediate_and_is_detached", async () => {
    const { id } = await adapter.start(sh("sleep 60"));
    const dir = join(adapter.place.dir, id);
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    expect(status.holder.pid).not.toBe(process.pid);
    expect(liveProcess(status.holder.pid)).toBe(true);
    expect(status.state).toBe("running");
  });

  test("tA_session_name_race_taken_then_used_after_remove", async () => {
    const first = await adapter.start(sh("exit 0", { name: "Step-1" }));
    await expect(adapter.start(sh("exit 0", { name: "step-1" }))).rejects.toMatchObject({
      code: "NAME_TAKEN",
    });
    await adapter.wait(first.id, { timeoutMs: 15_000 });
    await adapter.remove(first.id);
    await expect(adapter.start(sh("exit 0", { name: "STEP-1" }))).rejects.toMatchObject({
      code: "NAME_USED",
    });
    expect((await adapter.list({ name: "step-1" })).length).toBe(0);
  });

  test("tA_pipes_lookup_by_name_finds_the_live_session", async () => {
    const { id } = await adapter.start(sh("sleep 30", { name: "n1" }));
    const found = await adapter.list({ name: "N1" });
    expect(found.map((e) => e.id)).toEqual([id]);
  });

  test("tA_boot_failed_rolls_back_marker_and_directory", async () => {
    await expect(
      adapter.start({ argv: ["sh", "-c", "exit 0"], cwd: join(root, "missing"), name: "retry-me" }),
    ).rejects.toMatchObject({ code: "HOLDER_BOOT_FAILED" });
    expect(readdirSync(adapter.place.dir).filter((n) => n.startsWith("a_"))).toEqual([]);
    const again = await adapter.start(sh("exit 0", { name: "retry-me" }));
    expect((await adapter.wait(again.id, { timeoutMs: 15_000 })).state).toBe("exited");
  });

  tableTest("tA_pipes_remove_refuses_a_running_session_and_ignores_bad_ids", async () => {
    const { id } = await adapter.start(sh("sleep 30"));
    await expect(adapter.remove(id)).rejects.toMatchObject({ code: "STILL_RUNNING" });
    for (const bad of ["..", ".", "names", "../x"]) {
      await expect(adapter.remove(bad)).rejects.toBeInstanceOf(SessionError);
    }
    expect(existsSync(join(adapter.place.dir, id))).toBe(true);
  });

  test("tA_rm_and_prune_never_touch_name_markers", async () => {
    const { id } = await adapter.start(sh("exit 0", { name: "keep" }));
    await adapter.wait(id, { timeoutMs: 15_000 });
    await adapter.remove(id);
    expect(readdirSync(adapter.place.namesDir)).toEqual(["keep.json"]);
  });

  test("tA_pipes_send_reaches_a_child_that_reads_stdin_twice", async () => {
    const { id } = await adapter.start(sh("while read l; do echo got:$l; done", { input: true }));
    const first = await adapter.send?.(id, "one");
    expect(first?.bytes).toBe(4);
    await adapter.send?.(id, "two words");
    await eventually(() => {
      const dir = join(adapter.place.dir, id);
      return (
        existsSync(join(dir, "tail.txt")) &&
        readFileSync(join(dir, "tail.txt"), "utf8").includes("got:two words")
      );
    }, 10_000);
    const { text } = await adapter.tail(id);
    expect(text).toContain("got:one");
  });

  test("tA_pipes_send_refuses_without_input_and_when_not_running", async () => {
    const quiet = await adapter.start(sh("sleep 30"));
    await expect(adapter.send?.(quiet.id, "x")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const done = await adapter.start(sh("exit 0", { input: true }));
    await adapter.wait(done.id, { timeoutMs: 15_000 });
    await expect(adapter.send?.(done.id, "x")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await expect(adapter.send?.("a_000000000_0000", "x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("tA_pipes_without_input_a_reader_of_stdin_sees_end_of_file", async () => {
    const { id } = await adapter.start(sh("cat; echo end"));
    const done = await adapter.wait(id, { timeoutMs: 15_000 });
    expect(done.state).toBe("exited");
    expect((await adapter.tail(id)).text).toContain("end");
  });

  test("tA_stop_without_a_recorded_identity_never_signals", async () => {
    // a session folder written by hand: the child is a stranger's live process, no identity was recorded
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const id = "a_000000000_0002";
      ensurePrivateDir(adapter.place.runDir);
      ensurePrivateDir(adapter.place.dir);
      publishSession(join(adapter.place.dir, id), {
        v: 1,
        id,
        mode: "pipes",
        spec: { cwd: root, envNames: [] },
        started: Date.now(),
        root,
      });
      replaceRecord(
        join(adapter.place.dir, id, "status.json"),
        encodeRecord("status", {
          v: 1,
          state: "running",
          by: "holder",
          holder: { pid: process.pid },
          child: { pid: stranger.pid as number },
          since: Date.now(),
        }),
      );
      await expect(adapter.stop(id)).rejects.toMatchObject({ code: "IDENTITY_UNKNOWN" });
      expect(liveProcess(stranger.pid as number)).toBe(true);
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  tableTest("tA_recycled_holder_pid_is_not_a_running_session", async () => {
    const id = "a_000000000_0003";
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    publishSession(join(adapter.place.dir, id), {
      v: 1,
      id,
      mode: "pipes",
      spec: { cwd: root, envNames: [] },
      started: Date.now(),
      root,
    });
    const real = processIdentity(process.pid);
    replaceRecord(
      join(adapter.place.dir, id, "status.json"),
      encodeRecord("status", {
        v: 1,
        state: "running",
        by: "holder",
        holder: {
          pid: process.pid,
          identity: {
            method: real?.method ?? "ps-lstart",
            value: "not the start time",
            ...(real?.boot ? { boot: real.boot } : {}),
          },
        },
        since: Date.now(),
      }),
    );
    expect(await adapter.status(id)).toMatchObject({ state: "lost" });
  });

  test("tA_boot_bound_never_leaves_a_command_running_without_its_session", async () => {
    for (let i = 0; i < 4; i++) {
      const ran = join(root, `ran-${i}`);
      const quick = make({ bootTimeoutMs: 1 });
      let outcome: "ok" | "failed" = "ok";
      try {
        await quick.start(sh(`touch ${ran}; sleep 2`, { name: `bound-${i}`, timeoutMs: 5_000 }));
      } catch (error) {
        expect((error as SessionError).code).toBe("HOLDER_BOOT_FAILED");
        outcome = "failed";
      }
      await new Promise((r) => setTimeout(r, 1_500));
      const folders = existsSync(quick.place.dir)
        ? readdirSync(quick.place.dir).filter((n) => n.startsWith("a_"))
        : [];
      if (existsSync(ran)) expect(folders.length).toBeGreaterThan(0); // it ran, so its session must still be there
      if (!existsSync(ran) && outcome === "failed") {
        // nothing ran: the folder and the name were rolled back, so the same name starts again
        expect(folders.length).toBe(0);
      }
      for (const f of folders) await quick.stop(f).catch(() => {});
    }
  }, 60_000);

  test("tA_command_and_argv_are_redacted_in_session_json", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const { id } = await adapter.start({
      command: `echo ${secret}; exit 0`,
      cwd: root,
      timeoutMs: 20_000,
    });
    await adapter.wait(id, { timeoutMs: 15_000 });
    const text = readFileSync(join(adapter.place.dir, id, "session.json"), "utf8");
    expect(text).not.toContain(secret);
  });

  test("tA_project_rule_with_a_function_ends_rules_unknown_and_runs_nothing", async () => {
    const ran = join(root, "ran-rules");
    const withRule = make({
      rules: [{ name: "x", pattern: /x/g, replace: () => "y" }],
    });
    await expect(withRule.start(sh(`touch ${ran}`))).rejects.toMatchObject({
      code: "HOLDER_BOOT_FAILED",
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(ran)).toBe(false);
  });

  test("tA_list_marks_an_unreadable_folder", async () => {
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    const id = "a_000000000_0004";
    mkdirSync(join(adapter.place.dir, id), { recursive: true });
    writeFileSync(join(adapter.place.dir, id, "session.json"), "{ not json");
    const rows = await adapter.list();
    expect(rows).toEqual([{ id, status: { state: "lost" }, problem: "CANNOT_READ" }]);
  });

  test("tA_foreign_machine_session_is_never_judged_removed_or_signalled", async () => {
    if (machineId() === undefined) return; // no machine id readable here: no session is foreign
    const id = "a_000000000_0005";
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    publishSession(join(adapter.place.dir, id), {
      v: 1,
      id,
      mode: "pipes",
      spec: { cwd: root, envNames: [] },
      started: Date.now() - 60_000,
      root,
      machine: "another-machine-entirely",
    });
    await expect(adapter.remove(id)).rejects.toMatchObject({ code: "IDENTITY_UNKNOWN" });
    await expect(adapter.stop(id)).rejects.toMatchObject({ code: "IDENTITY_UNKNOWN" });
    await expect(adapter.wait(id, { timeoutMs: 100 })).rejects.toMatchObject({
      code: "IDENTITY_UNKNOWN",
    });
    expect(existsSync(join(adapter.place.dir, id))).toBe(true);
    expect(existsSync(join(adapter.place.dir, id, "status.json"))).toBe(false); // no tombstone either
  });

  test("tA_list_shows_a_session_whose_status_is_unreadable_and_rm_removes_a_dead_unreadable_one", async () => {
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    const id = "a_000000000_0006";
    publishSession(join(adapter.place.dir, id), {
      v: 1,
      id,
      name: "odd",
      mode: "pipes",
      spec: { cwd: root, envNames: [] },
      started: Date.now(),
      root,
    });
    writeFileSync(join(adapter.place.dir, id, "status.json"), "{ broken");
    const rows = await adapter.list();
    expect(rows).toEqual([{ id, name: "odd", status: { state: "lost" }, problem: "CANNOT_READ" }]);
    const bad = "a_000000000_0007";
    mkdirSync(join(adapter.place.dir, bad), { recursive: true });
    writeFileSync(join(adapter.place.dir, bad, "session.json"), "{ not json");
    await adapter.remove(bad);
    expect(existsSync(join(adapter.place.dir, bad))).toBe(false);
  });

  test("tA_unsupported_lifetime_and_parent_are_refused", async () => {
    await expect(adapter.start(sh("true", { lifetime: "with-starter" }))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(adapter.start(sh("true", { parent: "a_000000000_0000" }))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  test("tA_unknown_id_and_invalid_spec", async () => {
    await expect(adapter.status("a_000000000_0000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adapter.start({ argv: [], cwd: root })).rejects.toMatchObject({
      code: "SPEC_INVALID",
    });
    await expect(adapter.start({ argv: ["true"], cwd: "rel" })).rejects.toMatchObject({
      code: "SPEC_INVALID",
    });
  });

  test("tA_lost_is_final_after_the_grace_with_no_holder", async () => {
    // a session folder whose holder never started: the first reader writes the tombstone, the second sees the same
    const slow = make({ graceMs: 1 });
    const { id } = { id: "a_000000000_0001" };
    const { publishSession } = await import("../src/session-records");
    const { ensurePrivateDir } = await import("../src/session-paths");
    ensurePrivateDir(slow.place.runDir);
    ensurePrivateDir(slow.place.dir);
    publishSession(join(slow.place.dir, id), {
      v: 1,
      id,
      mode: "pipes",
      spec: { cwd: root, envNames: [] },
      started: Date.now() - 1_000,
      root,
    });
    const a = await slow.status(id);
    const b = await slow.status(id);
    expect(a).toMatchObject({ state: "lost", reason: "no_status" });
    expect(b).toMatchObject({ state: "lost" });
    expect(JSON.parse(readFileSync(join(slow.place.dir, id, "status.json"), "utf8")).by).toBe(
      "reader",
    );
  });
});
