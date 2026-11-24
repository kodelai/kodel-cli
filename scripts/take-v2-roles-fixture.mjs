// Make the golden runs of run-state format 2 whose records carry the role of the server (5M9D,
// fixtures/formats/v2-roles/), and take them into the repository.
//
//   bun scripts/take-v2-roles-fixture.mjs [--keep]
//
// The servers are real: `kodel mcp` from the TypeScript sources, started as two processes over stdio in a
// scratch git repository, one with no role and one with `--role worker`, each driven by the MCP client. The
// script plays the agent (it calls the tools; the pipeline's steps have no checks, so there are no files to
// write). No `CLAUDE*` variable and no `KODEL_ENGINE` reach the servers: no record names a session, and the
// server with no role is the person's own (under the engine's mark it would be a worker). Then
// `scripts/take-format-fixture.mjs v2-roles <run> <run>` copies the runs and writes `hashes.json`.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The SDK is a dependency of the CLI package, not of the repository root.
const sdk = createRequire(join(root, "packages/cli/package.json"));
const sdkPath = (file) => pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/${file}`)).href;
const { Client } = await import(sdkPath("client/index.js"));
const { StdioClientTransport } = await import(sdkPath("client/stdio.js"));
const main = join(root, "packages", "cli", "src", "main.ts");
const keep = process.argv.includes("--keep");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "kodel-v2-roles-")));
const project = join(scratch, "project");
await mkdir(join(project, ".kodel", "pipelines"), { recursive: true });
await mkdir(join(scratch, "home"), { recursive: true });

await writeFile(
  join(project, ".kodel", "pipelines", "two.yaml"),
  [
    "name: two",
    "description: two steps, worked by servers of two roles",
    "nodes:",
    "  - { slug: write, kind: agent, prompt: write it }",
    "  - { slug: ship, kind: agent, prompt: ship it }",
    "edges:",
    "  - { from: write, to: ship }",
    "",
  ].join("\n"),
);
await writeFile(
  join(project, ".kodel", "config.yaml"),
  // No copy of the agent's log (no agent ran), no usage count and no tool-call rows for the same reason.
  [
    "history:",
    "  agent_log: { enabled: false }",
    "  usage: { enabled: false }",
    "  tool_calls: { enabled: false }",
    "",
  ].join("\n"),
);
await writeFile(join(project, ".gitignore"), ".kodel/runs\n.kodel/worktrees\n");
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "Kodel Fixture");
git("add", "-A");
git("commit", "-q", "-m", "initial");

async function connect(args) {
  const client = new Client({ name: "take-v2-roles-fixture", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [main, "--root", project, "mcp", ...args],
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(scratch, "home"),
        KODEL_STATE_DIR: join(scratch, "state"),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      },
      stderr: "ignore",
    }),
  );
  const call = async (name, input) => {
    const result = await client.callTool({ name, arguments: input });
    const answer = JSON.parse(result.content[0].text);
    if (answer.ok !== true) throw new Error(`${name}: ${answer.code}: ${answer.message}`);
    return answer;
  };
  return { call, close: () => client.close() };
}

// The first run: started by a server with no role, worked to its end by a worker's server.
const person = await connect([]);
const finished = (
  await person.call("pipeline_start", { task: "worked by two roles", pipeline: "two" })
).run_id;
await person.close();
const worker = await connect(["--role", "worker"]);
await worker.call("pipeline_next_step", { run_id: finished });
await worker.call("pipeline_complete_step", { run_id: finished, node_slug: "write", attempt: 1 });
const end = await worker.call("pipeline_complete_step", {
  run_id: finished,
  node_slug: "ship",
  attempt: 1,
});
if (end.next?.done !== true) throw new Error("the first run did not end");
// The second run: started by the worker's server and left open at its first step.
const open = (
  await worker.call("pipeline_start", { task: "left open by a worker", pipeline: "two" })
).run_id;
await worker.close();

const runs = [finished, open].map((id) => join(project, ".kodel", "runs", id));
execFileSync("node", [join(root, "scripts", "take-format-fixture.mjs"), "v2-roles", ...runs], {
  stdio: "inherit",
});
console.log(`the runs ${finished} (finished) and ${open} (open) are in fixtures/formats/v2-roles/`);
if (keep) console.log(`kept: ${scratch}`);
else await rm(scratch, { recursive: true, force: true });
