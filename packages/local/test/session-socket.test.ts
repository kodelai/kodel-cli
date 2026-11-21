import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
  encodeRecord,
  SessionError,
  type SessionRecord,
  type SocketCandidate,
  type StatusRecord,
  socketNames,
  statusRecordSchema,
} from "@kodel-ai/pipeline-core";
import { AttachServer } from "../src/attach-server";
import { processIdentity } from "../src/process-table";
import { sessionDirOf } from "../src/session-paths";
import { type PipesAdapterOptions, PipesSessionAdapter } from "../src/session-pipes";
import { publishSession, replaceRecord } from "../src/session-records";
import {
  bindSessionSocket,
  sessionSocketCandidates,
  sessionSocketProblem,
  socketDirProblem,
  socketFileProblem,
  socketHash,
  sweepSessionSockets,
} from "../src/session-socket";
import { FakeChild, TestClient } from "./helpers/attach-fakes";
import { liveSocket, shortDir, socketSkipReason, staleSocket, uid } from "./helpers/socket-env";

const entry = join(import.meta.dir, "../src/session-holder-entry.ts");
const socketTest = test.skipIf(socketSkipReason !== undefined);
const identity = processIdentity(process.pid);
const tableTest = test.skipIf(
  identity === undefined && process.env.KODEL_REQUIRE_PROCTABLE !== "1",
);
const socketTableTest = test.skipIf(
  socketSkipReason !== undefined ||
    (identity === undefined && process.env.KODEL_REQUIRE_PROCTABLE !== "1"),
);
const ID = "a_000000000_0000";

let base: string;
let root: string;
let tmpA: string;
let tmpB: string;
const made: string[] = [];

const make = (over: Partial<PipesAdapterOptions> = {}): PipesSessionAdapter =>
  new PipesSessionAdapter({
    base,
    root,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    pollMs: 20,
    socket: { roots: { tmpDir: tmpA, systemTmp: tmpB } },
    ...over,
  });

beforeEach(() => {
  base = shortDir("kd-b-");
  root = shortDir("kd-r-");
  tmpA = shortDir("kd-ta-");
  tmpB = shortDir("kd-tb-");
  made.push(base, root, tmpA, tmpB);
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sessionRecord = (id: string, mode: "pipes" | "pty"): SessionRecord => ({
  v: 1,
  id,
  mode,
  spec: { argv: ["sleep", "60"], cwd: root, mode, envNames: [] },
  started: Date.now(),
  root,
});

/** A session folder as a holder would have left it, without a holder. */
const forge = (
  adapter: PipesSessionAdapter,
  id: string,
  mode: "pipes" | "pty",
  status?: Partial<StatusRecord> & { state: StatusRecord["state"] },
): string => {
  for (const d of [adapter.place.runDir, adapter.place.dir])
    mkdirSync(d, { recursive: true, mode: 0o700 });
  const dir = sessionDirOf(adapter.place, id);
  publishSession(dir, sessionRecord(id, mode));
  if (status) {
    replaceRecord(
      join(dir, "status.json"),
      encodeRecord("status", { v: 1, by: "holder", since: Date.now(), ...status }),
    );
  }
  return dir;
};

/** The holder and child of a forged session that "runs": this very process. */
const alive = () => ({
  holder: { pid: process.pid, ...(identity ? { identity } : {}) },
  child: { pid: process.pid, ...(identity ? { identity } : {}) },
});
/** A holder that is gone: a pid no process has. */
const dead = () => ({ holder: { pid: 2_000_000_000 } });

const primaryOf = (adapter: PipesSessionAdapter, id = ID): string =>
  (
    sessionSocketCandidates(adapter.place, id, {
      tmpDir: tmpA,
      systemTmp: tmpB,
    })[0] as SocketCandidate
  ).path;

const notAttachable = async (adapter: PipesSessionAdapter, id: string): Promise<string> => {
  const answer = await adapter.attachable(id);
  expect(answer.ok).toBe(false);
  const error = await adapter.attach(id).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionError);
  expect((error as SessionError).code).toBe("NOT_ATTACHABLE");
  return answer.ok ? "" : answer.reason;
};

describe("socket folders and files", () => {
  test("tA_socket_tmp_dir_squatted_refuses", async () => {
    const adapter = make();
    const names = socketNames({ checkoutKey: adapter.place.key, id: ID, hash: socketHash });
    const folder = `kodel-${uid}`;
    const real = join(tmpB, "elsewhere");
    mkdirSync(real, { mode: 0o700 });
    // somebody made the fallback folder first: as a link to a folder of theirs, or open to others
    const linked = join(tmpA, folder);
    symlinkSync(real, linked);
    const shared = join(tmpB, folder);
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    expect(socketDirProblem(linked, uid)).toContain("not a real directory");
    expect(socketDirProblem(shared, uid)).toContain("not private");
    expect(socketDirProblem(real, uid + 1)).toContain("not owned");
    expect(socketDirProblem(join(tmpA, "missing"), uid)).toContain("does not exist");
    expect(socketDirProblem(real, uid)).toBeUndefined();

    // the holder: the bind refuses, and does not move on to a folder that would do
    const good = join(base, folder);
    for (const dir of [linked, shared]) {
      const list: SocketCandidate[] = [
        { kind: "tmpdir", dir, path: join(dir, names.hashed) },
        { kind: "tmp", dir: good, path: join(good, names.hashed) },
      ];
      expect(bindSessionSocket(list, uid)).rejects.toThrow(/not a real directory|not private/);
      expect(existsSync(good)).toBe(false);
    }
    expect(readdirSync(real)).toEqual([]);

    // the client: a path in such a folder is never connected to
    for (const dir of [linked, shared]) {
      expect(sessionSocketProblem(join(dir, names.hashed), adapter.place, ID)).toMatch(
        /not a real directory|not private/,
      );
    }
  });

  test("tA_attach_client_checks_socket_owner", () => {
    const adapter = make();
    mkdirSync(adapter.place.runDir, { recursive: true, mode: 0o700 });
    const path = primaryOf(adapter);
    expect(sessionSocketProblem(path, adapter.place, ID)).toContain("does not exist");
    writeFileSync(path, "", { mode: 0o600 });
    expect(sessionSocketProblem(path, adapter.place, ID)).toContain("is not a socket");
    expect(socketFileProblem(path, uid, "unlink")).toContain("is not a socket");
    // a path that is not this session's is refused by its name, whatever is there
    expect(
      sessionSocketProblem(join(adapter.place.runDir, "other.sock"), adapter.place, ID),
    ).toContain("is not a socket path of session");
    expect(sessionSocketProblem("/etc/passwd", adapter.place, ID)).toContain(
      "is not a socket path",
    );
  });

  socketTest(
    "tA_attach_client_checks_socket_owner: a real socket of another mode or owner",
    async () => {
      const adapter = make();
      mkdirSync(adapter.place.runDir, { recursive: true, mode: 0o700 });
      const path = primaryOf(adapter);
      const server = await liveSocket(path);
      try {
        chmodSync(path, 0o644);
        expect(sessionSocketProblem(path, adapter.place, ID)).toContain("mode 0600");
        chmodSync(path, 0o600);
        expect(sessionSocketProblem(path, adapter.place, ID)).toBeUndefined();
        expect(socketFileProblem(path, uid + 1)).toContain("not owned");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  socketTest("tA_pty_socket_primary_and_fallback_bind", async () => {
    const adapter = make();
    mkdirSync(adapter.place.runDir, { recursive: true, mode: 0o700 });
    const all = sessionSocketCandidates(adapter.place, ID, { tmpDir: tmpA, systemTmp: tmpB });
    expect(all.map((c) => c.kind)).toEqual(["run", "tmpdir", "tmp"]);
    // each place by itself, as the candidates of a run folder or a $TMPDIR that is too long would leave it
    for (const candidate of all) {
      const bound = await bindSessionSocket(
        all.filter((c) => all.indexOf(c) >= all.indexOf(candidate)),
        uid,
      );
      expect(bound.kind).toBe(candidate.kind);
      expect(bound.path).toBe(candidate.path);
      // tA_pty_socket_modes: the socket is 0600 in a folder that is 0700
      expect(lstatSync(bound.path).isSocket()).toBe(true);
      expect(lstatSync(bound.path).mode & 0o777).toBe(0o600);
      expect(lstatSync(candidate.dir).mode & 0o777).toBe(0o700);
      expect(sessionSocketProblem(bound.path, adapter.place, ID)).toBeUndefined();
      bound.close();
      bound.close();
      expect(existsSync(bound.path)).toBe(false);
    }
    // a temporary root that is not there is passed over
    const gone = sessionSocketCandidates(adapter.place, ID, {
      tmpDir: join(tmpA, "missing"),
      systemTmp: tmpB,
    }).slice(1);
    const bound = await bindSessionSocket(gone, uid);
    expect(bound.kind).toBe("tmp");
    bound.close();
    expect(bindSessionSocket([], uid)).rejects.toThrow("short enough");
  });

  socketTest(
    "tA_bye_flushed_before_holder_ends: the bound socket waits for a client that reads late",
    async () => {
      const dir = shortDir("kd-flush-");
      made.push(dir);
      const bound = await bindSessionSocket([{ kind: "run", dir, path: join(dir, "f.sock") }], uid);
      // nobody is connected: nothing to wait for
      const began = Date.now();
      await bound.flushed(5_000);
      expect(Date.now() - began).toBeLessThan(1_000);
      const size = 8 * 1024 * 1024;
      const streams: { close(): void }[] = [];
      bound.onClient((stream) => {
        stream.write(new Uint8Array(size).fill(120));
        stream.write(new TextEncoder().encode("END"));
        streams.push(stream);
      });
      const client = createConnection(bound.path);
      let got = 0;
      let last = "";
      client.on("data", (chunk: Buffer) => {
        got += chunk.length;
        last = (last + chunk.subarray(-3).toString("latin1")).slice(-3);
      });
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      await new Promise((r) => setTimeout(r, 100));
      expect(streams.length).toBe(1);
      // a client that stays connected is waited for, but not longer than the bound
      const waited = Date.now();
      await bound.flushed(200);
      expect(Date.now() - waited).toBeGreaterThanOrEqual(150);
      expect(Date.now() - waited).toBeLessThan(2_000);
      // closed by the holder: the wait ends when the connection is closed, and everything queued arrived by then
      bound.close();
      for (const stream of streams) stream.close();
      await bound.flushed(10_000);
      expect(got).toBe(size + 3);
      expect(last).toBe("END");
      client.destroy();
    },
  );
});

describe("pipes adapter, terminal sessions without a terminal", () => {
  test("tA_capabilities_follow_probe", () => {
    expect(make().capabilities()).toEqual({
      pty: false,
      send: true,
      attach: false,
      lastOutputAt: true,
      streams: true,
    });
    expect(make({ ptyProbe: () => ({ ok: true }) }).capabilities()).toMatchObject({
      pty: true,
      attach: true,
      streams: true,
    });
    expect(
      make({ ptyProbe: () => ({ ok: false, reason: "no module" }) }).capabilities(),
    ).toMatchObject({ pty: false, attach: false });
    const throwing = make({
      ptyProbe: () => {
        throw new Error("probe broke");
      },
    });
    expect(throwing.capabilities()).toMatchObject({ pty: false, attach: false });
  });

  test("tA_pty_start_refused_by_probe_writes_nothing", async () => {
    const reason = "the optional package @lydell/node-pty is not installed";
    for (const adapter of [make(), make({ ptyProbe: () => ({ ok: false, reason }) })]) {
      const error = await adapter
        .start({ argv: ["true"], cwd: root, mode: "pty", name: "term" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).code).toBe("UNSUPPORTED");
      if (adapter.capabilities().pty === false && adapter !== undefined) {
        expect((error as SessionError).message.length).toBeGreaterThan(0);
      }
      // nothing was written: no run folder, no name marker
      expect(existsSync(join(base, "run"))).toBe(false);
    }
    const withReason = await make({ ptyProbe: () => ({ ok: false, reason }) })
      .start({ argv: ["true"], cwd: root, mode: "pty" })
      .catch((e: unknown) => e as SessionError);
    expect((withReason as SessionError).message).toBe(reason);
  });

  test("tA_session_record_has_no_size", async () => {
    let stored: Record<string, unknown> = {};
    const adapter = make({
      ptyProbe: () => ({ ok: true }),
      testHooks: {
        afterPublish(id) {
          stored = JSON.parse(
            readFileSync(join(sessionDirOf(adapter.place, id), "session.json"), "utf8"),
          );
          throw new Error("stop here");
        },
      },
    });
    await adapter
      .start({
        argv: ["true"],
        cwd: root,
        mode: "pty",
        size: { cols: 132, rows: 43 },
        env: { SECRET: "x" },
      })
      .catch(() => {});
    const spec = stored.spec as Record<string, unknown>;
    expect("size" in spec).toBe(false);
    expect("env" in spec).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("132");
    expect(spec.envNames).toEqual(["SECRET"]);
  });

  test("tA_session_record_mode_follows_spec", async () => {
    const seen: unknown[] = [];
    const adapter = make({
      ptyProbe: () => ({ ok: true }),
      testHooks: {
        afterPublish(id) {
          const record = JSON.parse(
            readFileSync(join(sessionDirOf(adapter.place, id), "session.json"), "utf8"),
          ) as { mode: string; spec: { mode?: string } };
          seen.push([record.mode, record.spec.mode]);
          throw new Error("stop here");
        },
      },
    });
    await adapter.start({ argv: ["true"], cwd: root, mode: "pty" }).catch(() => {});
    await adapter.start({ argv: ["true"], cwd: root, mode: "pipes" }).catch(() => {});
    await adapter.start({ argv: ["true"], cwd: root }).catch(() => {});
    expect(seen).toEqual([
      ["pty", "pty"],
      ["pipes", "pipes"],
      ["pipes", undefined],
    ]);
  });

  test("tA_pty_holder_load_failure_after_probe: the probe passes, the holder cannot load", async () => {
    // The holder entry of this package is given no module, as a holder whose package was removed in between.
    const adapter = make({ ptyProbe: () => ({ ok: true }) });
    for (let round = 0; round < 2; round++) {
      const error = await adapter
        .start({
          argv: ["sh", "-c", `touch ${join(root, "ran")}`],
          cwd: root,
          mode: "pty",
          name: "term",
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(SessionError);
      // the second round gets the same answer: the name was freed, not left "used"
      expect((error as SessionError).code).toBe("HOLDER_BOOT_FAILED");
      expect((error as SessionError).message).toContain("no terminal module");
    }
    expect(existsSync(join(root, "ran"))).toBe(false);
    expect(await adapter.list()).toEqual([]);
  });

  test("tA_pipes_work_without_pty", async () => {
    const adapter = make({ ptyProbe: () => ({ ok: false, reason: "absent" }) });
    const { id } = await adapter.start({
      argv: ["sh", "-c", "echo piped"],
      cwd: root,
      timeoutMs: 20_000,
    });
    expect(await adapter.wait(id, { timeoutMs: 15_000 })).toMatchObject({
      state: "exited",
      exitCode: 0,
    });
    expect((await adapter.tail(id)).text).toContain("piped");
    expect((await adapter.tail(id, 1024, "stdout")).text).toContain("piped");
    await adapter.remove(id);
  });
});

describe("attach through the adapter", () => {
  const countingConnect = () => {
    const calls: string[] = [];
    const connect = (path: string): Promise<Socket> => {
      calls.push(path);
      return Promise.reject(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      );
    };
    return { calls, connect };
  };

  test("tA_attach_asks_status_before_connect", async () => {
    const counting = countingConnect();
    const adapter = make({
      socket: { connect: counting.connect, problem: () => undefined },
    });
    const sock = primaryOf(adapter);
    const rows: [string, Partial<StatusRecord> & { state: StatusRecord["state"] }][] = [
      ["a_000000000_0001", { state: "exited", exitCode: 0, sock }],
      ["a_000000000_0002", { state: "killed", reason: "stopped", sock }],
      ["a_000000000_0003", { state: "killed", reason: "holder_error", sock }],
      // `running` in the record, but its holder is gone
      ["a_000000000_0004", { state: "running", sock, ...dead() }],
      ["a_000000000_0005", { state: "starting", sock, ...dead() }],
    ];
    for (const [id, status] of rows) {
      forge(adapter, id, "pty", status);
      const reason = await notAttachable(adapter, id);
      expect(reason, id).toContain(`session ${id} is `);
    }
    // the record alone never led to a connect
    expect(counting.calls).toEqual([]);
    // a session that does not exist is not "not attachable": it is not found
    expect(adapter.attachable("a_000000000_0009")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("tA_attachable_false_for_pipes_with_reason", async () => {
    const counting = countingConnect();
    const adapter = make({ socket: { connect: counting.connect, problem: () => undefined } });
    forge(adapter, ID, "pipes", { state: "running", ...alive() });
    const reason = await notAttachable(adapter, ID);
    expect(reason).toContain("runs on pipes");
    expect(counting.calls).toEqual([]);
  });

  tableTest("tA_attach_connect_error_mapped", async () => {
    for (const code of ["ECONNREFUSED", "ENOENT", "EACCES"]) {
      const calls: string[] = [];
      const adapter = make({
        socket: {
          problem: () => undefined,
          connect: (path) => {
            calls.push(path);
            return Promise.reject(Object.assign(new Error(`connect ${code}`), { code }));
          },
        },
      });
      const id = `a_000000000_${code.toLowerCase().slice(0, 4)}`;
      const sock = primaryOf(adapter, id);
      forge(adapter, id, "pty", { state: "running", sock, ...alive() });
      expect(await adapter.status(id)).toMatchObject({ state: "running" });
      const reason = await notAttachable(adapter, id);
      expect(reason).toContain("does not listen");
      expect(reason).toContain(code);
      // attachable and attach each tried once, at the recorded path
      expect(calls).toEqual([sock, sock]);
      expect(adapter.send(id, "text")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    }
  });

  tableTest("tA_pty_socket_missing_not_attachable", async () => {
    const adapter = make();
    const sock = primaryOf(adapter);
    forge(adapter, ID, "pty", { state: "running", sock, ...alive() });
    // the holder is alive, the socket file is gone (a cleaner of temporary files took it)
    expect(await notAttachable(adapter, ID)).toContain("does not exist");
    // a path in the record that is not this session's is never connected to
    const counting = countingConnect();
    const other = make({ socket: { connect: counting.connect } });
    for (const forged of [
      "/etc/passwd",
      join(other.place.runDir, "x.sock"),
      primaryOf(other, "a_000000000_0001"),
    ]) {
      replaceRecord(
        join(sessionDirOf(other.place, ID), "status.json"),
        encodeRecord("status", {
          v: 1,
          by: "holder",
          since: 1,
          state: "running",
          sock: forged,
          ...alive(),
        }),
      );
      expect(await notAttachable(other, ID)).toContain("is not a socket path of session");
    }
    expect(counting.calls).toEqual([]);
  });

  tableTest(
    "tA_status_sock_dropped_reencode_same_status: attachable says the record names no socket",
    async () => {
      const adapter = make();
      const dir = forge(adapter, ID, "pty", {
        state: "running",
        sock: primaryOf(adapter),
        ...alive(),
      });
      const before = await adapter.status(ID);
      expect(before).toMatchObject({ state: "running" });
      // with the field the record does name a socket: the answer is about that socket
      expect(await notAttachable(adapter, ID)).not.toBe("the record names no socket");
      // An older build reads the record and writes it back: its schema has no `sock`, so the field is gone.
      const file = join(dir, "status.json");
      const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const older = statusRecordSchema.omit({ sock: true }).strip().parse(stored);
      expect("sock" in stored && !("sock" in older)).toBe(true);
      replaceRecord(file, `${JSON.stringify(older)}\n`);
      expect(await adapter.status(ID)).toEqual(before);
      expect(await notAttachable(adapter, ID)).toBe("the record names no socket");
    },
  );

  test("tA_pty_tail_one_stream_unsupported", async () => {
    const adapter = make();
    const dir = forge(adapter, ID, "pty", { state: "exited", exitCode: 0 });
    writeFileSync(join(dir, "tail.txt"), "the one stream\n");
    expect((await adapter.tail(ID)).text).toBe("the one stream\n");
    for (const stream of ["stdout", "stderr"] as const) {
      expect(adapter.tail(ID, 1024, stream)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    }
  });

  socketTableTest("tA_pty_send_enter_own_write: send and attach over the socket", async () => {
    const adapter = make();
    forge(adapter, ID, "pty");
    const bound = await bindSessionSocket(
      sessionSocketCandidates(adapter.place, ID, { tmpDir: tmpA, systemTmp: tmpB }),
      uid,
    );
    const server = new AttachServer();
    const child = new FakeChild();
    server.setChild(child);
    bound.onClient((stream) => server.accept(stream));
    try {
      replaceRecord(
        join(sessionDirOf(adapter.place, ID), "status.json"),
        encodeRecord("status", {
          v: 1,
          by: "holder",
          since: 1,
          state: "running",
          sock: bound.path,
          ...alive(),
        }),
      );
      expect(await adapter.attachable(ID)).toEqual({ ok: true });
      child.emit("\u001b[?2004h");
      const sent = await adapter.send(ID, "hello");
      expect(child.writes).toEqual(["\u001b[200~hello\u001b[201~", "\r"]);
      expect(sent.bytes).toBe("\u001b[200~hello\u001b[201~\r".length);
      expect(child.resizes).toEqual([]);
      expect((await adapter.send(ID, "no enter", { submit: false })).bytes).toBe(
        "\u001b[200~no enter\u001b[201~".length,
      );
      expect(child.writes.at(-1)).toBe("\u001b[200~no enter\u001b[201~");

      const client = new TestClient(await adapter.attach(ID));
      client.hello({ cols: 100, rows: 30 });
      const until = Date.now() + 5_000;
      while (client.welcome === undefined && Date.now() < until)
        await new Promise((r) => setTimeout(r, 5));
      expect(client.welcome).toEqual({ cols: 100, rows: 30 });
      child.emit("live");
      client.input("typed");
      while (
        !(client.output.endsWith("live") && child.writes.at(-1) === "typed") &&
        Date.now() < until
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.output.endsWith("live")).toBe(true);
      expect(child.writes.at(-1)).toBe("typed");
      server.end({ reason: "exited", exitCode: 0 });
      while (!client.closed && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
      expect(client.bye).toEqual({ reason: "exited", exitCode: 0 });
    } finally {
      server.end({ reason: "killed" });
      bound.close();
    }
  });
});

describe("the sweep of leftover sockets", () => {
  socketTest("tA_rm_unlinks_only_derived_sock", async () => {
    const adapter = make();
    // the holder ran under another $TMPDIR and was killed: its socket is in a folder this process would not derive
    const elsewhere = shortDir("kd-tc-");
    made.push(elsewhere);
    const names = socketNames({ checkoutKey: adapter.place.key, id: ID, hash: socketHash });
    const folder = join(elsewhere, `kodel-${uid}`);
    mkdirSync(folder, { mode: 0o700 });
    const stored = join(folder, names.hashed);
    await staleSocket(stored);
    forge(adapter, ID, "pty", { state: "running", sock: stored, ...dead() });
    await adapter.remove(ID);
    expect(existsSync(sessionDirOf(adapter.place, ID))).toBe(false);
    expect(existsSync(stored)).toBe(false);

    // a record that names a socket that is not this session's: the folder goes, that socket stays
    const forged = [join(folder, "victim.sock"), join(adapter.place.runDir, "victim.sock")];
    for (const [index, path] of forged.entries()) {
      const id = `a_000000000_001${index}`;
      await staleSocket(path);
      forge(adapter, id, "pty", { state: "running", sock: path, ...dead() });
      await adapter.remove(id);
      expect(existsSync(sessionDirOf(adapter.place, id))).toBe(false);
      expect(existsSync(path)).toBe(true);
    }
    // a socket somebody listens on is never removed, even at the derived path
    const live = primaryOf(adapter, "a_000000000_0020");
    const server = await liveSocket(live);
    try {
      expect(await sweepSessionSockets(adapter.place, "a_000000000_0020")).toEqual([]);
      expect(existsSync(live)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  socketTest("tA_rm_sweeps_starting_without_sock", async () => {
    const adapter = make();
    // killed between `listen` and the `running` record: `starting`, no `sock`, a socket at the derived path
    forge(adapter, ID, "pty", { state: "starting", ...dead() });
    const path = primaryOf(adapter);
    await staleSocket(path);
    await adapter.remove(ID);
    expect(existsSync(path)).toBe(false);
    // and with the socket in a fallback folder
    const fallback = sessionSocketCandidates(adapter.place, "a_000000000_0001", {
      tmpDir: tmpA,
      systemTmp: tmpB,
    })[2] as SocketCandidate;
    mkdirSync(fallback.dir, { mode: 0o700 });
    await staleSocket(fallback.path);
    forge(adapter, "a_000000000_0001", "pty", { state: "starting", ...dead() });
    await adapter.remove("a_000000000_0001");
    expect(existsSync(fallback.path)).toBe(false);
  });

  socketTest("tA_rollback_sweeps_derived_sock", async () => {
    const waiting = join(base, "waiting.sock");
    await staleSocket(waiting);
    let path = "";
    const adapter = make({
      ptyProbe: () => ({ ok: true }),
      testHooks: {
        // stands for a holder that bound and was killed before it wrote anything
        afterPublish(id) {
          path = primaryOf(adapter, id);
          renameSync(waiting, path);
        },
      },
    });
    const error = await adapter
      .start({ argv: ["true"], cwd: root, mode: "pty" })
      .catch((e: unknown) => e as SessionError);
    expect((error as SessionError).code).toBe("HOLDER_BOOT_FAILED");
    // the folder is gone, so no record names the socket: the derived path is swept all the same
    expect(await adapter.list()).toEqual([]);
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });

  socketTest("tA_stop_sweeps_sock_of_dead_holder", async () => {
    const adapter = make();
    const path = primaryOf(adapter);
    forge(adapter, ID, "pty", { state: "running", sock: path, ...dead() });
    await staleSocket(path);
    const status = await adapter.stop(ID);
    expect(status).toMatchObject({ state: "lost", reason: "holder_gone" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(sessionDirOf(adapter.place, ID))).toBe(true);
  });

  socketTest("tA_rm_leaves_other_checkout_socket", async () => {
    const mine = make();
    const otherRoot = shortDir("kd-r2-");
    made.push(otherRoot);
    const theirs = make({ root: otherRoot });
    expect(theirs.place.runDir).toBe(mine.place.runDir);
    // the same id in two checkouts: two socket names, in the run folder and in a fallback folder
    const [minePrimary, , mineTmp] = sessionSocketCandidates(mine.place, ID, {
      tmpDir: tmpA,
      systemTmp: tmpB,
    });
    const [theirPrimary, , theirTmp] = sessionSocketCandidates(theirs.place, ID, {
      tmpDir: tmpA,
      systemTmp: tmpB,
    });
    expect(minePrimary?.path).not.toBe(theirPrimary?.path);
    expect(mineTmp?.path).not.toBe(theirTmp?.path);
    mkdirSync(mine.place.runDir, { recursive: true, mode: 0o700 });
    mkdirSync((mineTmp as SocketCandidate).dir, { mode: 0o700 });
    for (const c of [minePrimary, mineTmp, theirPrimary, theirTmp])
      await staleSocket((c as SocketCandidate).path);
    // their record even names my socket: it is not theirs to unlink or to connect to
    forge(theirs, ID, "pty", {
      state: "running",
      sock: (minePrimary as SocketCandidate).path,
      ...dead(),
    });
    expect(sessionSocketProblem((minePrimary as SocketCandidate).path, theirs.place, ID)).toContain(
      "is not a socket path of session",
    );
    await theirs.remove(ID);
    expect(existsSync((theirPrimary as SocketCandidate).path)).toBe(false);
    expect(existsSync((theirTmp as SocketCandidate).path)).toBe(false);
    expect(existsSync((minePrimary as SocketCandidate).path)).toBe(true);
    expect(existsSync((mineTmp as SocketCandidate).path)).toBe(true);
  });
});
