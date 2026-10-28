/**
 * `scripts/check-prices.mjs`, run as a subprocess on plain Node (the script must not need Bun, dist/ or a build).
 * No test uses the network: pages are saved files or a server on the loopback interface.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePrice, SHIPPED_PRICES } from "@kodel-ai/pipeline-core";
import { projectFolderName } from "../src/history/claude-code/locate";

const root = resolve(import.meta.dir, "..", "..", "..");
const script = join(root, "scripts", "check-prices.mjs");
const pagesDir = join(root, "fixtures", "price-pages");
const PAGE_FILE = "https%3A%2F%2Fdocs.claude.com%2Fen%2Fdocs%2Fabout-claude%2Fpricing.html";

/** Plain Node when there is one (that is what the script is for); the runtime of this test otherwise. */
const NODE = spawnSync("node", ["--version"]).status === 0 ? "node" : process.execPath;

const scratch = mkdtempSync(join(tmpdir(), "check-prices-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}, cwd = root) {
  const result = spawnSync(NODE, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The same, without blocking the event loop, for the tests whose server lives in this process. */
function runAsync(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(NODE, [script, ...args], { cwd: root, env: process.env });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

function pagesWith(edit: (html: string) => string): string {
  const dir = mkdtempSync(join(scratch, "pages-"));
  writeFileSync(join(dir, PAGE_FILE), edit(readFileSync(join(pagesDir, PAGE_FILE), "utf8")));
  return dir;
}

describe("t9jrs check-prices network mode (saved pages)", () => {
  test("t9jrs_check_prices_exit_codes: the saved page agrees with the table, exit 0", () => {
    const { code, out } = run(["--pages", pagesDir]);
    expect(code).toBe(0);
    expect(out).toContain("claude-sonnet-5-5: ok");
  });

  test("t9jrs_check_prices_exit_codes: a changed price is exit 1 and names the model", () => {
    const dir = pagesWith((html) =>
      html.replace(/(<td>Claude Sonnet 5\.5<\/td><td>)\$2 /, "$1$$4 "),
    );
    const { code, out } = run(["--pages", dir]);
    expect(code).toBe(1);
    expect(out).toContain("claude-sonnet-5-5: differs");
  });

  test("t9jrs_check_prices_exit_codes: a model the page no longer names is exit 2 (format changed)", () => {
    const dir = pagesWith((html) => html.replace(/<tr><td>Claude Haiku 5\.5.*\n/, ""));
    const { code, out } = run(["--pages", dir]);
    expect(code).toBe(2);
    expect(out).toContain("claude-haiku-5-5: not found");
  });

  test("t9jrs_check_prices_row_order_does_not_change_the_result: newest first and oldest first agree, exit 0", () => {
    // A name that is the start of a longer one ("Claude Opus 5" and "Claude Opus 5.5") must not take the longer row.
    const reverseRows = (html: string) => {
      const rows = html.match(/<tr><td>.*<\/tr>\n/g) ?? [];
      expect(rows.length).toBeGreaterThan(10);
      return rows
        .reduce((page, row) => page.replace(row, ""), html)
        .replace("</table>", `${[...rows].reverse().join("")}</table>`);
    };
    const newestFirst = run(["--pages", pagesWith(reverseRows)]);
    const oldestFirst = run(["--pages", pagesDir]);
    expect(newestFirst.code).toBe(0);
    expect(oldestFirst.code).toBe(0);
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      expect(newestFirst.out).toContain(`${model}: ok`);
    }
  });

  test("t9jrs_check_prices_row_order_does_not_change_the_result: a changed price of the longer name is not hidden by the shorter", () => {
    const dir = pagesWith((html) => html.replace(/(<td>Claude Opus 5\.5<\/td><td>)\$4 /, "$1$$9 "));
    const { code, out } = run(["--pages", dir]);
    expect(code).toBe(1);
    expect(out).toContain("claude-opus-5-5: differs");
    expect(out).toContain("claude-opus-5: ok");
  });

  test("t9jrs_check_prices_exit_codes: a page that is not there is exit 2", () => {
    const dir = mkdtempSync(join(scratch, "empty-"));
    expect(run(["--pages", dir]).code).toBe(2);
  });

  test("t9jrs_check_prices_exit_codes: a bad argument is exit 2", () => {
    expect(run(["--nope"]).code).toBe(2);
  });

  test("t9jrs_check_prices_reports_unchecked_entries (checkedAt null)", () => {
    const { out } = run(["--pages", pagesDir]);
    expect(out).toContain("not yet checked (checkedAt null)");
    expect(out).toContain("claude-opus-5-5");
  });
});

describe("t9jrs check-prices network mode (loopback server)", () => {
  let server: Server;
  let base: string;
  let mode: "ok" | "error" | "hang" = "ok";
  const sockets = new Set<import("node:net").Socket>();

  beforeAll(async () => {
    server = createServer((_request, response) => {
      if (mode === "hang") return;
      if (mode === "error") {
        response.statusCode = 500;
        response.end("boom");
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(readFileSync(join(pagesDir, PAGE_FILE), "utf8"));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pricing`;
  });
  afterAll(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });

  const tableFile = () => {
    const table = JSON.parse(
      readFileSync(join(root, "packages", "pipeline-core", "src", "price-table.json"), "utf8"),
    );
    for (const list of Object.values(table.models) as { sourceUrl: string }[][])
      for (const entry of list) entry.sourceUrl = base;
    const file = join(scratch, `table-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(table));
    return file;
  };

  test("t9jrs_check_prices_exit_codes: a server that answers with the page is exit 0", async () => {
    mode = "ok";
    expect((await runAsync(["--table", tableFile()])).code).toBe(0);
  });

  test("t9jrs_check_prices_exit_codes: a server that answers 500 is exit 2", async () => {
    mode = "error";
    const { code, out } = await runAsync(["--table", tableFile()]);
    expect(code).toBe(2);
    expect(out).toContain("HTTP 500");
  });

  test("t9jrs_check_prices_exit_codes: a server that never answers is exit 2 within the timeout", async () => {
    mode = "hang";
    const started = Date.now();
    const { code } = await runAsync(["--table", tableFile(), "--timeout-ms", "300"]);
    expect(code).toBe(2);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("t9jrs check-prices --local", () => {
  // sonnet-5-5 is $2 per million input tokens, so one response with 1 000 000 input tokens costs $2.00.
  function project(costStates: object[] | null, withMarker = true) {
    const proj = mkdtempSync(join(scratch, "proj-"));
    if (withMarker) {
      mkdirSync(join(proj, ".kodel"));
      writeFileSync(join(proj, ".kodel", "config.yaml"), "version: 1\n");
    }
    const configDir = mkdtempSync(join(scratch, "claude-"));
    const folder = join(configDir, "projects", projectFolderName(proj));
    mkdirSync(folder, { recursive: true });
    const lines: object[] = [
      {
        type: "user",
        cwd: proj,
        timestamp: "2026-10-27T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        cwd: proj,
        requestId: "req_1",
        timestamp: "2026-10-27T10:00:01.000Z",
        message: {
          id: "msg_1",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 500_000, output_tokens: 0 },
        },
      },
      // A second line of the same response: the later line wins, as the collector folds them.
      {
        type: "assistant",
        cwd: proj,
        requestId: "req_1",
        timestamp: "2026-10-27T10:00:02.000Z",
        message: {
          id: "msg_1",
          model: "claude-sonnet-5-5",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        },
      },
      ...(costStates ?? []),
    ];
    writeFileSync(join(folder, "s1.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return { proj, configDir };
  }
  const state = (total: number, extra: object = {}) => ({
    type: "cost-state",
    totalCostUSD: total,
    ...extra,
  });

  test("t9jrs_check_prices_local_drift_over_10pct: 9.9% is not flagged", () => {
    const { proj, configDir } = project([state(2 / 1.099)]);
    const { code, out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(code).toBe(0);
    expect(out).toContain("compared 1 session(s)");
  });

  test("t9jrs_check_prices_local_drift_over_10pct: 10.1% is flagged, exit 1", () => {
    const { proj, configDir } = project([state(2 / 1.101)]);
    const { code, out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(code).toBe(1);
    expect(out).toContain("s1.jsonl");
  });

  test("t9jrs_check_prices_local_drift_over_10pct: a cost-state with hasUnknownModelCost is skipped", () => {
    const { proj, configDir } = project([state(1, { hasUnknownModelCost: true })]);
    const { code, out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(code).toBe(0);
    expect(out).toContain("compared 0 session(s)");
  });

  test("t9jrs_check_prices_local_drift_over_10pct: models the table lacks are listed", () => {
    const { proj, configDir } = project([state(2)]);
    const file = join(configDir, "projects", projectFolderName(proj), "s2.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "assistant",
        cwd: proj,
        requestId: "req_9",
        timestamp: "2026-10-27T11:00:00.000Z",
        message: { id: "msg_9", model: "claude-future-9", usage: { input_tokens: 10 } },
      })}\n`,
    );
    const { out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(out).toContain("models in the events and not in the table: claude-future-9");
  });

  test("t9jrs_check_prices_local_outside_kodel_project_reads_nothing", () => {
    const { proj, configDir } = project([state(0.01)], false);
    const { code, out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(code).toBe(0);
    expect(out).toContain("nothing was read");
    expect(out).not.toContain("s1.jsonl");
  });

  test("t9jrs_check_prices_local_ignores_a_session_of_another_project", () => {
    const { proj, configDir } = project([state(0.01)]);
    const other = mkdtempSync(join(scratch, "other-"));
    const log = join(configDir, "projects", projectFolderName(proj), "s1.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replaceAll(proj, other));
    const { code, out } = run(["--local", "--root", proj, "--config-dir", configDir]);
    expect(code).toBe(0);
    expect(out).toContain("compared 0 session(s)");
  });
});

describe("t9jrs check-prices keeps its copies in step with the engine", () => {
  test("t9jrs_project_folder_name_matches_locate_ts: the script's copy equals projectFolderName on a corpus", async () => {
    const mod = (await import(script)) as { projectFolderName: (cwd: string) => string };
    const corpus = [
      "/Users/a/Code/app",
      "/Users/a/Code/app two/.kodel/worktrees/r_1",
      "C:\\Users\\a\\Code\\app",
      "/tmp/ünï/x.y_z",
      `/${"d".repeat(300)}`,
      "",
    ];
    for (const cwd of corpus) expect(mod.projectFolderName(cwd)).toBe(projectFolderName(cwd));
  });

  test("t9jrs_check_prices_matching_equals_the_cores: the script resolves a model id as resolvePrice does", async () => {
    const mod = (await import(script)) as {
      priceOf: (table: unknown, model: string, ts: string) => unknown;
    };
    const ts = "2026-10-28T10:00:00.000Z";
    const corpus = [
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-opus-5-20261001",
      "claude-opus-5-5-20261001",
      "claude-opus-5-5-latest",
      "claude-opus-5-5-fast",
      "claude-opus-5-fast",
      "claude-opus-5-1",
      "claude-sonnet-5-5-20261001",
      "claude-sonnet-5-20261001",
      "claude-fable-5-1-20261001",
      "claude-fable-5-20261001",
      "claude-opus-4-1",
      "claude-haiku-5-5",
      "something-else",
    ];
    for (const model of corpus) {
      const ours = mod.priceOf(SHIPPED_PRICES, model, ts);
      const core = resolvePrice({ table: SHIPPED_PRICES }, model, ts)?.price;
      expect(ours, model).toEqual(core);
    }
  });

  test("t9jrs_check_prices_script_reads_the_json_table_only", () => {
    const source = readFileSync(script, "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    // Only Node's own modules: no build output, no .ts, no workspace package.
    for (const spec of imports) expect(spec?.startsWith("node:")).toBe(true);
  });
});

describe("t9jrs kodel-prices skill", () => {
  test("t9jrs_kodel_prices_skill_structure", () => {
    const text = readFileSync(join(root, "skills", "kodel-prices", "SKILL.md"), "utf8");
    const front = /^---\nname: kodel-prices\ndescription: (.+)\n(?:argument-hint: .+\n)?---\n/.exec(
      text,
    );
    expect(front).not.toBeNull();
    expect(text).toContain("scripts/check-prices.mjs");
    expect(text).toContain("price-table.json");
    expect(text).toContain("checkedAt");
    // A maintainer's skill: it is not one of the skills `kodel init` installs.
    const init = readFileSync(join(root, "packages", "cli", "src", "init", "skills.ts"), "utf8");
    expect(init).not.toContain("kodel-prices");
  });
});
