// Verifies that the packed CLI brings a working PTY module with every installer a person may use, and that an
// install without optional dependencies leaves every other command working (TASK-HN8N, packaging).
// Run it after `bun run build`. With KODEL_REQUIRE_PTY=1 (the CI job) a missing installer or a terminal that
// cannot be opened is a failure; without it they are skipped, each with a printed line.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPtyFrom, openTerminal } from "../tests/pty/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli");
const pkg = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
const PTY_MODULE = "@lydell/node-pty";
const required = process.env.KODEL_REQUIRE_PTY === "1";

// `--stop <bin> <packageDir> <projectDir> <id>`: this script again, as the process its own exit handler runs.
// `agent stop` asks a person at a terminal, so it gets one here and the answer is typed into it.
if (process.argv[2] === "--stop") {
  const [bin, packageDir, dir, id] = process.argv.slice(3);
  const term = openTerminal(loadPtyFrom(join(realpathSync(packageDir), "package.json")), {
    file: bin,
    args: ["agent", "stop", id],
    cwd: dir,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  let shown = "";
  let answered = false;
  term.onData((data) => {
    shown += data.toString("latin1");
    if (answered || !shown.includes("Stop agent")) return;
    answered = true;
    term.write("y\r");
  });
  term.onExit(({ exitCode }) => process.exit(exitCode));
  setTimeout(() => process.exit(1), 15_000);
  await new Promise(() => {});
}

const temps = [];
// A holder whose state folder is too deep for a socket path binds in `kodel-<uid>` under the temporary folder
// and leaves that folder there. The ones this run made are removed on the way out, and only while empty:
// one that was there before, or that holds the socket of somebody's session, stays.
const socketDirs = [process.env.TMPDIR, "/tmp"]
  .filter((dir) => dir !== undefined && dir !== "")
  .map((dir) => join(dir, `kodel-${process.getuid?.() ?? 0}`))
  .filter((dir) => !existsSync(dir));
/** The smoke session while it may still run: a check that fails partway must not leave its holder and child. */
let left;
process.on("exit", () => {
  if (left !== undefined) {
    // Best effort, and before the state folder goes: whatever this does not stop, the holder stops itself
    // when it finds its folder removed.
    try {
      spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--stop", ...left.args], {
        env: left.env,
        stdio: "ignore",
        timeout: 20_000,
      });
    } catch {
      // nothing more can be done on the way out
    }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  for (const dir of socketDirs) {
    try {
      rmdirSync(dir);
    } catch {
      // never made, or not empty
    }
  }
});
const tempDir = (name) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kodel-pty-${name}-`)));
  temps.push(dir);
  return dir;
};

const fail = (msg) => {
  console.error(`pty artifact check failed: ${msg}`);
  process.exit(1);
};
const skipped = [];
const skip = (what, reason) => {
  if (required) fail(`${what}: ${reason} (KODEL_REQUIRE_PTY=1: a skip is a failure)`);
  skipped.push(what);
  console.log(`skipped: ${what}: ${reason}`);
};

if (process.platform === "win32") {
  console.log(
    "pty artifact check: terminal sessions are not supported on Windows, nothing to check",
  );
  process.exit(0);
}
if (pkg.optionalDependencies?.[PTY_MODULE] === undefined)
  fail(`${PTY_MODULE} is not an optional dependency of packages/cli`);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.optionalDependencies[PTY_MODULE]))
  fail(`${PTY_MODULE} must be pinned to one exact version, not a range`);
if (!existsSync(join(cli, "dist", "kodel.js")))
  fail("no built artifact: run `bun run build` first");

// Nothing the installers or kodel write may land in the home of whoever runs the script.
const cache = tempDir("cache");
const env = {
  ...process.env,
  npm_config_cache: join(cache, "npm"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  BUN_INSTALL: join(cache, "bun"),
  BUN_INSTALL_CACHE_DIR: join(cache, "bun-cache"),
  PNPM_HOME: join(cache, "pnpm-home"),
  npm_config_store_dir: join(cache, "pnpm-store"),
  // pnpm keeps a metadata cache and a state file besides its store; without these they go to the home folder.
  npm_config_cache_dir: join(cache, "pnpm-cache"),
  npm_config_state_dir: join(cache, "pnpm-state"),
  XDG_CACHE_HOME: join(cache, "xdg-cache"),
  XDG_STATE_HOME: join(cache, "xdg-state"),
  XDG_DATA_HOME: join(cache, "xdg-data"),
  KODEL_STATE_DIR: tempDir("state"),
};
delete env.KODEL_ENGINE;

const sh = (command, args, cwd, extra = {}) =>
  spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 300_000 });
const has = (command) => sh(command, ["--version"], root).status === 0;
const must = (what, result) => {
  if (result.status !== 0)
    fail(`${what} failed (exit ${result.status}):\n${result.stdout}${result.stderr}`);
  return result;
};

const packDir = tempDir("pack");
const packed = must("npm pack", sh("npm", ["pack", "--json", "--pack-destination", packDir], cli));
const tarball = join(packDir, JSON.parse(packed.stdout)[0].filename);

const answerOf = (what, result) => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`${what}: pty-check printed no answer:\n${result.stdout}${result.stderr}`);
  }
};

/** What every install with optional dependencies must show. `run` starts the installed `kodel`. */
function checkInstalled(what, run, packageDir) {
  must(`${what}: kodel --version`, run(["--version"]));
  if (packageDir !== undefined) {
    // Looked up the way Node does it from the installed package, apart from the loader's own check.
    const from = createRequire(join(realpathSync(packageDir), "package.json"));
    const binary = `${PTY_MODULE}-${process.platform}-${process.arch}`;
    let main;
    try {
      main = createRequire(from.resolve(`${PTY_MODULE}/package.json`));
      main.resolve(`${binary}/pty.node`);
    } catch (error) {
      fail(`${what}: the platform package ${binary} did not arrive: ${error.message}`);
    }
    if (process.platform === "darwin") {
      const helper = main.resolve(`${binary}/spawn-helper`);
      try {
        accessSync(helper, constants.X_OK);
      } catch {
        fail(`${what}: ${helper} is not executable (mode ${statSync(helper).mode.toString(8)})`);
      }
    }
  }
  const probe = run(["pty-check"]);
  const probed = answerOf(what, probe);
  if (probe.status !== 0 || probed.ok !== true)
    fail(`${what}: the installed kodel says a terminal session cannot run: ${probed.reason}`);
  const smoke = run(["pty-check", "--spawn"]);
  const smoked = answerOf(what, smoke);
  if (smoke.status !== 0 || smoked.ok !== true) {
    skip(`${what}: the smoke (sh -c 'stty size' in a terminal)`, smoked.reason ?? "no reason");
    return;
  }
  console.log(`ok: ${what}: platform package present, stty size answered ${smoked.output}`);
}

/**
 * A whole terminal session with the installed kodel, each command in a terminal of the script's own, as a person
 * runs them: start, attach, type, read the echo, detach, attach again and see the earlier output, stop.
 */
async function checkSession(what, bin, packageDir) {
  let pty;
  try {
    pty = loadPtyFrom(join(realpathSync(packageDir), "package.json"));
  } catch (error) {
    return fail(
      `${what}: the PTY module is not found from the installed package: ${error.message}`,
    );
  }
  const dir = project("session");
  mkdirSync(join(dir, ".kodel"));
  writeFileSync(join(dir, ".kodel", "config.yaml"), "version: 1\n");
  const open = (args) => {
    const term = openTerminal(pty, {
      file: bin,
      args,
      cwd: dir,
      env: { ...env, TERM: "xterm-256color" },
    });
    const run = { out: "", code: undefined, type: (text) => term.write(text) };
    term.onData((data) => {
      run.out += data.toString("latin1");
    });
    term.onExit(({ exitCode }) => {
      run.code = exitCode;
    });
    return run;
  };
  const wait = async (run, what2, check, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!check(run)) {
      if (Date.now() > deadline)
        fail(`${what}: ${what2}: not seen in time; the terminal showed ${JSON.stringify(run.out)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const ended = (run) => run.code !== undefined;

  let started;
  try {
    started = open([
      "agent",
      "exec",
      "--pty",
      "--name",
      "smoke",
      "--",
      "sh",
      "-c",
      "echo session-ready; exec cat",
    ]);
  } catch (error) {
    return skip(
      `${what}: the session check`,
      `a terminal cannot be opened here (${error.message})`,
    );
  }
  await wait(started, "agent exec --pty", ended);
  const id = /started (a_[0-9a-z_]+)/.exec(started.out)?.[1];
  if (started.code !== 0 || id === undefined)
    fail(`${what}: agent exec --pty: exit ${started.code}: ${started.out}`);
  left = { args: [bin, packageDir, dir, id], env };

  const first = open(["agent", "attach", "smoke"]);
  // Typed before the client has its terminal in raw mode, the keys would be echoed by that terminal and a
  // Ctrl+\ would end the client with a signal. The replay is written after the switch.
  await wait(first, "the replay of the session's first line", (run) =>
    run.out.includes("session-ready"),
  );
  first.type("ping\r");
  await wait(first, "the echo of what was typed", (run) => /ping\r?\nping/.test(run.out));
  first.type("\u001c");
  await wait(first, "the detach", ended);
  if (first.code !== 0 || !first.out.includes("[detached: smoke]"))
    fail(`${what}: detach: exit ${first.code}: ${JSON.stringify(first.out)}`);
  // the reset comes before the line: bracketed paste and the mouse off, the cursor shown
  const reset = first.out.slice(0, first.out.indexOf("[detached: smoke]"));
  for (const part of ["\u001b[?2004l", "\u001b[?1000l", "\u001b[?25h"]) {
    if (!reset.includes(part))
      fail(`${what}: the reset before the detach line lacks ${JSON.stringify(part)}`);
  }

  const second = open(["agent", "attach", id]);
  await wait(
    second,
    "the replay on the second attach",
    (run) => run.out.includes("session-ready") && /ping\r?\nping/.test(run.out),
  );
  second.type("\u001c");
  await wait(second, "the second detach", ended);
  if (second.code !== 0) fail(`${what}: second detach: exit ${second.code}`);

  const stop = open(["agent", "stop", id]);
  await wait(stop, "the question of agent stop", (run) => run.out.includes("Stop agent"));
  stop.type("y\r");
  await wait(stop, "agent stop", ended);
  if (stop.code !== 0 || !stop.out.includes("stopped"))
    fail(`${what}: agent stop: exit ${stop.code}: ${JSON.stringify(stop.out)}`);
  left = undefined;
  const listed = must(`${what}: agent ls`, sh(bin, ["agent", "ls"], dir));
  if (!/smoke\s+stopped/.test(listed.stdout))
    fail(`${what}: agent ls after the stop: ${listed.stdout}`);
  const gone = open(["agent", "attach", "smoke"]);
  await wait(gone, "the refusal of an ended session", ended);
  if (gone.code !== 1 || !gone.out.includes("NOT_ATTACHABLE"))
    fail(`${what}: attach to an ended session must refuse: ${JSON.stringify(gone.out)}`);
  console.log(`ok: ${what}: start, attach, echo, detach, re-attach with replay, stop, reset`);
}

const project = (name) => {
  const dir = tempDir(name);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pty-check", private: true }));
  return dir;
};
const localBin = (dir) => (args) => sh(join(dir, "node_modules", ".bin", "kodel"), args, dir);
const localPackage = (dir) => join(dir, "node_modules", ...pkg.name.split("/"));

{
  const dir = project("npm");
  must("npm install", sh("npm", ["install", tarball], dir));
  checkInstalled("npm install", localBin(dir), localPackage(dir));
  await checkSession("npm install", join(dir, "node_modules", ".bin", "kodel"), localPackage(dir));
}
{
  const prefix = tempDir("npm-global");
  must("npm install -g", sh("npm", ["install", "-g", "--prefix", prefix, tarball], prefix));
  checkInstalled(
    "npm install -g",
    (args) => sh(join(prefix, "bin", "kodel"), args, prefix),
    join(prefix, "lib", "node_modules", ...pkg.name.split("/")),
  );
}
{
  const dir = tempDir("npx");
  checkInstalled("npx", (args) =>
    sh("npx", ["--yes", "--package", tarball, "kodel", ...args], dir),
  );
}
if (has("bun")) {
  const dir = tempDir("bun-global");
  must("bun install -g", sh("bun", ["install", "-g", tarball], dir));
  // The bin starts Node (its first line), so the module is not hosted by Bun here.
  checkInstalled(
    "bun install -g",
    (args) => sh(join(env.BUN_INSTALL, "bin", "kodel"), args, dir),
    join(env.BUN_INSTALL, "install", "global", "node_modules", ...pkg.name.split("/")),
  );
} else {
  skip("bun install -g", "bun is not on the PATH");
}
if (has("pnpm")) {
  const dir = project("pnpm");
  must("pnpm add", sh("pnpm", ["add", tarball], dir));
  checkInstalled("pnpm add", localBin(dir), localPackage(dir));
} else {
  skip("pnpm add", "pnpm is not on the PATH");
}

// Without optional dependencies: no terminal sessions, said with the reason, and everything else as before.
{
  const dir = project("no-optional");
  must("npm install --omit=optional", sh("npm", ["install", "--omit=optional", tarball], dir));
  // npm leaves the empty scope folder behind, so look for the module and its platform packages, not for the scope.
  const scope = join(dir, "node_modules", "@lydell");
  if (existsSync(scope) && readdirSync(scope).some((name) => name.startsWith("node-pty")))
    fail("npm install --omit=optional installed the PTY module all the same");
  const run = localBin(dir);
  const version = must("without optional: kodel --version", run(["--version"])).stdout.trim();
  if (version !== pkg.version) fail(`without optional: --version printed "${version}"`);
  if (!must("without optional: kodel --help", run(["--help"])).stdout.includes("kodel"))
    fail("without optional: --help does not mention kodel");
  mkdirSync(join(dir, ".kodel"));
  writeFileSync(join(dir, ".kodel", "config.yaml"), "version: 1\n");
  must("without optional: kodel status", run(["status"]));
  const listed = must("without optional: kodel agent ls", run(["agent", "ls"]));
  if (!listed.stdout.includes("no agents")) fail(`without optional: agent ls: ${listed.stdout}`);
  for (const args of [["pty-check"], ["pty-check", "--spawn"]]) {
    const refused = run(args);
    const answer = answerOf("without optional", refused);
    if (refused.status !== 1 || answer.ok !== false || !/not installed/.test(answer.reason ?? ""))
      fail(`without optional: ${args.join(" ")} must refuse with the reason: ${refused.stdout}`);
  }
  console.log(
    "ok: npm install --omit=optional: every other command works, the refusal names the reason",
  );
}

console.log(
  skipped.length === 0
    ? `pty artifact ok under node ${process.version} on ${process.platform}-${process.arch}`
    : `pty artifact checked with ${skipped.length} skipped: ${skipped.join("; ")}`,
);
