// Runs `bun test` as several processes at once. One process runs the files one after another, and the
// suite is mostly waiting for child processes, so each worker runs one file at a time from a shared queue.
// Every process gets its own state directory from scripts/test-setup.ts, so the workers share nothing.
// With a file or a name filter (`bun run test packages/cli`) it is a plain `bun test`.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("-"));

if (flags.length !== args.length) {
  const code = await run(args, false, undefined);
  process.exit(code.code);
}

function testFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (/\.test\.ts$/.test(entry.name)) found.push(path);
  }
  return found;
}

function run(extra, quiet, tmp) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["test", ...extra], {
      cwd: root,
      // a test that lists the temporary directory must not see the files of a test in another process
      env: tmp === undefined ? process.env : { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let out = "";
    child.stdout?.on("data", (c) => {
      out += c;
    });
    child.stderr?.on("data", (c) => {
      out += c;
    });
    child.on("error", (e) => resolve({ code: 1, out: `${out}${e.message}\n` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const files = [...testFiles(join(root, "packages")), ...testFiles(join(root, "tests"))].map(
  (f) => ({
    path: `.${sep}${relative(root, f)}`,
    size: statSync(f).size,
  }),
);

const jobs = Math.max(
  1,
  Number(process.env.KODEL_TEST_JOBS) || Math.min(6, Math.floor(availableParallelism() / 2)),
);
// A file takes as long as it takes, and its size says little about that, so the files are not dealt out
// beforehand: each worker takes the next one when it is free, the biggest first.
const queue = files.sort((a, b) => b.size - a.size).map((f) => f.path);
const results = [];
// Some tests take 3 to 5 seconds alone, which is all the 5 that bun gives one, and take longer when other
// processes are busy; a test that sets its own timeout keeps it.
if (!flags.some((f) => f.startsWith("--timeout"))) flags.push("--timeout", "20000");
const started = Date.now();
await Promise.all(
  Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kodel-test-worker-"));
    try {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
        const r = await run([...flags, file], true, tmp);
        results.push({ file, ...r });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }),
);

const seconds = Math.round((Date.now() - started) / 1000);
const failed = results.filter((r) => r.code !== 0);
for (const r of failed) process.stdout.write(`\n${r.out}`);
console.log(
  failed.length === 0
    ? `all ${results.length} files passed in ${seconds}s`
    : `${failed.length} of ${results.length} files failed: ${failed.map((r) => r.file).join(" ")} (${seconds}s)`,
);
process.exit(failed.length === 0 ? 0 : 1);
