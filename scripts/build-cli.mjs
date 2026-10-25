// Builds the CLI bundles and stamps the commit into them, so a run can say which build served it.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli");

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: cli,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
})();

for (const [entry, out] of [
  ["src/main.ts", "dist/kodel.js"],
  ["src/hook-bin.ts", "dist/kodel-hook.js"],
]) {
  const built = spawnSync(
    "bun",
    [
      "build",
      entry,
      "--target",
      "node",
      "--outfile",
      out,
      "--banner",
      "#!/usr/bin/env node",
      "--define",
      `__KODEL_COMMIT__=${JSON.stringify(commit)}`,
    ],
    { cwd: cli, stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
  chmodSync(join(cli, out), 0o755);
}
