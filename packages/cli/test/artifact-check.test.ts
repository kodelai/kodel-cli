import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("t5btp_check_artifact_gets_past_the_version_with_a_real_one", () => {
    const result = artifact("0.1.0");
    // It stops later, at the commit the stub does not have; what matters is that the version passed.
    expect(result.stderr).not.toContain("reports version");
    expect(result.stderr).toContain("commit");
  });
});
