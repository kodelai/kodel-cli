import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkForkRun, commandsValidInCmd } from "../../../scripts/check-artifact-fork.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repo, "scripts", "check-artifact.mjs");

let tree: string;
beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "kodel-artifact-check-"));
  mkdirSync(join(tree, "scripts"));
  cpSync(script, join(tree, "scripts", "check-artifact.mjs"));
  cpSync(
    join(repo, "scripts", "check-artifact-fork.mjs"),
    join(tree, "scripts", "check-artifact-fork.mjs"),
  );
  mkdirSync(join(tree, "packages", "cli", "dist"), { recursive: true });
});
afterEach(() => rmSync(tree, { recursive: true, force: true }));

const artifact = (version: string) => {
  writeFileSync(
    join(tree, "packages", "cli", "package.json"),
    JSON.stringify({ name: "kodel", version }),
  );
  writeFileSync(
    join(tree, "packages", "cli", "dist", "kodel.js"),
    `if (process.argv.includes("--version")) console.log(${JSON.stringify(version)});\n`,
  );
  return spawnSync(process.execPath, [join(tree, "scripts", "check-artifact.mjs")], {
    encoding: "utf8",
  });
};

describe("the artifact check", () => {
  test("t5btp_check_artifact_fails_on_version_0_0_0", () => {
    const result = artifact("0.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.0.0");
  });

  test("t40_check_artifact_opens_fork_run", async () => {
    // The fork check of the script, on a stand-in for the artifact: a file node runs that hands the
    // arguments to the CLI's source under bun. It drives the fork run through MCP and opens it with
    // `status` and `report`, as the script does on the built file.
    const fake = join(tree, "fake-kodel.mjs");
    const main = join(repo, "packages", "cli", "src", "main.ts").replaceAll("\\", "/");
    writeFileSync(
      fake,
      [
        'import { spawn } from "node:child_process";',
        `const child = spawn("bun", [${JSON.stringify(main)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
        'child.on("exit", (code) => process.exit(code ?? 1));',
        "",
      ].join("\n"),
    );
    const problems: string[] = [];
    const fail = (message: string) => {
      problems.push(message);
      throw new Error(message);
    };
    const seen = await checkForkRun(fake, { Client, StdioClientTransport, fail });
    expect(problems).toEqual([]);
    expect(seen.events).toContain("fork_started");
    expect(seen.events.filter((e) => e === "join_reached")).toHaveLength(2);
    // both failed branches named to the join by the host, which read the state back from disk
    expect(seen.joinFeedback).toMatch(
      /^Branches of the fork failed: "verify" failed \(command\): .*; "test" failed \(command\): /,
    );
    expect(seen.report.failed_branches).toBe(false);
    expect(seen.report.critical_path[0]?.fork).toBe("f1");
    expect(seen.status).toContain("status:    completed\n");
  }, 60_000);

  test("t40_e2e_commands_valid_in_cmd", () => {
    // the commands the fork check runs would be read the same by cmd.exe: `node -e` with double
    // quotes, nothing a shell would interpret
    expect(commandsValidInCmd()).toBe(true);
    expect(commandsValidInCmd("  command: npm test && npm run lint\n")).toBe(false);
    expect(commandsValidInCmd("  command: echo 'hi' > out\n")).toBe(false);
  });

  test("tA_check_artifact_bundled_module_names_are_real: each name the check looks for is in the module, and in no source of kodel", () => {
    const text = readFileSync(script, "utf8");
    const list = /for \(const inside of \[([^\]]+)\]\)/.exec(text)?.[1] ?? "";
    const names = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(names.length).toBeGreaterThanOrEqual(3);
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === "node_modules"
            ? []
            : sources(join(dir, entry.name))
          : /\.(ts|js|mjs)$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const read = (files: string[]): string =>
      files.map((file) => readFileSync(file, "utf8")).join("\n");
    // a name of kodel's own would fail the check of every build
    const own = read(
      ["cli", "local", "pipeline-core"].flatMap((name) =>
        sources(join(repo, "packages", name, "src")),
      ),
    );
    for (const name of names) expect(own.includes(name), name).toBe(false);
    const module = join(repo, "packages", "cli", "node_modules", "@lydell", "node-pty");
    if (!existsSync(module)) {
      console.log("the names are not compared with the module: @lydell/node-pty is not installed");
      return;
    }
    // a name the module does not have could never show that it was bundled
    const theirs = read(sources(module));
    for (const name of names) expect(theirs.includes(name), name).toBe(true);
  });

  test("tA_check_pty_artifact_keeps_installers_out_of_home: pnpm's cache and state go to the temporary folder", () => {
    const text = readFileSync(join(repo, "scripts", "check-pty-artifact.mjs"), "utf8");
    const env = /const env = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
    for (const key of [
      "npm_config_cache",
      "BUN_INSTALL",
      "PNPM_HOME",
      "npm_config_store_dir",
      "npm_config_cache_dir",
      "npm_config_state_dir",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(new RegExp(`\\b${key}: join\\(cache, `).test(env), key).toBe(true);
    }
  });

  test("t5btp_check_artifact_gets_past_the_version_with_a_real_one", () => {
    const result = artifact("0.1.0");
    // It stops later, at the commit the stub does not have; what matters is that the version passed.
    expect(result.stderr).not.toContain("reports version");
    expect(result.stderr).toContain("commit");
  });
});
