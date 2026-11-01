/**
 * A fork run on the built binary (T-40). CI runs `bun test` before `bun run build`, so this test
 * builds `packages/cli/dist/kodel.js` itself, then drives the fork of `scripts/check-artifact-fork.mjs`
 * on it: two command branches at the same time, both failing once, the join told of both and
 * restarting them, and `status`/`report` opening the run. The artifact runs under plain Node when a
 * `node` is on the PATH, else under the Bun running the test (CI's `check-artifact.mjs` runs the same
 * fork under Node in any case). The commands are valid in cmd.exe too.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkForkRun, commandsValidInCmd } from "../../scripts/check-artifact-fork.mjs";

const REPO = resolve(import.meta.dir, "..", "..");

/** Plain Node when one is on the PATH: the artifact is shipped for Node, not only for Bun. */
const NODE =
  spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0 ? "node" : undefined;
const ARTIFACT = join(REPO, "packages", "cli", "dist", "kodel.js");

/** The MCP SDK as the CLI package has it (this folder has no dependencies of its own). */
async function sdk(): Promise<{ Client: unknown; StdioClientTransport: unknown }> {
  const require_ = createRequire(join(REPO, "packages", "cli", "package.json"));
  const load = (file: string) =>
    import(pathToFileURL(require_.resolve(`@modelcontextprotocol/sdk/${file}`)).href) as Promise<
      Record<string, unknown>
    >;
  const client = await load("client/index.js");
  const stdio = await load("client/stdio.js");
  return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport };
}

describe("t40 a fork run on the built binary", () => {
  beforeAll(() => {
    const built = spawnSync("bun", ["run", "build"], {
      cwd: REPO,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (built.status !== 0) {
      throw new Error(`the build failed: ${built.stdout}${built.stderr}`);
    }
    if (!existsSync(ARTIFACT)) throw new Error(`the build left no ${ARTIFACT}`);
  }, 120_000);

  test("t40_e2e_fork_run_on_built_binary", async () => {
    const problems: string[] = [];
    const fail = (message: string) => {
      problems.push(message);
      throw new Error(message);
    };
    const { Client, StdioClientTransport } = await sdk();
    const seen = await checkForkRun(ARTIFACT, {
      Client,
      StdioClientTransport,
      fail,
      ...(NODE === undefined ? {} : { runtime: NODE }),
    });
    expect(problems).toEqual([]);
    // the journal of the real run shows the fork, the overlap and the join entered after a failure
    expect(seen.events).toContain("fork_started");
    expect(seen.events.filter((e) => e === "branch_settled")).toHaveLength(4);
    expect(seen.events.filter((e) => e === "join_reached")).toHaveLength(2);
    // the join was told of both failures by a host that read the state back from disk
    expect(seen.joinFeedback).toContain('"verify" failed');
    expect(seen.joinFeedback).toContain('"test" failed');
    const entered = seen.journal
      .filter((r) => r.event === "node_entered")
      .map((r) => [r.node, r.branch]);
    expect(entered).toEqual([
      ["impl", undefined],
      ["verify", "verify"],
      ["test", "test"],
      ["fix", undefined],
      ["verify", "verify"],
      ["test", "test"],
      ["fix", undefined],
    ]);
    // the report of the run, from the binary's own `report --json`
    // the failed branches were redone and passed: the run does not stand on them
    expect(seen.report.failed_branches).toBe(false);
    expect(seen.report.forks[0]?.failed).toEqual([]);
    expect(seen.report.critical_path).toEqual([
      expect.objectContaining({ fork: "f1", branch: "verify" }),
    ]);
    expect(seen.report.forks[0]?.overlaps).toHaveLength(1);
    expect(seen.status).toContain("status:    completed\n");
  }, 120_000);

  test("t40_e2e_commands_valid_in_cmd", () => {
    expect(commandsValidInCmd()).toBe(true);
  });
});
