// Criterion 10, first half: which process the holder's child is, whether the agent and what it starts
// stay in the child's process group, and what the record says when the holder is killed.
//   bun group.ts <trusted cwd> [--stand-in]
// Runs under Bun (the adapter is TypeScript); the holder it starts is the built artifact on Node, as in
// tests/pty/harness.ts. The state base is a folder of its own under /tmp. Nothing of `kodel agent` is run:
// the spike kills the processes it started by pid.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const MAIN = process.env.EKAV_MAIN ?? join(import.meta.dir, "../..");
const ARTIFACT = join(MAIN, "packages/cli/dist/kodel.js");
const { PipesSessionAdapter, sessionDirOf } = await import(
  join(MAIN, "packages/local/src/index.ts")
);
const { agentEnv, uuid } = await import("./lib.mjs");
const { TestClient } = await import(join(MAIN, "packages/local/test/helpers/attach-fakes.ts"));

const cwd = realpathSync(process.argv[2] ?? "/private/tmp");
const top = realpathSync(mkdtempSync("/tmp/ekg-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = (...args: string[]) => {
  try {
    return execFileSync("ps", args, { encoding: "utf8" }).trim();
  } catch (error) {
    return `ps failed: ${(error as Error).message.split("\n")[0]}`;
  }
};
const group = (pgid: number) =>
  ps("-A", "-o", "pid=,ppid=,pgid=,sess=,tty=,lstart=,command=")
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[2]) === pgid)
    .map((line) => line.slice(0, 170));

const adapter = new PipesSessionAdapter({
  base: top,
  root: cwd,
  holder: { exec: "node", args: [ARTIFACT, "session-holder", "holder"] },
  intermediate: { exec: "node", args: [ARTIFACT, "session-holder"] },
  ptyProbe: () => ({ ok: true }),
  pollMs: 25,
});
const mcp = JSON.stringify({
  mcpServers: { kodel: { command: "node", args: ["-e", "setInterval(()=>{},1e9)"] } },
});
// --stand-in: a child that ignores the hangup of its terminal, to see the record of a child that outlives its holder.
const standIn = process.argv.includes("--stand-in");
const started = await adapter.start({
  argv: standIn
    ? ["sh", "-c", "trap '' HUP; while :; do sleep 5; done"]
    : [
        "claude",
        "Reply with the one word: pong",
        "--session-id",
        uuid(),
        "--mcp-config",
        mcp,
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--model",
        "haiku",
      ],
  cwd,
  env: Object.fromEntries(Object.entries(agentEnv()).filter(([k]) => k !== "KODEL_ENGINE")), // the adapter forces it
  inheritEnv: false,
  mode: "pty",
  size: { cols: 120, rows: 40 },
  name: "ekav-spike",
  timeoutMs: 600_000,
});
console.log("started", JSON.stringify(started));
await sleep(8000);
const dir = sessionDirOf(adapter.place, started.id);
const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
const child: number = status.child?.pid;
const holder: number = status.holder?.pid ?? status.holder;
console.log("status.json:", JSON.stringify(status));
console.log(
  "the child:\n",
  ps("-o", "pid=,ppid=,pgid=,sess=,tty=,command=", "-p", String(child)).slice(0, 300),
);
console.log("the group of the child (pid ppid pgid sess tty lstart command):");
for (const line of group(child)) console.log("  ", line);

// A command the person's `!` runs in the agent's shell: where does it land?
try {
  const client = new TestClient(await adapter.attach(started.id)).hello({ cols: 120, rows: 40 });
  await sleep(1000);
  client.input("!sleep 321");
  await sleep(500);
  client.input("\r");
  await sleep(4000);
} catch (error) {
  console.log("no shell command was typed (attach said:", (error as Error).message, ")");
}
const sleepers = () =>
  ps("-A", "-o", "pid=,ppid=,pgid=,tty=,command=")
    .split("\n")
    .filter((line) => /sleep 321/.test(line) && !/ps -A/.test(line))
    .map((line) => line.replace(/source .* eval/, "… eval").slice(0, 120));
console.log("a shell command of the session (`!sleep 321`; pid ppid pgid tty command):");
for (const line of sleepers()) console.log("  ", line);

console.log("\n--- the holder is killed (SIGKILL)", holder);
process.kill(holder, "SIGKILL");
await sleep(1500);
const after = await adapter.status(started.id);
console.log("adapter.status:", JSON.stringify(after));
const listed = (await adapter.list()).find((e: { id: string }) => e.id === started.id);
console.log("adapter.list entry:", JSON.stringify(listed?.status));
console.log("the group now:");
for (const line of group(child)) console.log("  ", line);
console.log("the shell command now:");
for (const line of sleepers()) console.log("  ", line);
await sleep(8000);
console.log("and 8 s later:", JSON.stringify(sleepers()), "group:", JSON.stringify(group(child)));

console.log("\n--- cleanup: the group is ended by pid, by the spike");
for (const line of [...group(child), ...sleepers()]) {
  try {
    process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
  } catch {}
}
await sleep(1000);
console.log("status after the child ended:", JSON.stringify(await adapter.status(started.id)));
console.log("state base (left for a look):", top);
