// Takes the golden fixtures of the session record format from a real holder (run: bun scripts/take-session-fixtures.mjs).
// Everything that identifies a machine, a person or a moment is masked: ids, pids, paths, times, identity values.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipesSessionAdapter } from "../packages/local/src/index.ts";

const entry = new URL("../packages/local/src/session-holder-entry.ts", import.meta.url).pathname;
const out = new URL("../fixtures/session-formats/v1/", import.meta.url).pathname;
const base = mkdtempSync(join(tmpdir(), "kdjs-fx-base-"));
const root = mkdtempSync(join(tmpdir(), "kdjs-fx-root-"));
const adapter = new PipesSessionAdapter({
  base,
  root,
  holder: { exec: process.execPath, args: [entry, "holder"] },
  intermediate: { exec: process.execPath, args: [entry] },
  pollMs: 50,
});

const read = (id, file) => JSON.parse(readFileSync(join(adapter.place.dir, id, file), "utf8"));
const mask = (value) => {
  const text = JSON.stringify(value);
  const masked = text
    .replaceAll(adapter.place.dir, "/masked/run")
    .replaceAll(root, "/masked/project")
    .replace(/"a_[0-9a-z]{9}_[0-9a-z]{4}"/g, '"a_000000000_0000"')
    .replace(/"(started|since|at|lastOutputAt)":\d+/g, (_m, k) => `"${k}":1700000000000`)
    .replace(/"pid":\d+/g, '"pid":4242')
    .replace(/"value":"[^"]*"/g, '"value":"MASKED"')
    .replace(/"boot":"[^"]*"/g, '"boot":"MASKED"')
    .replace(/"build":"[^"]*"/g, '"build":"MASKED"');
  return JSON.parse(masked);
};
const put = (name, value) =>
  writeFileSync(join(out, name), `${JSON.stringify(mask(value), null, 2)}\n`);

mkdirSync(out, { recursive: true });
try {
  const done = await adapter.start({
    argv: ["sh", "-c", "echo hi; exit 0"],
    cwd: root,
    name: "fixture-done",
  });
  await adapter.wait(done.id, { timeoutMs: 15000 });
  put("session.json", read(done.id, "session.json"));
  put("status-exited.json", read(done.id, "status.json"));
  const marker = readdirSync(adapter.place.namesDir)[0];
  put("name.json", JSON.parse(readFileSync(join(adapter.place.namesDir, marker), "utf8")));

  const live = await adapter.start({ argv: ["sleep", "60"], cwd: root, timeoutMs: 120000 });
  put("status-running.json", read(live.id, "status.json"));
  await adapter.stop(live.id);
  put("status-killed.json", read(live.id, "status.json"));
  put("stop.json", read(live.id, "stop.json"));

  const { statusRecordSchema } = await import("../packages/pipeline-core/src/index.ts");
  // The tombstone a reader writes when no holder ever answered: the same record, written by a reader.
  put("status-lost.json", { v: 1, state: "lost", by: "reader", reason: "no_status", since: 1 });
  statusRecordSchema.parse(read(done.id, "status.json"));
} finally {
  rmSync(base, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
console.log(`fixtures written to ${out}`);
