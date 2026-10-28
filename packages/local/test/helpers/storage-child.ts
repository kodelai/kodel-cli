/**
 * A child process of `storage-processes.test.ts`: it takes part in a race with another process.
 *
 *   bun storage-child.ts start  <root> <base> <hashes> <go file> <ready file> <task>
 *   bun storage-child.ts ensure <root> <base> <hashes> <go file> <ready file>
 *
 * It says it is ready (the ready file), waits until the go file exists (so that both processes
 * begin together), does its one thing and prints a line of JSON.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePlace, LocalPipelineHost, resolveStoragePlace } from "../../src";

const [mode, root, base, hashes, goFile, readyFile, task] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string | undefined,
];

const place = await resolveStoragePlace({
  root,
  dataDir: join(root, ".kodel"),
  env: { KODEL_STATE_DIR: base },
});
writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 2));

if (mode === "start") {
  const host = new LocalPipelineHost({
    root,
    heartbeatMs: 0,
    integrityDir: hashes,
    storage: place,
  });
  const { run, status } = await host.start({
    pipeline: "demo",
    task: task ?? "t",
    restart: false,
  });
  console.log(JSON.stringify({ runId: run.runId, status }));
} else {
  await ensurePlace(place);
  console.log(JSON.stringify({ ensured: place.tree }));
}
