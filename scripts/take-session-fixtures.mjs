// Takes the golden fixtures of the session record format from a real holder (run: bun scripts/take-session-fixtures.mjs).
// Everything that identifies a machine, a person or a moment is masked: ids, pids, paths, times, identity values.
//
// The pipes part runs the holder from source. The terminal part (`*-pty.json`) needs a PTY, which Bun cannot host:
// its holder is the built artifact on Node (`bun run build` first), and it is skipped with a printed reason where
// no terminal can be opened (a failure with KODEL_REQUIRE_PTY=1). Only records are read, never the output.
//
// A golden whose content did not change is not rewritten, so taking the terminal part leaves the others as they are.
// `--check` writes nothing: it takes the records again and fails when one differs from its golden.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frameInput, PipesSessionAdapter } from "../packages/local/src/index.ts";

const check = process.argv.includes("--check");
const required = process.env.KODEL_REQUIRE_PTY === "1";
const entry = new URL("../packages/local/src/session-holder-entry.ts", import.meta.url).pathname;
const artifact = new URL("../packages/cli/dist/kodel.js", import.meta.url).pathname;
const host = new URL("../tests/pty/host.mjs", import.meta.url).pathname;
const out = new URL("../fixtures/session-formats/v1/", import.meta.url).pathname;
const uid = typeof process.getuid === "function" ? process.getuid() : 0;

const temps = [];
const temp = (prefix, under = tmpdir()) => {
  const dir = realpathSync(mkdtempSync(join(under, prefix)));
  temps.push(dir);
  return dir;
};

const maskFor = (adapter, root) => (value) => {
  const text = JSON.stringify(value);
  const masked = text
    // The socket of a terminal session: its folder (the run folder, or `kodel-<uid>` under a temporary root),
    // the id and the hash of the checkout in its name, or the hashed name of a fallback.
    .replace(/"sock":"([^"]*)"/g, (_m, path) => {
      const folder = dirname(path) === adapter.place.runDir ? "/masked/run" : "/masked/tmp/kodel-0";
      const name = /^[0-9a-f]{16}\.sock$/.test(path.slice(dirname(path).length + 1))
        ? "0000000000000000.sock"
        : "a_000000000_0000-00000000.sock";
      return `"sock":"${folder}/${name}"`;
    })
    .replaceAll(adapter.place.dir, "/masked/run")
    .replaceAll(root, "/masked/project")
    .replace(/"a_[0-9a-z]{9}_[0-9a-z]{4}"/g, '"a_000000000_0000"')
    .replace(/"(started|since|at|lastOutputAt)":\d+/g, (_m, k) => `"${k}":1700000000000`)
    .replace(/"pid":\d+/g, '"pid":4242')
    .replace(/"value":"[^"]*"/g, '"value":"MASKED"')
    .replace(/"boot":"[^"]*"/g, '"boot":"MASKED"')
    .replace(/"build":"[^"]*"/g, '"build":"MASKED"')
    .replace(/"machine":"[^"]*"/g, '"machine":"MASKED"');
  return JSON.parse(masked);
};

// What differs from one system to the next and says nothing about the format: whether the machine has an id, how a
// process identity is taken there.
const comparable = (value) =>
  JSON.stringify(value, (key, inner) => {
    if (key === "machine" || key === "boot") return undefined;
    if (key === "method") return "MASKED";
    return inner;
  });

const stale = [];
const written = [];
const put = (name, masked) => {
  const file = join(out, name);
  const golden = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  if (golden !== undefined && comparable(golden) === comparable(masked)) return;
  if (check) stale.push(name);
  else {
    writeFileSync(file, `${JSON.stringify(masked, null, 2)}\n`);
    written.push(name);
  }
};

async function pipesPart() {
  const base = temp("kdjs-fx-base-");
  const root = temp("kdjs-fx-root-");
  const adapter = new PipesSessionAdapter({
    base,
    root,
    holder: { exec: process.execPath, args: [entry, "holder"] },
    intermediate: { exec: process.execPath, args: [entry] },
    pollMs: 50,
  });
  const mask = maskFor(adapter, root);
  const read = (id, file) => JSON.parse(readFileSync(join(adapter.place.dir, id, file), "utf8"));

  const done = await adapter.start({
    argv: ["sh", "-c", "echo hi; exit 0"],
    cwd: root,
    name: "fixture-done",
  });
  await adapter.wait(done.id, { timeoutMs: 15000 });
  put("session.json", mask(read(done.id, "session.json")));
  put("status-exited.json", mask(read(done.id, "status.json")));
  const marker = readdirSync(adapter.place.namesDir)[0];
  put("name.json", mask(JSON.parse(readFileSync(join(adapter.place.namesDir, marker), "utf8"))));

  const live = await adapter.start({ argv: ["sleep", "60"], cwd: root, timeoutMs: 120000 });
  put("status-running.json", mask(read(live.id, "status.json")));
  await adapter.stop(live.id);
  put("status-killed.json", mask(read(live.id, "status.json")));
  put("stop.json", mask(read(live.id, "stop.json")));

  const { statusRecordSchema } = await import("../packages/pipeline-core/src/index.ts");
  // The tombstone a reader writes when no holder ever answered: the same record, written by a reader.
  put(
    "status-lost.json",
    mask({ v: 1, state: "lost", by: "reader", reason: "no_status", since: 1 }),
  );
  statusRecordSchema.parse(read(done.id, "status.json"));
}

/** Why the terminal part cannot be taken here, or `undefined`. */
function ptyProblem() {
  if (process.platform === "win32") return "terminal sessions are not supported on Windows";
  if (!existsSync(artifact)) return "no built artifact: run `bun run build` first";
  const self = spawnSync("node", [host, artifact, "--selftest"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (self.status !== 0) {
    return `a terminal cannot be opened here (${(self.stderr || "no answer").trim().split("\n")[0]})`;
  }
  return undefined;
}

async function ptyPart() {
  // A short base: the socket then sits in the run folder, which is the path the golden shows.
  const top = temp("kd-fx-", existsSync("/tmp") ? "/tmp" : tmpdir());
  const base = join(top, "st");
  const root = join(top, "project");
  mkdirSync(root);
  const holder = { exec: "node", args: [artifact, "session-holder", "holder"] };
  let unstarted;
  const adapter = new PipesSessionAdapter({
    base,
    root,
    holder,
    intermediate: { exec: "node", args: [artifact, "session-holder"] },
    // The adapter runs here, under Bun; the holder it starts is Node, which `ptyProblem` has tried.
    ptyProbe: () => ({ ok: true }),
    pollMs: 50,
    testHooks: {
      afterPublish(id) {
        if (unstarted !== "next") return;
        unstarted = id;
        throw new Error("fixture: the holder is started by hand");
      },
    },
  });
  const mask = maskFor(adapter, root);
  const read = (id, file) => JSON.parse(readFileSync(join(adapter.place.dir, id, file), "utf8"));
  const term = { cwd: root, mode: "pty", size: { cols: 100, rows: 30 } };
  try {
    const live = await adapter.start({
      ...term,
      argv: ["sh", "-c", "read line; exit 0"],
      name: "fixture-pty",
      timeoutMs: 120000,
    });
    put("session-pty.json", mask(read(live.id, "session.json")));
    put("status-running-pty.json", mask(read(live.id, "status.json")));
    await adapter.send(live.id, "end");
    await adapter.wait(live.id, { timeoutMs: 15000 });
    put("status-exited-pty.json", mask(read(live.id, "status.json")));

    // A terminal session a person stopped: the final record keeps the child and says why, and names no socket.
    const stopped = await adapter.start({ ...term, argv: ["sh", "-c", "exec sleep 60"] });
    await adapter.stop(stopped.id);
    await adapter.wait(stopped.id, { timeoutMs: 15000 });
    put("status-stopped-pty.json", mask(read(stopped.id, "status.json")));

    // A holder that could not start the terminal's program. The starter removes such a session at once, so this
    // one holder is run by hand on a published folder: the record is the holder's own, only the removal is left out.
    unstarted = "next";
    await adapter.start({ ...term, argv: ["kodel-fixture-no-such-command"] }).catch(() => {});
    const id = unstarted;
    if (id === "next") {
      throw new Error(
        "status-killed-pty.json cannot be taken: the adapter never published the session whose holder is run by hand (its `afterPublish` hook did not run), so there is no folder to run that holder on",
      );
    }
    spawnSync(holder.exec, holder.args, {
      input: frameInput({
        v: 1,
        dir: join(adapter.place.dir, id),
        argv: ["kodel-fixture-no-such-command"],
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        mode: "pty",
        socket: { runDir: adapter.place.runDir, uid, checkoutKey: adapter.place.key, id },
        graceMs: 5000,
        started: Date.now(),
      }),
      timeout: 20000,
    });
    put("status-killed-pty.json", mask(read(id, "status.json")));
  } finally {
    for (const row of await adapter.list().catch(() => [])) {
      if (row.status.state === "running" || row.status.state === "starting")
        await adapter.stop(row.id).catch(() => {});
    }
  }
}

mkdirSync(out, { recursive: true });
let skipped;
try {
  await pipesPart();
  skipped = ptyProblem();
  if (skipped === undefined) await ptyPart();
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

if (skipped !== undefined) {
  console.log(`the terminal part (*-pty.json) was skipped: ${skipped}`);
  if (required) {
    console.error("KODEL_REQUIRE_PTY=1: a skip is a failure");
    process.exit(1);
  }
}
if (check) {
  if (stale.length > 0) {
    console.error(
      `session fixtures differ from what a holder writes now: ${stale.join(", ")} (take them again: bun scripts/take-session-fixtures.mjs)`,
    );
    process.exit(1);
  }
  console.log(`session fixtures match a real holder (${out})`);
} else {
  console.log(
    written.length === 0
      ? `no fixture changed (${out})`
      : `fixtures written to ${out}: ${written.join(", ")}`,
  );
}
