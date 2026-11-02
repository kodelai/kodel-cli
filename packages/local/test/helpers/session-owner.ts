// A consumer process for the tests: it starts a named session, prints "started", and then idles until it is killed.
import { join } from "node:path";
import { PipesSessionAdapter } from "../../src/session-pipes";

const [base, root, name, counter] = process.argv.slice(2) as [string, string, string, string];
const entry = join(import.meta.dir, "../../src/session-holder-entry.ts");
const adapter = new PipesSessionAdapter({
  base,
  root,
  holder: { exec: process.execPath, args: [entry, "holder"] },
  intermediate: { exec: process.execPath, args: [entry] },
});
const { id } = await adapter.start({
  argv: ["sh", "-c", `sleep 1; echo x >> ${counter}`],
  cwd: root,
  name,
  timeoutMs: 30_000,
});
process.stdout.write(`started ${id}\n`);
setInterval(() => {}, 1 << 30);
