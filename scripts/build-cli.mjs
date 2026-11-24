// Builds the CLI bundles and stamps the commit into them, so a run can say which build served it.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli");

const git = (args) =>
  execFileSync("git", args, { cwd: cli, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// A build from files that are not committed says so, so two different builds do not share a commit.
const commit = (() => {
  try {
    const head = git(["rev-parse", "--short=12", "HEAD"]).trim();
    return git(["status", "--porcelain", "--untracked-files=no"]).trim() === ""
      ? head
      : `${head}-dirty`;
  } catch {
    return "unknown";
  }
})();

// The web UI's page script and styles go inside the CLI, so the package stays one file to run.
const web = (() => {
  const app = join(cli, "src", "web", "app");
  const out = mkdtempSync(join(tmpdir(), "kodel-web-"));
  try {
    const built = spawnSync(
      "bun",
      [
        "build",
        join(app, "main.tsx"),
        "--target",
        "browser",
        "--minify",
        "--outfile",
        join(out, "app.js"),
      ],
      { cwd: cli, stdio: "inherit" },
    );
    if (built.status !== 0) process.exit(built.status ?? 1);
    return JSON.stringify({
      js: readFileSync(join(out, "app.js"), "utf8"),
      css: readFileSync(join(app, "app.css"), "utf8"),
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
})();

for (const [entry, out, extra] of [
  ["src/main.ts", "dist/kodel.js", ["--define", `__KODEL_WEB_APP__=${web}`]],
  ["src/hook-bin.ts", "dist/kodel-hook.js", []],
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
      // The PTY module is native and optional: it stays out of the bundle and is imported when asked for.
      "--external",
      "@lydell/node-pty",
      "--banner",
      "#!/usr/bin/env node",
      "--define",
      `__KODEL_COMMIT__=${JSON.stringify(commit)}`,
      ...extra,
    ],
    { cwd: cli, stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
  chmodSync(join(cli, out), 0o755);
}
