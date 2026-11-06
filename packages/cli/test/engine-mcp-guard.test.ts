/**
 * `kodel mcp` started inside an engine step's session (T-42) serves no tools: the child of a host session
 * leads its own process group, and a `kodel mcp` its program starts is in it. Outside one it serves them.
 * Real processes: the CLI from source, a holder, an MCP client. Reading a process group needs `ps` or
 * `/proc`; where neither can be read (a sandbox), the guard fails open and these tests are skipped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { insideHostSession, ownProcessGroup, PipesSessionAdapter } from "@kodel-ai/local";

const main = join(import.meta.dir, "../src/main.ts");
const entry = join(import.meta.dir, "../../local/src/session-holder-entry.ts");
const groupReadable = ownProcessGroup() !== undefined;
const real = test.skipIf(
  process.platform === "win32" || (!groupReadable && process.env.KODEL_REQUIRE_PROCTABLE !== "1"),
);
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sdk = createRequire(join(import.meta.dir, "../package.json"));
const sdkUrl = (file: string) =>
  pathToFileURL(sdk.resolve(`@modelcontextprotocol/sdk/${file}`)).href;

/** A client that starts `kodel mcp`, lists its tools and prints how many. */
function writeClient(dir: string): string {
  const path = join(dir, "client.mjs");
  writeFileSync(
    path,
    [
      `const { Client } = await import(${JSON.stringify(sdkUrl("client/index.js"))});`,
      `const { StdioClientTransport } = await import(${JSON.stringify(sdkUrl("client/stdio.js"))});`,
      "const transport = new StdioClientTransport({",
      `  command: ${JSON.stringify(process.execPath)},`,
      `  args: [${JSON.stringify(main)}, "mcp"],`,
      "  cwd: process.argv[2],",
      "  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },",
      "  stderr: 'ignore',",
      "});",
      "const client = new Client({ name: 'guard-test', version: '0' });",
      "await client.connect(transport);",
      "// a server with no tools does not offer the tools capability, and listing them is refused",
      "const offered = client.getServerCapabilities()?.tools !== undefined;",
      "const tools = offered ? (await client.listTools()).tools.length : 0;",
      "process.stdout.write(JSON.stringify({ offered, tools }));",
      "await client.close();",
      "",
    ].join("\n"),
  );
  return path;
}

describe("t42 kodel mcp in an engine step's session", () => {
  test("t42_guard_with_no_session_serves_tools_or_says_why", () => {
    // With no session in the bases it looks in (both are empty folders of this test, so a live session
    // of the machine running the tests does not count), the guard serves the tools: where the group can
    // be read with no reason given, where it cannot (why the real tests below skip) saying so.
    const base = mkdtempSync(join(tmpdir(), "kodel-guard-base-"));
    made.push(base);
    const guard = insideHostSession({ KODEL_ENGINE: "1" }, { base, accountHome: () => base });
    expect(guard.inside).toBe(false);
    if (groupReadable) expect(guard.reason).toBeUndefined();
    else expect(guard.reason).toContain("cannot be read");
  });

  real(
    "t42_kodel_mcp_outside_a_session_serves_tools",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kodel-guard-cli-"));
      made.push(dir);
      const client = writeClient(dir);
      // In a process group of its own, so the test holds even when the tests themselves run inside an
      // engine step's session.
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [client, dir], {
          env: { PATH: process.env.PATH ?? "", HOME: dir },
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.on("error", reject);
        child.on("close", () => {
          clearTimeout(timer);
          resolve(text);
        });
      });
      expect(JSON.parse(out).tools).toBeGreaterThan(0);
    },
    40_000,
  );

  real(
    "t42_kodel_mcp_inside_a_host_session_serves_no_tools",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "kodel-guard-cli-"));
      made.push(dir);
      const client = writeClient(dir);
      // the child's `kodel mcp` finds the sessions under its HOME, as a real one does under the person's
      const adapter = new PipesSessionAdapter({
        base: join(dir, ".kodel"),
        root: dir,
        holder: { exec: process.execPath, args: [entry, "holder"] },
        intermediate: { exec: process.execPath, args: [entry] },
      });
      const { id } = await adapter.start({
        argv: [process.execPath, client, dir],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
        inheritEnv: false,
        timeoutMs: 30_000,
        name: "ke-guard-1-1",
        origin: "host",
      });
      const done = await adapter.wait(id, { timeoutMs: 35_000 });
      expect(done.state).toBe("exited");
      const out = (await adapter.tail(id, 64 * 1024, "stdout")).text;
      expect(JSON.parse(out)).toEqual({ offered: false, tools: 0 });
    },
    40_000,
  );
});
