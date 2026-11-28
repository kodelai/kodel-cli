import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveStatus, encodeRecord, SessionError, stoppedByPerson } from "@kodel-ai/pipeline-core";
import {
  groupMembers,
  liveProcess,
  machineId,
  type ProcessIdentity,
  type ProcessRow,
  type ProcessView,
  processIdentity,
  systemProcesses,
} from "../src/process-table";
import { ensurePrivateDir } from "../src/session-paths";
import { PipesSessionAdapter } from "../src/session-pipes";
import {
  publishSession,
  readStop,
  replaceRecord,
  snapshotOf,
  writeStop,
} from "../src/session-records";

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
    const host = { origin: "host" };
    const first = await adapter.start(sh("exit 0", { name: "Step-1", ...host }));
    await expect(adapter.start(sh("exit 0", { name: "step-1", ...host }))).rejects.toMatchObject({
      code: "NAME_TAKEN",
    });
    await adapter.wait(first.id, { timeoutMs: 15_000 });
    await adapter.remove(first.id);
    await expect(adapter.start(sh("exit 0", { name: "STEP-1", ...host }))).rejects.toMatchObject({
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

  test("tA_rm_keeps_the_name_marker_of_a_host_session", async () => {
    const { id } = await adapter.start(sh("exit 0", { name: "keep", origin: "host" }));
    await adapter.wait(id, { timeoutMs: 15_000 });
    await adapter.remove(id);
    expect(readdirSync(adapter.place.namesDir)).toEqual(["keep.json"]);
  });

  test("tA_cli_session_frees_its_name_on_remove_a_host_session_keeps_it", async () => {
    const mine = await adapter.start(sh("exit 0", { name: "mine", origin: "cli" }));
    await adapter.wait(mine.id, { timeoutMs: 15_000 });
    await adapter.remove(mine.id);
    expect(readdirSync(adapter.place.namesDir)).toEqual([]);
    const again = await adapter.start(sh("exit 0", { name: "mine", origin: "cli" }));
    expect(again.id).not.toBe(mine.id);
  });

  test("tA_a_starter_that_does_not_say_where_it_came_from_keeps_the_name_used", async () => {
    const unnamed = await adapter.start(sh("exit 0", { name: "silent" }));
    await adapter.wait(unnamed.id, { timeoutMs: 15_000 });
    await adapter.remove(unnamed.id);
    expect(readdirSync(adapter.place.namesDir)).toEqual(["silent.json"]);
    await expect(adapter.start(sh("exit 0", { name: "silent" }))).rejects.toMatchObject({
      code: "NAME_USED",
    });
  });

  test("tA_tail_refuses_a_bad_byte_count", async () => {
    const { id } = await adapter.start(sh("echo hi"));
    await adapter.wait(id, { timeoutMs: 15_000 });
    for (const bad of [0, -5, Number.NaN, 1.5]) {
      await expect(adapter.tail(id, bad)).rejects.toMatchObject({ code: "SPEC_INVALID" });
    }
  });

  test("tA_pipes_tail_gives_stdout_and_stderr_apart", async () => {
    const { id } = await adapter.start(sh("echo to-out; echo to-err >&2; exit 0"));
    await adapter.wait(id, { timeoutMs: 15_000 });
    const both = (await adapter.tail(id)).text;
    const out = (await adapter.tail(id, undefined, "stdout")).text;
    const err = (await adapter.tail(id, undefined, "stderr")).text;
    expect(both).toContain("to-out");
    expect(both).toContain("to-err");
    expect(out).toContain("to-out");
    expect(out).not.toContain("to-err");
    expect(err).toContain("to-err");
    expect(err).not.toContain("to-out");
    expect(adapter.capabilities().streams).toBe(true);
  });

  test("tA_list_carries_the_redacted_command", async () => {
    const { id } = await adapter.start({
      argv: ["sh", "-c", "echo AKIAIOSFODNN7EXAMPLE"],
      cwd: root,
      timeoutMs: 20_000,
    });
    await adapter.wait(id, { timeoutMs: 15_000 });
    const [row] = await adapter.list();
    expect(row?.command).toContain("sh -c");
    expect(row?.command).not.toContain("AKIAIOSFODNN7EXAMPLE");
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

  test("tA_mstart_session_record_started", async () => {
    // `startedBy` is written at the top level of `session.json`, beside the spec and never inside it.
    const { id } = await adapter.start({
      ...sh("exit 0", { timeoutMs: 20_000 }),
      startedBy: { by: "person", via: "tui" },
    });
    await adapter.wait(id, { timeoutMs: 15_000 });
    const record = JSON.parse(readFileSync(join(adapter.place.dir, id, "session.json"), "utf8"));
    expect(record.startedBy).toEqual({ by: "person", via: "tui" });
    expect(record.spec.startedBy).toBeUndefined();
    expect(record.spec.origin).toBeUndefined();
    // a session started by no path that names one has none
    const plain = await adapter.start(sh("exit 0", { timeoutMs: 20_000 }));
    await adapter.wait(plain.id, { timeoutMs: 15_000 });
    expect(
      "startedBy" in
        JSON.parse(readFileSync(join(adapter.place.dir, plain.id, "session.json"), "utf8")),
    ).toBe(false);
    // a note that is not one of the kinds is refused before anything is made
    await expect(
      adapter.start({ ...sh("exit 0"), startedBy: { by: "robot", via: "tui" } as never }),
    ).rejects.toMatchObject({ code: "SPEC_INVALID" });
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
    await expect(adapter.status(id)).rejects.toMatchObject({ code: "IDENTITY_UNKNOWN" });
    expect((await adapter.list()).map((e) => e.problem)).toEqual(["FOREIGN"]);
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

  tableTest(
    "tA_stop_on_a_starting_session_waits_for_the_child_and_signals_it",
    async () => {
      // like the real child of a holder, it leads its own process group
      const stranger = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      try {
        const id = "a_000000000_000a";
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
        const statusFile = join(adapter.place.dir, id, "status.json");
        const holder = { pid: process.pid, identity: processIdentity(process.pid) };
        const starting = {
          v: 1,
          state: "starting",
          by: "holder",
          holder,
          since: Date.now(),
        } as const;
        replaceRecord(statusFile, encodeRecord("status", starting));
        // the holder records its child a moment after `stop` began to wait
        setTimeout(() => {
          replaceRecord(
            statusFile,
            encodeRecord("status", {
              ...starting,
              state: "running",
              child: {
                pid: stranger.pid as number,
                identity: processIdentity(stranger.pid as number),
              },
            }),
          );
        }, 300);
        await adapter.stop(id);
        await eventually(() => !liveProcess(stranger.pid as number), 8_000);
        expect(existsSync(join(adapter.place.dir, id, "stop.json"))).toBe(true);
      } finally {
        stranger.kill("SIGKILL");
      }
    },
    30_000,
  );

  test("tA_stop_on_a_session_that_never_records_a_child_says_try_again", async () => {
    const id = "a_000000000_000b";
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
    await expect(adapter.stop(id)).rejects.toMatchObject({ code: "NOT_RUNNING" });
  }, 15_000);

  test("tA_remove_of_an_unreadable_folder_refuses_a_newer_status_and_a_live_child", async () => {
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    const newer = "a_000000000_000c";
    mkdirSync(join(adapter.place.dir, newer), { recursive: true });
    writeFileSync(join(adapter.place.dir, newer, "session.json"), "{ not json");
    writeFileSync(
      join(adapter.place.dir, newer, "status.json"),
      JSON.stringify({ v: 99, state: "running" }),
    );
    await expect(adapter.remove(newer)).rejects.toMatchObject({ code: "NEWER_FORMAT" });
    expect(existsSync(join(adapter.place.dir, newer))).toBe(true);
    const orphan = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const alive = "a_000000000_000d";
      mkdirSync(join(adapter.place.dir, alive), { recursive: true });
      writeFileSync(join(adapter.place.dir, alive, "session.json"), "{ not json");
      replaceRecord(
        join(adapter.place.dir, alive, "status.json"),
        encodeRecord("status", {
          v: 1,
          state: "running",
          by: "holder",
          holder: { pid: 2 ** 22 + 99 },
          child: { pid: orphan.pid as number },
          since: Date.now(),
        }),
      );
      await expect(adapter.remove(alive)).rejects.toMatchObject({ code: "STILL_RUNNING" });
    } finally {
      orphan.kill("SIGKILL");
    }
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

describe("the agent record", () => {
  const CONVERSATION = "0f4b1c2d-0000-4000-8000-000000000001";
  const agentFile = (id: string) => join(adapter.place.dir, id, "agent.json");

  test("tA_agent_record_is_written_once", async () => {
    // By the time the folder is a session (it is published in one rename), the agent record is in it.
    let atPublish: string | undefined;
    const watching = make({
      testHooks: {
        afterPublish(id) {
          if (atPublish !== undefined) return;
          atPublish = readFileSync(agentFile(id), "utf8");
          expect(existsSync(join(adapter.place.dir, id, "session.json"))).toBe(true);
        },
      },
    });
    const { id } = await watching.start(
      sh("sleep 60", { agent: { engine: "claude", session: CONVERSATION } }),
    );
    const written = readFileSync(agentFile(id), "utf8");
    expect(atPublish).toBe(written);
    expect(JSON.parse(written)).toEqual({
      v: 1,
      engine: "claude",
      session: CONVERSATION,
      source: "chosen",
    });
    // the stored spec does not repeat it
    const session = JSON.parse(readFileSync(join(adapter.place.dir, id, "session.json"), "utf8"));
    expect(session.spec).not.toHaveProperty("agent");
    const before = statSync(agentFile(id));
    // nothing rewrites it: not a listing, not the holder's records, not a stop
    await watching.list();
    await watching.status(id);
    await watching.stop(id).catch(() => {});
    await watching.list();
    const after = statSync(agentFile(id));
    expect(readFileSync(agentFile(id), "utf8")).toBe(written);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);

    // a session that continues another names it; one without an id has no source
    const next = await watching.start(
      sh("exit 0", { agent: { engine: "claude", session: CONVERSATION, resumes: id } }),
    );
    expect(JSON.parse(readFileSync(agentFile(next.id), "utf8"))).toMatchObject({ resumes: id });
    const bare = await watching.start(sh("exit 0", { agent: { engine: "claude" } }));
    expect(JSON.parse(readFileSync(agentFile(bare.id), "utf8"))).toEqual({
      v: 1,
      engine: "claude",
    });
    // a session that runs no agent has no such file
    const plainOne = await watching.start(sh("exit 0"));
    expect(existsSync(agentFile(plainOne.id))).toBe(false);

    const rows = await watching.list();
    expect(rows.find((r) => r.id === id)).toMatchObject({
      mode: "pipes",
      agent: { engine: "claude", session: CONVERSATION, source: "chosen" },
    });
    expect(rows.find((r) => r.id === next.id)?.agent?.resumes).toBe(id);
    const older = rows.find((r) => r.id === plainOne.id);
    expect(older?.mode).toBe("pipes");
    expect(older && "agent" in older).toBe(false);

    await expect(
      watching.start(sh("exit 0", { agent: { engine: "claude", session: "--resume" } })),
    ).rejects.toMatchObject({ code: "SPEC_INVALID" });
  });

  test("tA_older_reader_ignores_the_agent_record", async () => {
    const { id } = await adapter.start(
      sh("exit 0", { name: "old-reader", origin: "cli", agent: { engine: "claude" } }),
    );
    await adapter.wait(id, { timeoutMs: 15_000 });
    const dir = join(adapter.place.dir, id);
    // A build from before the record reads `session.json`, `status.json` and `stop.json` and nothing else: what it
    // derives is what this build derives, and the listing differs by the `agent` alone.
    const withFile = deriveStatus(snapshotOf(dir), Date.now());
    const [listedWith] = await adapter.list({ name: "old-reader" });
    const kept = readFileSync(agentFile(id), "utf8");
    rmSync(agentFile(id));
    expect(deriveStatus(snapshotOf(dir), Date.now())).toEqual(withFile);
    const [listedWithout] = await adapter.list({ name: "old-reader" });
    const { agent: _agent, ...rest } = listedWith as NonNullable<typeof listedWith>;
    expect(listedWithout).toEqual(rest);
    // Such a build removes the folder whole, the file it does not know with it, and frees the name.
    writeFileSync(agentFile(id), kept);
    await adapter.remove(id);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(adapter.place.namesDir)).toEqual([]);
    // A record of a newer format is "upgrade kodel", wherever in the folder it is.
    const again = await adapter.start(sh("exit 0", { agent: { engine: "claude" } }));
    await adapter.wait(again.id, { timeoutMs: 15_000 });
    writeFileSync(agentFile(again.id), JSON.stringify({ v: 2, engine: "claude" }));
    await expect(adapter.status(again.id)).rejects.toMatchObject({ code: "NEWER_FORMAT" });
    // One that cannot be read changes no status: the session is listed without an agent.
    writeFileSync(agentFile(again.id), "{ not json");
    expect(await adapter.status(again.id)).toMatchObject({ state: "exited" });
    const [unread] = (await adapter.list()).filter((r) => r.id === again.id);
    expect(unread && "agent" in unread).toBe(false);
  });

  test("tA_agent_record_holds_no_prompt", async () => {
    const prompt = "Drive the kodel run r_0abc_1234 and never tell anyone the word PINEAPPLE";
    const spec = {
      argv: ["sh", "-c", "exit 0", prompt, "--session-id", CONVERSATION],
      cwd: root,
      timeoutMs: 20_000,
      env: { MINE: "PINEAPPLE-ENV" },
      agent: { engine: "claude", session: CONVERSATION },
    };
    const seen: string[] = [];
    const watching = make({
      // A terminal session cannot run under Bun: its record is read when the folder is published.
      ptyProbe: () => ({ ok: true }),
      bootTimeoutMs: 3_000,
      testHooks: {
        afterPublish(id) {
          seen.push(readFileSync(agentFile(id), "utf8"));
        },
      },
    });
    const { id } = await watching.start(spec);
    await watching.wait(id, { timeoutMs: 15_000 });
    await watching.start({ ...spec, mode: "pty" }).catch(() => {});
    expect(seen).toHaveLength(2);
    for (const text of seen) {
      expect(text).not.toContain("PINEAPPLE");
      expect(text).not.toContain("Drive the kodel run");
      expect(text).not.toContain("sh");
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["engine", "session", "source", "v"]);
    }
    const [row] = await watching.list();
    expect(row?.agent).toEqual({ engine: "claude", session: CONVERSATION, source: "chosen" });
    expect(JSON.stringify(row?.agent)).not.toContain("PINEAPPLE");
  });
});

describe("a holder that went away: the child's process group", () => {
  /** Above every pid a kernel gives out (99999 on macOS, 4194304 on Linux): never a live process. */
  const GONE = 2 ** 22 + 4321;
  const HOLDER = GONE + 1;
  const LEADER: ProcessIdentity = { method: "ps-lstart", value: "Mon Jan  1 00:00:00 2024" };
  const STARTED = 1_700_000_000_000;
  const member = (pid: number, over: Partial<ProcessRow> = {}): ProcessRow => ({
    pid,
    pgid: GONE,
    state: "S",
    started: `Mon Jan  1 00:00:${String(pid % 60).padStart(2, "0")} 2024`,
    ...over,
  });

  interface FakeTable extends ProcessView {
    reads: number;
    boots: number;
    signals: [number, string][];
    table: ProcessRow[] | undefined;
  }
  const fakeTable = (
    rows: ProcessRow[] | undefined,
    over: {
      boot?: number | undefined;
      identity?: (pid: number) => ProcessIdentity | undefined;
      onSignal?: (fake: FakeTable, pid: number, signal: string) => void;
    } = {},
  ): FakeTable => {
    const fake: FakeTable = {
      reads: 0,
      boots: 0,
      signals: [],
      table: rows,
      rows() {
        fake.reads++;
        return fake.table?.map((row) => ({ ...row }));
      },
      bootTime() {
        fake.boots++;
        return "boot" in over ? over.boot : STARTED - 86_400_000;
      },
      identity: over.identity ?? (() => undefined),
      command: (pid) => (pid === 701 ? undefined : `prog-${pid} --flag`),
      signal(pid, signal) {
        fake.signals.push([pid, signal]);
        over.onSignal?.(fake, pid, signal);
      },
    };
    return fake;
  };

  /** A session folder as a holder left it: what `state` says, a holder and a child that are not there any more. */
  const record = (
    id: string,
    status: Record<string, unknown> = {},
    session: Record<string, unknown> = {},
  ): string => {
    ensurePrivateDir(adapter.place.runDir);
    ensurePrivateDir(adapter.place.dir);
    const dir = join(adapter.place.dir, id);
    publishSession(dir, {
      v: 1,
      id,
      mode: "pty",
      spec: { cwd: root, envNames: [] },
      started: STARTED,
      root,
      ...session,
    } as Parameters<typeof publishSession>[1]);
    replaceRecord(
      join(dir, "status.json"),
      encodeRecord("status", {
        v: 1,
        state: "running",
        by: "holder",
        holder: { pid: HOLDER },
        child: { pid: GONE, identity: LEADER },
        since: STARTED + 1_000,
        ...status,
      } as Parameters<typeof encodeRecord<"status">>[1]),
    );
    return dir;
  };

  test("tA_child_alive_looks_at_the_process_group", async () => {
    // The wrapper the holder started is gone, the agent behind it runs on in the wrapper's group.
    record("a_000000000_0010");
    const table = fakeTable([member(700), member(900, { pgid: 900 })]);
    const seeing = make({ processes: table });
    // The group has no leader any more: it counts as running, and the status names what is in it.
    expect(await seeing.status("a_000000000_0010")).toEqual({
      state: "lost",
      reason: "holder_gone",
      childAlive: true,
      group: "leaderless",
      leftover: [{ pid: 700 }],
    });
    await expect(seeing.remove("a_000000000_0010")).rejects.toMatchObject({
      code: "STILL_RUNNING",
      message: expect.stringContaining("kill <pid>"),
    });
    // the group empty: the session is over
    table.table = [member(900, { pgid: 900 })];
    expect((await seeing.status("a_000000000_0010")).childAlive).toBe(false);
    // a zombie nobody reaped is not a process that runs
    table.table = [member(700, { state: "Z" })];
    expect((await seeing.status("a_000000000_0010")).childAlive).toBe(false);

    // A holder that recorded the end answers for its child: what the child left in its group (a `kodel wait`
    // that outlived the session's timeout, say) is not looked at, so the session can be resumed.
    const ends: [string, Record<string, unknown>][] = [
      ["a_000000000_0011", { state: "exited", exitCode: 0 }],
      ["a_000000000_0012", { state: "killed", reason: "stopped" }],
      ["a_000000000_0013", { state: "killed", reason: "timeout", signal: "SIGTERM" }],
    ];
    const left = fakeTable([member(700)]);
    const afterAnEnd = make({ processes: left });
    for (const [id, status] of ends) {
      record(id, status);
      const now = await afterAnEnd.status(id);
      expect(now.state as string, id).toBe(status.state as string);
      expect(now.childAlive, id).toBeUndefined();
      expect(now.group, id).toBeUndefined();
    }
    expect(left.reads).toBe(0);
  });

  test("tA_child_alive_pgid_reuse", async () => {
    record("a_000000000_0020");
    // The group's number is the pid of a live process that is not the recorded child: the kernel gave the number
    // out again, which it does only once the group is empty, so nothing of the session is left.
    const stranger = fakeTable([member(GONE, { pgid: GONE }), member(701)], {
      identity: () => ({ method: "ps-lstart", value: "Tue Feb  2 02:02:02 2025" }),
    });
    const status = await make({ processes: stranger }).status("a_000000000_0020");
    expect(status).toEqual({
      state: "lost",
      reason: "holder_gone",
      childAlive: false,
      group: "stranger",
    });
    // the same when the stranger sits in another group, or no identity of the leader was recorded
    const elsewhere = [member(GONE, { pgid: 12 }), member(701)];
    expect(groupMembers(GONE, STARTED, LEADER, stranger)).toMatchObject({ stranger: true });
    const another = () => ({ method: "ps-lstart", value: "another start" }) as ProcessIdentity;
    for (const leader of [LEADER, undefined]) {
      const table = fakeTable(elsewhere, { identity: another });
      expect(groupMembers(GONE, STARTED, leader, table)).toEqual({
        known: true,
        stranger: true,
        members: [],
      });
    }
    // The number held by the recorded child itself (the same identity) is no stranger: its group is listed.
    const ours = groupMembers(
      GONE,
      STARTED,
      LEADER,
      fakeTable(elsewhere, { identity: () => LEADER }),
    );
    expect(ours).toMatchObject({ known: true, stranger: false });
    expect(ours.known && ours.members.map((m) => m.pid)).toEqual([701]);
    // An identity that cannot be read now, or cannot be compared with the recorded one, says nothing: the process
    // is not called a stranger on a guess, and the status says the group was not read.
    for (const identity of [
      () => undefined,
      () => ({ method: "proc-ticks", value: "1" }) as ProcessIdentity,
    ]) {
      const table = fakeTable(elsewhere, { identity });
      expect(groupMembers(GONE, STARTED, LEADER, table)).toEqual({ known: false });
      expect(await make({ processes: table }).status("a_000000000_0020")).toEqual({
        state: "lost",
        reason: "holder_gone",
        childAlive: false,
        group: "unread",
      });
    }
    // a leader that is a zombie is nobody's process: the members are listed (and, with no live leader, not signalled)
    const defunct = fakeTable([member(GONE, { state: "Z" }), member(701)]);
    expect(groupMembers(GONE, STARTED, LEADER, defunct)).toMatchObject({
      stranger: false,
      members: [{ pid: 701 }],
    });
  });

  test("tA_child_alive_after_a_restart", async () => {
    record("a_000000000_0030");
    // The machine was started after the session began: every number was given out anew.
    const rebooted = fakeTable([member(700)], { boot: STARTED + 60_000 });
    const status = await make({ processes: rebooted }).status("a_000000000_0030");
    expect(status).toEqual({ state: "lost", reason: "holder_gone", childAlive: false });
    expect(status.group).toBeUndefined();
    // then nothing keeps the record: it is removed like any ended session
    await make({ processes: rebooted }).remove("a_000000000_0030");
    expect(existsSync(join(adapter.place.dir, "a_000000000_0030"))).toBe(false);
    // started before the session: the members count
    record("a_000000000_0031");
    const same = fakeTable([member(700)], { boot: STARTED - 1 });
    expect((await make({ processes: same }).status("a_000000000_0031")).childAlive).toBe(true);
  });

  test("tA_child_alive_unreadable_group", async () => {
    record("a_000000000_0040");
    // The table cannot be read (a sandbox): the group is not looked at, the recorded child alone decides, as
    // before the group rule, and the status says that nothing is known of the group.
    const hidden = fakeTable(undefined);
    const blind = make({ processes: hidden });
    expect(await blind.status("a_000000000_0040")).toEqual({
      state: "lost",
      reason: "holder_gone",
      childAlive: false,
      group: "unread",
    });
    const [row] = await blind.list();
    expect(row?.status.group).toBe("unread");
    // nothing is held for good: the record can be removed
    // the boot time alone unreadable, with members there: not known either
    const noBoot = fakeTable([member(700)], { boot: undefined });
    expect((await make({ processes: noBoot }).status("a_000000000_0040")).group).toBe("unread");
    // no member at all needs no boot time: known, and empty
    const empty = fakeTable([], { boot: undefined });
    const none = await make({ processes: empty }).status("a_000000000_0040");
    expect(none.group).toBeUndefined();
    expect(empty.boots).toBe(0);
    await blind.remove("a_000000000_0040");
    expect(existsSync(join(adapter.place.dir, "a_000000000_0040"))).toBe(false);
  });

  test("tA_group_table_is_read_once_per_listing", async () => {
    for (const n of [50, 51, 52, 53]) record(`a_000000000_00${n}`);
    record("a_000000000_0054", { state: "exited", exitCode: 0 });
    const table = fakeTable([member(700)]);
    const rows = await make({ processes: table }).list();
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.status.childAlive).length).toBe(4);
    expect(table.reads).toBe(1);
    expect(table.boots).toBe(1);

    // a listing with no record whose holder went away without a word reads no table at all
    for (const n of [50, 51, 52, 53]) {
      rmSync(join(adapter.place.dir, `a_000000000_00${n}`), { recursive: true });
    }
    const { id } = await adapter.start(sh("exit 0"));
    await adapter.wait(id, { timeoutMs: 15_000 });
    const quiet = fakeTable([member(700)]);
    expect(await make({ processes: quiet }).list()).toHaveLength(2);
    expect(quiet.reads).toBe(0);
    expect(quiet.boots).toBe(0);
  });

  // The person chose: a group without its live leader is never signalled. The stop says what is there instead.
  for (const by of ["person", "finish"] as const) {
    test(`tA_stop_never_signals_a_group_without_its_leader_by_${by}`, async () => {
      const id = by === "person" ? "a_000000000_0060" : "a_000000000_0061";
      const dir = record(id);
      const table = fakeTable([member(700), member(701), member(900, { pgid: 900 })]);
      const stopping = make({ processes: table });
      expect((await stopping.status(id)).childAlive).toBe(true);
      const stopped = await stopping.stop(id, { by });
      expect(table.signals).toEqual([]);
      // Who asked is recorded (the daemon never resumes what a person stopped); nothing else is.
      expect(JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"))).toMatchObject({
        v: 1,
        by: by === "person" ? "stop" : "finish",
      });
      expect(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).state).toBe("running");
      // Still not over: the processes are named, with the command of each that could be read.
      expect(stopped).toEqual({
        state: "killed",
        reason: "stopped",
        childAlive: true,
        stoppedBy: by,
        group: "leaderless",
        leftover: [{ pid: 700, command: "prog-700 --flag" }, { pid: 701 }],
      });
      expect(stoppedByPerson(stopped)).toBe(by === "person");
      await expect(stopping.remove(id)).rejects.toMatchObject({
        code: "STILL_RUNNING",
        message: expect.stringContaining(`700, 701. kodel cannot tell`),
      });
      // A second stop signals nothing either.
      await stopping.stop(id, { by });
      expect(table.signals).toEqual([]);
      // The person ended them: the next stop settles the record, and it reads as stopped.
      table.table = [member(900, { pgid: 900 })];
      const settled = await stopping.stop(id, { by });
      expect(settled).toEqual({
        state: "killed",
        reason: "stopped",
        childAlive: false,
        stoppedBy: by,
      });
      expect(table.signals).toEqual([]);
    });
  }

  test("tA_stop_never_signals_a_leaderless_group_a_stranger_took_over", async () => {
    // The session's group emptied, its number went to another program's process, which made a group of it
    // (`setsid`), started children there and went away. No process has the number as its pid now, so nothing
    // tells these members from an agent left behind a wrapper: they are another program's, and are not signalled.
    const dir = record("a_000000000_0062");
    const later = "Fri Jun  6 06:06:06 2025";
    const taken = fakeTable([member(810, { started: later }), member(811, { started: later })]);
    const person = make({ processes: taken });
    const stopped = await person.stop("a_000000000_0062");
    expect(taken.signals).toEqual([]);
    expect(stopped).toMatchObject({
      childAlive: true,
      group: "leaderless",
      leftover: [
        { pid: 810, command: "prog-810 --flag" },
        { pid: 811, command: "prog-811 --flag" },
      ],
    });
    // Fail closed: the record is neither finished nor removable while they live, and no later stop signals them.
    expect((await person.status("a_000000000_0062")).childAlive).toBe(true);
    await expect(person.remove("a_000000000_0062")).rejects.toMatchObject({
      code: "STILL_RUNNING",
    });
    await person.stop("a_000000000_0062", { by: "finish" });
    expect(taken.signals).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("tA_stop_never_signals_a_stranger_group", async () => {
    const dir = record("a_000000000_0070");
    const stranger = fakeTable([member(GONE, { pgid: GONE }), member(701)], {
      identity: () => ({ method: "ps-lstart", value: "Tue Feb  2 02:02:02 2025" }),
    });
    const status = await make({ processes: stranger }).stop("a_000000000_0070");
    expect(status).toMatchObject({ state: "lost", childAlive: false, group: "stranger" });
    expect(stranger.signals).toEqual([]);
    expect(existsSync(join(dir, "stop.json"))).toBe(false);

    // nor a group that cannot be looked at, nor one of a machine that was restarted since
    const hidden = fakeTable(undefined);
    expect(await make({ processes: hidden }).stop("a_000000000_0070")).toMatchObject({
      state: "lost",
      group: "unread",
    });
    const rebooted = fakeTable([member(700)], { boot: STARTED + 1 });
    expect((await make({ processes: rebooted }).stop("a_000000000_0070")).state).toBe("lost");
    expect([...hidden.signals, ...rebooted.signals]).toEqual([]);
    expect(existsSync(join(dir, "stop.json"))).toBe(false);

    // A group that was the session's at the status and a stranger's at the stop: read again, not signalled.
    const turning = fakeTable([member(700)], {
      identity: () => ({ method: "ps-lstart", value: "Tue Feb  2 02:02:02 2025" }),
    });
    const late = make({ processes: turning });
    expect((await late.status("a_000000000_0070")).childAlive).toBe(true);
    turning.table = [member(GONE, { pgid: 5 }), member(700)];
    expect(await late.stop("a_000000000_0070")).toMatchObject({ group: "stranger" });
    expect(turning.signals).toEqual([]);

    // The same, when the process that got the number cannot be told from the recorded child: not known, so
    // not signalled either, and the status says the group was not read.
    const unsure = fakeTable([member(700)]);
    const doubt = make({ processes: unsure });
    expect((await doubt.status("a_000000000_0070")).childAlive).toBe(true);
    unsure.table = [member(GONE, { pgid: 5 }), member(700)];
    expect(await doubt.stop("a_000000000_0070")).toMatchObject({ state: "lost", group: "unread" });
    expect(unsure.signals).toEqual([]);
    expect(existsSync(join(dir, "stop.json"))).toBe(false);
  });

  test("tA_rm_after_the_person_ended_the_group", async () => {
    const dir = record(
      "a_000000000_0080",
      {},
      { name: "orphan", spec: { cwd: root, envNames: [], name: "orphan", origin: "cli" } },
    );
    const table = fakeTable([member(700)]);
    const person = make({ processes: table });
    await expect(person.remove("a_000000000_0080")).rejects.toMatchObject({
      code: "STILL_RUNNING",
    });
    expect(existsSync(dir)).toBe(true);
    // The stop signals nothing of a group without its leader, and the record stays until the person ended it.
    expect(await person.stop("a_000000000_0080")).toMatchObject({ childAlive: true });
    expect(table.signals).toEqual([]);
    await expect(person.remove("a_000000000_0080")).rejects.toMatchObject({
      code: "STILL_RUNNING",
    });
    table.table = [];
    const stopped = await person.stop("a_000000000_0080");
    expect(stopped).toMatchObject({ state: "killed", reason: "stopped", childAlive: false });
    const [row] = await person.list();
    expect(row?.status).toMatchObject({ state: "killed", reason: "stopped" });
    expect(row?.status.childAlive).toBeFalsy();
    await person.remove("a_000000000_0080");
    expect(existsSync(dir)).toBe(false);
  });

  tableTest(
    "tA_real_group_orphan_is_seen_and_left_to_the_person",
    async () => {
      // Real processes: a wrapper (`sh`) that the holder starts and an agent (`sleep`) behind it, in its group.
      const pidFile = join(root, "agent.pid");
      const { id } = await adapter.start(sh(`sleep 300 & echo $! > ${pidFile}; wait`));
      await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const agentPid = Number(readFileSync(pidFile, "utf8").trim());
      const stored = JSON.parse(readFileSync(join(adapter.place.dir, id, "status.json"), "utf8"));
      try {
        process.kill(stored.holder.pid, "SIGKILL");
        process.kill(stored.child.pid, "SIGKILL");
        await eventually(() => !liveProcess(stored.holder.pid) && !liveProcess(stored.child.pid));
        expect(liveProcess(agentPid)).toBe(true);
        expect(await adapter.status(id)).toMatchObject({
          state: "lost",
          reason: "holder_gone",
          childAlive: true,
        });
        await expect(adapter.remove(id)).rejects.toMatchObject({ code: "STILL_RUNNING" });
        // The stop does not signal a group without its leader: it names the process and leaves it to the person.
        const left = await adapter.stop(id);
        expect(left).toMatchObject({ childAlive: true, group: "leaderless", stoppedBy: "person" });
        expect(left.leftover).toEqual([
          { pid: agentPid, command: expect.stringContaining("sleep 300") },
        ]);
        expect(liveProcess(agentPid)).toBe(true);
        await expect(adapter.remove(id)).rejects.toMatchObject({
          code: "STILL_RUNNING",
          message: expect.stringContaining(`kill <pid>`),
        });
        // The person ends it, and the stop settles the record.
        process.kill(agentPid, "SIGKILL");
        await eventually(() => !liveProcess(agentPid), 6_000);
        const stopped = await adapter.stop(id);
        expect(stopped).toMatchObject({ state: "killed", reason: "stopped", childAlive: false });
        await adapter.remove(id);
        expect(existsSync(join(adapter.place.dir, id))).toBe(false);
      } finally {
        try {
          process.kill(agentPid, "SIGKILL");
        } catch {
          // gone
        }
      }
    },
    30_000,
  );
  tableTest(
    "tA_stop_ends_what_outlives_the_live_leader_by_pid",
    async () => {
      // The recorded child lives, so its group is the session's and is stopped as ever. A member that is no
      // descendant (its parent left) and ignores SIGTERM outlives the leader: it is ended by its own pid, as it
      // was listed while the leader lived, not by a signal to a group that has no leader any more.
      const pidFile = join(root, "member.pid");
      const { id } = await adapter.start(
        sh(`( (trap '' TERM; exec sleep 300) & echo $! > ${pidFile} ); sleep 200`),
      );
      await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const memberPid = Number(readFileSync(pidFile, "utf8").trim());
      const stored = JSON.parse(readFileSync(join(adapter.place.dir, id, "status.json"), "utf8"));
      try {
        expect(liveProcess(memberPid)).toBe(true);
        const stopped = await adapter.stop(id);
        expect(stopped).toMatchObject({ state: "killed", reason: "stopped", stoppedBy: "person" });
        expect(stopped.group).toBeUndefined();
        expect(liveProcess(stored.child.pid)).toBe(false);
        await eventually(() => !liveProcess(memberPid), 6_000);
      } finally {
        try {
          process.kill(memberPid, "SIGKILL");
        } catch {
          // gone
        }
      }
    },
    30_000,
  );
  tableTest(
    "tA_stop_looks_at_the_leader_again_before_the_group_sigterm",
    async () => {
      // The leader ends after its identity was checked and before the first signal (the stop record and the
      // listing of the table lie between): the group has no leader then, so no signal goes to it. The member is
      // signalled by its own pid, through a view that only records here, so it lives if the group got nothing.
      const pidFile = join(root, "member.pid");
      const { id } = await adapter.start(sh(`( sleep 300 & echo $! > ${pidFile} ); sleep 200`));
      await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const memberPid = Number(readFileSync(pidFile, "utf8").trim());
      const dir = join(adapter.place.dir, id);
      const stored = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
      const signals: [number, string][] = [];
      let ended = false;
      const view: ProcessView = {
        ...systemProcesses,
        rows() {
          if (!ended && existsSync(join(dir, "stop.json"))) {
            ended = true;
            process.kill(stored.child.pid, "SIGKILL");
            const until = Date.now() + 8_000;
            while (liveProcess(stored.child.pid) && Date.now() < until) Bun.sleepSync(20);
          }
          return systemProcesses.rows();
        },
        signal: (pid, signal) => void signals.push([pid, signal]),
      };
      try {
        await make({ processes: view }).stop(id);
        expect(ended).toBe(true);
        expect(liveProcess(stored.child.pid)).toBe(false);
        expect(signals).toContainEqual([memberPid, "SIGTERM"]);
        // only what was listed in the group, each by its own pid
        expect(signals.every(([pid]) => pid > 0 && pid !== stored.child.pid)).toBe(true);
        expect(liveProcess(memberPid)).toBe(true);
      } finally {
        try {
          process.kill(memberPid, "SIGKILL");
        } catch {
          // gone
        }
      }
    },
    30_000,
  );
});

describe("who asked for a stop", () => {
  const stopFile = (id: string) => join(adapter.place.dir, id, "stop.json");
  const byOf = (id: string) => JSON.parse(readFileSync(stopFile(id), "utf8")).by as string;

  test("tA_mstart_stop_record_via_is_a_note_on_the_persons_stop", () => {
    const dir = join(root, "session-via");
    mkdirSync(dir);
    writeStop(dir, "person", 1, undefined, "manager");
    expect(JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"))).toEqual({
      v: 1,
      by: "stop",
      at: 1,
      via: "manager",
    });
    // every reader takes it as the person's
    expect(readStop(dir)).toBe("person");
    // and a plain stop has no key
    const plain = join(root, "session-plain");
    mkdirSync(plain);
    writeStop(plain, "person", 2);
    expect("via" in JSON.parse(readFileSync(join(plain, "stop.json"), "utf8"))).toBe(false);
  });

  test("tA_mstart_stop_of_an_exited_session_leaves_the_persons_record", async () => {
    const { id } = await adapter.start(sh("exit 0"));
    expect((await adapter.wait(id, { timeoutMs: 15_000 })).state).toBe("exited");
    // a plain stop of an ended session writes nothing, as before
    expect((await adapter.stop(id)).stoppedBy).toBeUndefined();
    // a manager's stop leaves the person's record, with its note, and the end stays as it was
    const stopped = await adapter.stop(id, { by: "person", via: "manager" });
    expect(stopped).toMatchObject({ state: "exited", stoppedBy: "person", stoppedVia: "manager" });
    expect(byOf(id)).toBe("stop");
    expect((await adapter.status(id)).stoppedVia).toBe("manager");
  });

  test("tA_stop_record_keeps_the_persons_word", () => {
    const dir = join(root, "session");
    mkdirSync(dir);
    expect(readStop(dir)).toBe("missing");
    writeStop(dir, "finish", 1);
    expect(readStop(dir)).toBe("finish");
    // a second finish changes nothing, a person's stop replaces it, and nothing replaces the person's
    writeStop(dir, "finish", 2);
    expect(JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"))).toEqual({
      v: 1,
      by: "finish",
      at: 1,
    });
    writeStop(dir, "person", 3);
    expect(readStop(dir)).toBe("person");
    writeStop(dir, "finish", 4);
    writeStop(dir, "person", 5);
    expect(JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"))).toEqual({
      v: 1,
      by: "stop",
      at: 3,
    });
    // A record that cannot be read is not "nobody asked": a finish leaves it, a person's stop repairs it.
    writeFileSync(join(dir, "stop.json"), "{}");
    expect(readStop(dir)).toBe("unreadable");
    writeStop(dir, "finish", 6);
    expect(readStop(dir)).toBe("unreadable");
    writeStop(dir, "person", 7);
    expect(readStop(dir)).toBe("person");
    // A record of a build from before the askers were told apart, or with a `by` this build does not know.
    for (const by of ["stop", "somebody"]) {
      writeFileSync(join(dir, "stop.json"), JSON.stringify({ v: 1, by, at: 1 }));
      expect(readStop(dir), by).toBe("person");
    }
  });

  tableTest("tA_stop_by_finish_is_stopped_but_not_by_the_person", async () => {
    const { id } = await adapter.start(sh("sleep 60"));
    expect((await adapter.wait(id, { timeoutMs: 300 })).state).toBe("running");
    const stopped = await adapter.stop(id, { by: "finish" });
    expect(stopped).toMatchObject({ state: "killed", reason: "stopped", stoppedBy: "finish" });
    expect(stoppedByPerson(stopped)).toBe(false);
    expect(byOf(id)).toBe("finish");
    const [row] = await adapter.list();
    expect(row?.status).toMatchObject({ state: "killed", reason: "stopped", stoppedBy: "finish" });
    // The same stop without an asker is the person's.
    const other = await adapter.start(sh("sleep 60"));
    expect((await adapter.wait(other.id, { timeoutMs: 300 })).state).toBe("running");
    const mine = await adapter.stop(other.id);
    expect(mine).toMatchObject({ state: "killed", reason: "stopped", stoppedBy: "person" });
    expect(stoppedByPerson(mine)).toBe(true);
    expect(byOf(other.id)).toBe("stop");
  });

  /**
   * A session whose holder recorded a final state and went away while the program still runs: a real holder
   * is killed, and the record it would have left is written in its place.
   */
  const leftBehind = async (end: { reason?: "timeout" | "holder_error"; signal?: string }) => {
    const { id } = await adapter.start(sh("sleep 60"));
    expect((await adapter.wait(id, { timeoutMs: 300 })).state).toBe("running");
    const statusFile = join(adapter.place.dir, id, "status.json");
    const stored = JSON.parse(readFileSync(statusFile, "utf8"));
    process.kill(stored.holder.pid, "SIGKILL");
    await eventually(() => !liveProcess(stored.holder.pid));
    expect(liveProcess(stored.child.pid)).toBe(true);
    const { sock: _sock, ...rest } = stored;
    replaceRecord(
      statusFile,
      encodeRecord("status", { ...rest, state: "killed", ...end, since: Date.now() }),
    );
    return { id, child: stored.child.pid as number };
  };

  for (const end of [
    { reason: "timeout" },
    { reason: "holder_error" },
    { signal: "SIGTERM" },
  ] as const) {
    const label = "reason" in end ? end.reason : "signal";
    tableTest(
      `tA_a_persons_stop_of_what_a_final_record_left_reads_stopped_${label}`,
      async () => {
        const { id, child } = await leftBehind(end);
        try {
          const before = await adapter.status(id);
          expect(before).toMatchObject({ state: "killed", ...end, childAlive: true });
          expect(before.stoppedBy).toBeUndefined();
          expect(stoppedByPerson(before)).toBe(false);
          // Kodel's own end of a finished run comes first here; the person's stop still wins below.
          writeStop(join(adapter.place.dir, id), "finish", 1);
          expect((await adapter.status(id)).stoppedBy).toBe("finish");
          const stopped = await adapter.stop(id);
          await eventually(() => !liveProcess(child), 6_000);
          // The record keeps the end its holder wrote, and the status says a person stopped it.
          expect(stopped).toMatchObject({ state: "killed", ...end, stoppedBy: "person" });
          expect(stopped.childAlive).toBeFalsy();
          expect(stoppedByPerson(stopped)).toBe(true);
          expect(byOf(id)).toBe("stop");
          const [row] = await adapter.list();
          expect(row?.status).toMatchObject({ state: "killed", ...end, stoppedBy: "person" });
          expect(row?.status.childAlive).toBeFalsy();
          // A finish that comes after it does not take the person's word away.
          await adapter.stop(id, { by: "finish" }).catch(() => {});
          expect((await adapter.status(id)).stoppedBy).toBe("person");
        } finally {
          try {
            process.kill(child, "SIGKILL");
          } catch {
            // gone
          }
        }
      },
      30_000,
    );
  }
});

describe("a resumed session takes the name of the one it continues", () => {
  const CONVERSATION = "0f4b1c2d-0000-4000-8000-000000000002";
  const markerFile = (name: string) => join(adapter.place.namesDir, `${name}.json`);
  const markerOf = (name: string) =>
    JSON.parse(readFileSync(markerFile(name), "utf8")) as { id: string; name: string };
  const sessions = () => readdirSync(adapter.place.dir).filter((n) => n.startsWith("a_"));
  /** A session a person started at the command line, which has ended. */
  const finished = async (name: string, origin: "cli" | "host" = "cli") => {
    const { id } = await adapter.start(sh("exit 0", { name, origin }));
    await adapter.wait(id, { timeoutMs: 15_000 });
    return id;
  };
  const resumeSpec = (name: string, old: string, script = "sleep 30") =>
    sh(script, {
      name,
      origin: "cli",
      agent: { engine: "claude", session: CONVERSATION, resumes: old },
    });
  /** Later than the bound a claim is given to publish its folder, and than the grace of a start. */
  const later = () => Date.now() + 40_000;
  const codeOf = (start: Promise<unknown>) =>
    start.then(
      () => "started",
      (error: unknown) => (error instanceof SessionError ? error.code : String(error)),
    );

  test("tA_name_marker_moves_only_for_a_finished_cli_session", async () => {
    const old = await finished("cc");
    const before = readFileSync(markerFile("cc"), "utf8");
    expect(markerOf("cc").id).toBe(old);
    // The marker is still the old one when the new record appears, and moves after it.
    let atPublish: string | undefined;
    const watching = make({
      testHooks: {
        afterPublish() {
          atPublish = readFileSync(markerFile("cc"), "utf8");
        },
      },
    });
    const next = await watching.start(resumeSpec("cc", old), { takeName: old });
    expect(atPublish).toBe(before);
    expect(next.name).toBe("cc");
    expect(markerOf("cc")).toMatchObject({ id: next.id, name: "cc" });
    expect(readdirSync(adapter.place.namesDir)).toEqual(["cc.json"]);
    // The old record stays listed under the name, and the new one says which it continues.
    const rows = await adapter.list({ name: "cc" });
    expect(rows.map((r) => r.id).sort()).toEqual([old, next.id].sort());
    expect(rows.find((r) => r.id === next.id)?.agent).toMatchObject({
      session: CONVERSATION,
      resumes: old,
    });
    // Removing the old record keeps the name with the new one.
    await adapter.remove(old);
    expect(markerOf("cc").id).toBe(next.id);
    expect(await codeOf(adapter.start(sh("exit 0", { name: "cc", origin: "cli" })))).toBe(
      "NAME_TAKEN",
    );

    // A session that still runs: refused, its marker untouched.
    const live = readFileSync(markerFile("cc"), "utf8");
    expect(await codeOf(adapter.start(resumeSpec("cc", next.id), { takeName: next.id }))).toBe(
      "STILL_RUNNING",
    );
    expect(readFileSync(markerFile("cc"), "utf8")).toBe(live);

    // A host session's marker is never moved.
    const host = await finished("step-1", "host");
    const hostMarker = readFileSync(markerFile("step-1"), "utf8");
    expect(await codeOf(adapter.start(resumeSpec("step-1", host), { takeName: host }))).toBe(
      "UNSUPPORTED",
    );
    expect(readFileSync(markerFile("step-1"), "utf8")).toBe(hostMarker);
    // Neither is one whose name is not the one asked for, nor a session that is not there.
    const other = await finished("other");
    const count = sessions().length;
    expect(await codeOf(adapter.start(resumeSpec("cc2", other), { takeName: other }))).toBe(
      "SPEC_INVALID",
    );
    expect(
      await codeOf(
        adapter.start(resumeSpec("gone", "a_000000000_0000"), { takeName: "a_000000000_0000" }),
      ),
    ).toBe("NOT_FOUND");
    expect(sessions().length).toBe(count);
    expect(readdirSync(adapter.place.namesDir).sort()).toEqual([
      "cc.json",
      "other.json",
      "step-1.json",
    ]);
  });

  test("tA_name_marker_is_not_moved_from_a_live_process", async () => {
    // The holder is gone and never recorded the end; a process of the child's group still runs.
    const old = await finished("cc");
    const dir = join(adapter.place.dir, old);
    const gone = 2 ** 22 + 77;
    replaceRecord(
      join(dir, "status.json"),
      encodeRecord("status", {
        v: 1,
        state: "running",
        by: "holder",
        holder: { pid: gone + 1 },
        child: { pid: gone },
        since: Date.now(),
      } as Parameters<typeof encodeRecord<"status">>[1]),
    );
    const orphan: ProcessRow = {
      pid: gone + 2,
      pgid: gone,
      state: "S",
      started: "Mon Jan  1 00:00:00 2024",
    };
    const view: ProcessView = {
      rows: () => [orphan],
      bootTime: () => 0,
      identity: () => undefined,
      command: () => undefined,
      signal: () => {},
    };
    const withOrphan = make({ processes: view });
    expect((await withOrphan.list()).find((r) => r.id === old)?.status).toMatchObject({
      state: "lost",
      childAlive: true,
    });
    const before = readFileSync(markerFile("cc"), "utf8");
    const refused = await withOrphan.start(resumeSpec("cc", old), { takeName: old }).then(
      () => undefined,
      (error: unknown) => error as SessionError,
    );
    expect(refused?.code).toBe("STILL_RUNNING");
    expect(refused?.message).toContain(`kodel agent stop ${old}`);
    expect(readFileSync(markerFile("cc"), "utf8")).toBe(before);
    expect(sessions()).toEqual([old]);
    expect(readdirSync(adapter.place.namesDir)).toEqual(["cc.json"]);
    // so that the cleanup of the test has nothing to signal
    rmSync(dir, { recursive: true, force: true });
  });

  test("tA_failed_resume_restores_the_marker", async () => {
    const old = await finished("cc");
    const before = readFileSync(markerFile("cc"), "utf8");
    // The holder cannot start the command (its folder is not there): the boot fails after the move.
    let movedTo: string | undefined;
    const failing = make({
      testHooks: {
        afterPublish(id) {
          movedTo = id;
        },
      },
    });
    expect(
      await codeOf(
        failing.start({ ...resumeSpec("cc", old), cwd: join(root, "missing") }, { takeName: old }),
      ),
    ).toBe("HOLDER_BOOT_FAILED");
    expect(movedTo).toBeDefined();
    expect(readFileSync(markerFile("cc"), "utf8")).toBe(before);
    expect(readdirSync(adapter.place.namesDir)).toEqual(["cc.json"]);
    expect(sessions()).toEqual([old]);
    // The name is still the old session's: a resume after the failure goes through.
    const next = await adapter.start(resumeSpec("cc", old, "exit 0"), { takeName: old });
    expect(markerOf("cc").id).toBe(next.id);
  });

  test("tA_no_dangling_name_after_a_crash_in_a_resume", async () => {
    for (const step of ["take_claimed", "take_published", "take_moved"] as const) {
      const name = `cc-${step.replace("take_", "")}`;
      const old = await finished(name);
      const dying = make({ faults: [step] });
      await expect(dying.start(resumeSpec(name, old), { takeName: old })).rejects.toThrow(
        `fault: ${step}`,
      );
      // Whatever the step, the marker names a session whose folder is there.
      const held = markerOf(name).id;
      expect(existsSync(join(adapter.place.dir, held)), step).toBe(true);
      expect(held === old, step).toBe(step !== "take_moved");
      // A plain start under the name is refused, never let in by a half-done move.
      expect(await codeOf(adapter.start(sh("exit 0", { name, origin: "cli" }))), step).toBe(
        "NAME_TAKEN",
      );
      // What the dead starter left does not hold the name for good: once it is clearly dead (its
      // session never began, or is over), a resume of whatever the marker names goes through.
      const after = make({ now: later });
      const next = await after.start(resumeSpec(name, held, "exit 0"), { takeName: held });
      expect(markerOf(name).id, step).toBe(next.id);
      expect(
        readdirSync(adapter.place.namesDir).filter((n) => n.startsWith(name)),
        step,
      ).toEqual([`${name}.json`]);
    }
  }, 60_000);

  test("tA_plain_start_never_takes_a_name_in_a_resume", async () => {
    const old = await finished("cc");
    const answers: string[] = [];
    // At each point of the resume a plain start under the name is tried by another starter.
    const plainStart = async (at: string) => {
      const code = await codeOf(make().start(sh("exit 0", { name: "cc", origin: "cli" })));
      answers.push(`${at}: ${code}`);
    };
    await plainStart("before");
    let atPublish: Promise<void> | undefined;
    const resuming = make({
      testHooks: {
        afterPublish() {
          atPublish = plainStart("published");
        },
      },
    });
    const next = await resuming.start(resumeSpec("cc", old), { takeName: old });
    await atPublish;
    await plainStart("moved");
    await adapter.stop(next.id).catch(() => {});
    await adapter.wait(next.id, { timeoutMs: 15_000 });
    await plainStart("ended");
    expect(answers).toEqual([
      "before: NAME_TAKEN",
      "published: NAME_TAKEN",
      "moved: NAME_TAKEN",
      "ended: NAME_TAKEN",
    ]);
    expect(markerOf("cc").id).toBe(next.id);
    // A resume that fails gives the name back to the old session, not to a plain start.
    const again = await finished("dd");
    expect(
      await codeOf(
        make().start(
          { ...resumeSpec("dd", again), cwd: join(root, "missing") },
          { takeName: again },
        ),
      ),
    ).toBe("HOLDER_BOOT_FAILED");
    expect(await codeOf(adapter.start(sh("exit 0", { name: "dd", origin: "cli" })))).toBe(
      "NAME_TAKEN",
    );
    expect(markerOf("dd").id).toBe(again);
  }, 60_000);

  test("tA_two_resumes_of_one_name_one_wins", async () => {
    const old = await finished("cc");
    const answers = await Promise.all([
      codeOf(make().start(resumeSpec("cc", old), { takeName: old })),
      codeOf(make().start(resumeSpec("cc", old), { takeName: old })),
    ]);
    expect([...answers].sort()).toEqual(["NAME_TAKEN", "started"]);
    // The loser left nothing: one new record, one marker, no claim.
    const winner = markerOf("cc").id;
    expect(winner).not.toBe(old);
    expect(sessions().sort()).toEqual([old, winner].sort());
    expect(readdirSync(adapter.place.namesDir)).toEqual(["cc.json"]);
    // A later resume of the old record is refused too: the name has moved on.
    expect(await codeOf(adapter.start(resumeSpec("cc", old), { takeName: old }))).toBe(
      "NAME_TAKEN",
    );
    expect(markerOf("cc").id).toBe(winner);
  });
});
