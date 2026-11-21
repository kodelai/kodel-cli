/**
 * A child process of `serve-daemon.test.ts`: one of two processes that start tasks on one store.
 *
 *   bun serve-start-child.ts <root> <integrity dir> <records file> <go file> <ready file> <cycles>
 *
 * It says it is ready (the ready file), waits until the go file exists (so that both processes
 * begin together), runs the daemon's cycles on the real local host and tracker, and prints a line
 * of JSON with the runs its launcher started. The worker records are shared through the records
 * file, as `kodel agent ls` shares them between processes, so each daemon counts the other's workers.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedLauncher, type ScriptedRecord } from "../../../testkit/src/scripted-launcher";
import { createServeDaemon, LocalPipelineHost, openTaskService, serveTasksOf } from "../../src";

const [root, integrityDir, recordsFile, goFile, readyFile, cycles] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const host = new LocalPipelineHost({ root, heartbeatMs: 0, integrityDir });
const opened = await openTaskService({ storeRoot: join(root, ".kodel") });
if (!opened) throw new Error("tasks are off");
class SharedLauncher extends ScriptedLauncher {
  private load() {
    let text = "";
    try {
      text = readFileSync(recordsFile, "utf8");
    } catch {
      // no record yet
    }
    const shared = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScriptedRecord);
    this.records.splice(0, this.records.length, ...shared);
  }
  override async start(input: { runId: string; workdir: string; title: string }) {
    this.load();
    const before = this.records.length;
    const out = await super.start(input);
    for (const record of this.records.slice(before)) {
      appendFileSync(recordsFile, `${JSON.stringify(record)}\n`);
    }
    return out;
  }
  override async statuses(runIds: readonly string[]) {
    this.load();
    return super.statuses(runIds);
  }
}
const launcher = new SharedLauncher({ host, now: Date.now });
const lines: string[] = [];
const daemon = createServeDaemon({
  root,
  storeRoot: join(root, ".kodel"),
  host,
  launcher,
  tasks: serveTasksOf(opened.service),
  log: (line) => lines.push(line),
  version: "0.0.0-test",
});

writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 2));

for (let i = 0; i < Number(cycles); i++) await daemon.cycle();
const started = launcher.calls.filter((c) => c.kind === "start").map((c) => c.runId);
console.log(JSON.stringify({ pid: process.pid, started, lines }));
