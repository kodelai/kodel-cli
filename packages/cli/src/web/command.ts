/**
 * `kodel web`: the server, the pairing code a person scans, and the list of paired devices. The server
 * itself may run with no terminal (under a service manager); a pairing code is shown only to a person
 * at one, so a program that starts the server gets no way in from it.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, findSessionLog, firstCwd } from "@kodel-ai/local/history";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderUnicodeCompact } from "uqr";
import { type CancelPorts, cancelRun } from "../cancel-run";
import { plain } from "../plain";
import type { DecisionSource, DecisionTools, WorkHandle } from "../tui/decide";
import { addComment, type GateSource, loadDiff, loadRunCard, removeComment } from "../tui/gate";
import { loadSessions, type SessionSource } from "../tui/load";
import type { TuiOptions } from "../tui/run";
import type { GateDetail, LogEntry } from "../tui/session";
import {
  AskError,
  type Asker,
  type AskRef,
  type AskTarget,
  type AskThread,
  type AskTurn,
} from "./ask";
import { loadAssets } from "./assets";
import { type Device, DeviceStore } from "./devices";
import { createHandler, sameSite, type WebApi } from "./handler";
import { createMcpEndpoint, MCP_PATH } from "./mcp-http";
import { startWebServer } from "./server";
import { type McpToken, TokenStore } from "./tokens";

export const DEFAULT_PORT = 4317;

/** What a project's server reads and does: the same functions the terminal UI is given. */
export function projectApi(
  host: SessionSource & GateSource & DecisionSource,
  root: string,
  tools: Pick<DecisionTools, "check" | "decide">,
  asker?: Asker,
  tasks?: TaskReaders,
  cancelPorts?: () => Promise<CancelPorts>,
): WebApi {
  return {
    ...(cancelPorts
      ? {
          cancel: async (runId: string, reason: string) => {
            const answer = await cancelRun(await cancelPorts(), { runId, reason });
            return answer.ok
              ? answer
              : { ok: false as const, code: answer.error.code, message: answer.error.message };
          },
        }
      : {}),
    ...(tasks ? webTasks(tasks) : {}),
    ...(asker
      ? {
          ask: (runId: string, question: string, refs: AskRef[]) =>
            asker.ask(runId, question, refs),
          askThread: (runId: string) => asker.thread(runId),
        }
      : {}),
    source: "project",
    project: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
    sessions: () => loadSessions(host, Date.now()),
    detail: (runId, pick) => loadRunCard(host, runId, Date.now(), pick),
    diff: (runId, path) => loadDiff(host, runId, path),
    addComment: (runId, node, attempt, comment) => addComment(host, runId, node, attempt, comment),
    deleteComment: (runId, node, attempt, index) =>
      removeComment(host, runId, node, attempt, index),
    check: tools.check,
    decide: tools.decide,
  };
}

/**
 * The Claude Code session a run was last worked in, and the directory it ran in: Claude Code keeps a
 * session under the folder of that directory, so a resume must start there.
 */
export async function locateRunSession(
  host: SessionSource,
  root: string,
  runId: string,
  store: string = join(claudeConfigDir(), "projects"),
): Promise<AskTarget> {
  const { sessions } = await loadSessions(host, Date.now());
  const run = sessions.find((s) => s.id === runId);
  if (!run) return { ok: false, message: "There is no such run." };
  const id = run.agentSession?.id;
  if (!id) {
    return {
      ok: false,
      message: "No Claude Code session is known for this run: there is no one to ask.",
    };
  }
  const log = await findSessionLog(store, [root, ...(run.workdir ? [run.workdir] : [])], id);
  if (!log) {
    return {
      ok: false,
      message: "The log of the run's Claude Code session is not on this machine.",
    };
  }
  const cwd = await firstCwd(log);
  if (!cwd) return { ok: false, message: "The log of the run's session names no directory." };
  const there = await stat(cwd).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!there) {
    return { ok: false, message: `The directory the session ran in is gone: ${plain(cwd)}` };
  }
  return { ok: true, sessionId: id, cwd };
}

/** Sample answers: the demo has no agent, so a question gets a reply that says so, after a pause. */
function demoAsker(): Pick<WebApi, "ask" | "askThread"> {
  const threads = new Map<string, AskTurn[]>();
  const thread = async (runId: string): Promise<AskThread> => ({
    turns: (threads.get(runId) ?? []).map((t) => ({ ...t, tools: [...t.tools] })),
  });
  return {
    askThread: thread,
    ask: async (runId, question, refs) => {
      const turns = threads.get(runId) ?? [];
      if (turns.some((t) => t.state === "running")) {
        throw new AskError("busy", "The agent is still answering the last question.");
      }
      const turn: AskTurn = {
        question,
        ...(refs.length > 0 ? { refs } : {}),
        at: Date.now(),
        state: "running",
        answer: "",
        tools: [],
      };
      turns.push(turn);
      threads.set(runId, turns);
      setTimeout(() => turn.tools.push("Read packages/cli/src/format.ts"), 700);
      setTimeout(() => {
        turn.state = "done";
        turn.answer =
          "This is sample data, so no agent answers here. In a project with `web: { ask: true }` " +
          "a read-only copy of the run's Claude Code session answers, with what it read listed above.";
      }, 2_000);
      return thread(runId);
    },
  };
}

/** The sample run that is going on, with a subagent in its log: the terminal's sample has none. */
function withSampleSubagent(d: GateDetail | undefined): GateDetail | undefined {
  const log = d?.agentLog;
  if (!d || !log || log.length < 3) return d;
  const at = Math.round(((log.at(-2)?.ts ?? 0) + (log.at(-3)?.ts ?? 0)) / 2);
  const call = (ts: number, tool: string, text: string): LogEntry => ({
    ts,
    kind: "call",
    tool,
    text,
    result: { ok: true, ms: 40 },
  });
  const subagent: LogEntry = {
    ts: at,
    kind: "subagent",
    text: "Find every place that counts the wait timeout",
    children: [
      { ts: at - 40_000, kind: "text", text: "I will search for the timeout in the wait command." },
      call(at - 35_000, "Grep", "timeout packages/cli/src"),
      call(at - 25_000, "Read", "packages/cli/src/wait.ts"),
      {
        ts: at - 5_000,
        kind: "text",
        text: "Two places: `waitFor` starts the clock, and `poll` restarts it after each answer.",
      },
    ],
  };
  const agentLog = [...log, subagent].sort((a, b) => a.ts - b.ts);
  return { ...d, agentLog };
}

/** A plan the sample run changed: a Markdown file, so the web app can show it rendered. */
function sampleMarkdownDiff(path: string): string {
  const lines = [
    "# Make `kodel status` readable",
    "",
    "## Goal",
    "",
    "One short line per run, so twenty runs fit on a screen.",
    "",
    "## Plan",
    "",
    "1. Add `shortLine(task, max)` to `format.ts`.",
    "2. Use it in `status`; keep the old output behind `--full`.",
    "3. Test a long task, a task with new lines and an empty task.",
    "",
    "## Out of scope",
    "",
    "- Colours: the table stays plain.",
  ];
  return [
    `diff --git a/${path} b/${path}`,
    "@@ -1,12 +1,15 @@",
    ...lines.slice(0, 6).map((l) => ` ${l}`),
    ...lines.slice(6, 12).map((l) => `+${l}`),
    "-Nothing planned yet.",
    ...lines.slice(12).map((l) => ` ${l}`),
    "",
  ].join("\n");
}

/** What the terminal reads and writes of tasks (`tuiTaskOptions`). */
export type TaskReaders = Pick<
  TuiOptions,
  "loadTasks" | "loadTask" | "addTaskComment" | "createTask"
>;

/** The tasks part of the web API, from the terminal's readers. */
function webTasks(
  t: TaskReaders,
): Pick<WebApi, "tasks" | "task" | "addTaskComment" | "createTask"> {
  const { loadTasks, loadTask, addTaskComment, createTask } = t;
  if (!loadTasks || !loadTask) return {};
  return {
    tasks: loadTasks,
    task: loadTask,
    ...(addTaskComment ? { addTaskComment } : {}),
    ...(createTask ? { createTask } : {}),
  };
}

/** Sample runs: comments move them around in memory, and nothing can be decided. */
export async function demoApi(start: number): Promise<WebApi> {
  const demo = await import("../tui/demo");
  return {
    source: "demo",
    project: "demo",
    ...webTasks((await import("../tui/tasks-open")).tuiTaskOptions("demo", start)),
    ...demoAsker(),
    sessions: async () => demo.demoSessions(start),
    detail: async (runId) =>
      demo.demoGateDetail(runId, start) ?? withSampleSubagent(demo.demoRunningDetail(runId, start)),
    diff: async (_runId, path) =>
      path.endsWith(".md")
        ? { kind: "text", text: sampleMarkdownDiff(path), truncated: false }
        : demo.demoDiff(path),
    addComment: (runId, _node, _attempt, comment) => demo.demoAddComment(runId, comment),
    deleteComment: (runId, _node, _attempt, index) => demo.demoDeleteComment(runId, index),
  };
}

export interface WebIo {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
}

/** Where the devices and the server's address are kept: `<state base>/web`. */
export const webDir = (base: string) => join(base, "web");

/** The threads of questions of one project: runs are named per project, so each has its own folder. */
export const askDir = (base: string, root: string) =>
  join(webDir(base), "asks", createHash("sha256").update(root).digest("hex").slice(0, 16));

const isLoopback = (host: string) =>
  host === "127.0.0.1" || host === "::1" || host === "localhost" || host.startsWith("127.");

/** Tailscale hands out addresses from 100.64.0.0/10: such an address is the one a phone reaches. */
const isTailscale = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b < 128;
};

/** The addresses the server can be opened at, the likeliest first. */
export function addressesOf(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") {
    const shown = host.includes(":") ? `[${host}]` : host;
    return [`http://${shown}:${port}`];
  }
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) found.push(a.address);
    }
  }
  found.sort((x, y) => Number(isTailscale(y)) - Number(isTailscale(x)));
  return [...found, "127.0.0.1"].map((ip) => `http://${ip}:${port}`);
}

/** The address of the server that runs now, kept so that `kodel web pair` can put it in the code. */
async function rememberAddress(dir: string, url: string): Promise<void> {
  await writeFile(
    join(dir, "server.json"),
    `${JSON.stringify({ v: 1, url, pid: process.pid })}\n`,
    { mode: 0o600 },
  ).catch(() => undefined);
}

async function rememberedAddress(dir: string): Promise<string | undefined> {
  try {
    const data = JSON.parse(await readFile(join(dir, "server.json"), "utf8")) as { url?: unknown };
    return typeof data.url === "string" ? data.url : undefined;
  } catch {
    return undefined;
  }
}

export async function printPairing(io: WebIo, devices: DeviceStore, url: string | undefined) {
  const { code, expiresAt } = await devices.createPairing();
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  if (url === undefined) {
    io.out(
      `Pairing code (one use, ${minutes} minutes): ${code}\nOpen the web UI's address with #pair=${code} at the end.\n`,
    );
    return;
  }
  const link = `${url.replace(/\/+$/, "")}/#pair=${code}`;
  io.out(`\nScan with your phone to pair it (one use, ${minutes} minutes):\n\n`);
  io.out(`${renderUnicodeCompact(link, { border: 2 })}\n\n`);
  io.out(`or open ${link}\n\n`);
}

export async function pairCommand(io: WebIo, base: string, url: string | undefined) {
  const dir = webDir(base);
  const devices = new DeviceStore(dir);
  await printPairing(io, devices, url ?? (await rememberedAddress(dir)));
}

export function formatDevices(list: Device[]): string {
  if (list.length === 0) return "No devices are paired. Pair one with `kodel web pair`.\n";
  const when = (ts: number | undefined) =>
    ts === undefined ? "-" : new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  const lines = list.map(
    (d) =>
      `${d.id}  ${plain(d.name).padEnd(20)}  paired ${when(d.createdAt)}  seen ${when(d.lastSeenAt)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Makes a token for an MCP client and shows it once, with the line that connects Claude Code. */
export async function tokenAddCommand(
  io: WebIo,
  base: string,
  input: { name: string; readOnly: boolean },
): Promise<void> {
  const dir = webDir(base);
  const { token, info } = await new TokenStore(dir).add(input);
  const address = (await rememberedAddress(dir)) ?? "http://<this machine>:4317";
  io.out(
    `Token ${info.id} for "${plain(info.name)}" (manager${info.readOnly ? ", read-only" : ""}). It is shown once:\n\n  ${token}\n\n` +
      `Claude Code on the other machine:\n\n  claude mcp add --transport http kodel ${address}${MCP_PATH} --header "Authorization: Bearer ${token}"\n\n` +
      `The server serves it when started with --mcp. Revoke it with: kodel web token revoke ${info.id}\n`,
  );
}

export function formatTokens(list: McpToken[]): string {
  if (list.length === 0) return "No tokens. Make one with: kodel web token add --name <client>\n";
  const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  return `${list
    .map(
      (t) =>
        `${t.id}  ${plain(t.name)}  ${t.readOnly ? "read-only" : "manager"}  made ${when(t.createdAt)}${t.lastUsedAt === undefined ? "" : `  used ${when(t.lastUsedAt)}`}`,
    )
    .join("\n")}\n`;
}

export interface ServeOptions {
  api: WebApi;
  base: string;
  host: string;
  port: number;
  /** The address the server is opened at from outside, when it sits behind a proxy or Tailscale. */
  url?: string;
  work?: WorkHandle;
  /** Resolves when the person asks the server to stop (a signal); a second one stops at once. */
  signals?: { first: Promise<void>; second: Promise<void> };
  /** `--mcp`: a new manager server for one session of a token at `/mcp`. */
  mcp?: (token: McpToken) => Promise<McpServer>;
  /** The redaction of the project, its own rules included; without one, the built-in rules. */
  redact?: (text: string) => string;
}

export async function serveWeb(io: WebIo, options: ServeOptions): Promise<void> {
  const dir = webDir(options.base);
  const devices = new DeviceStore(dir);
  const publicUrl = options.url === undefined ? undefined : new URL(options.url);
  if (publicUrl && publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
    throw new Error(`--url must be an http(s) address (got ${options.url})`);
  }
  const auditFile = join(dir, "audit.log");
  const audit = (line: string) => {
    const stamped = `${new Date().toISOString()} ${plain(line)}`;
    io.out(`${stamped}\n`);
    void appendFile(auditFile, `${stamped}\n`, { mode: 0o600 }).catch(() => undefined);
  };
  const handler = createHandler({
    api: options.api,
    devices,
    assets: await loadAssets(),
    ...(publicUrl ? { publicUrl } : {}),
    secureCookie: publicUrl?.protocol === "https:",
    audit,
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  });
  const serverFor = options.mcp;
  const mcp = serverFor
    ? createMcpEndpoint({
        tokens: new TokenStore(dir),
        serverFor,
        originAllowed: (origin, host) => sameSite(origin, host, publicUrl),
        audit,
      })
    : undefined;
  const web = startWebServer({ handler, api: options.api, ...(mcp ? { mcp } : {}) });
  await new Promise<void>((resolve, reject) => {
    web.server.once("error", reject);
    web.server.listen(options.port, options.host, () => resolve());
  });
  const port = (() => {
    const a = web.server.address();
    return typeof a === "object" && a !== null ? a.port : options.port;
  })();
  const addresses = publicUrl ? [publicUrl.origin] : addressesOf(options.host, port);
  const main = addresses[0] ?? `http://127.0.0.1:${port}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rememberAddress(dir, main);

  io.out(
    `Kodel web UI for ${plain(options.api.project)}${options.api.source === "demo" ? " (sample data)" : ""}\n`,
  );
  for (const a of addresses) io.out(`  ${a}\n`);
  if (!isLoopback(options.host) && publicUrl?.protocol !== "https:") {
    io.err(
      "kodel: this address is not encrypted. Over Tailscale that is fine; on the open internet put a TLS proxy in front and pass --url https://... (docs/web.md)\n",
    );
  }
  if (mcp) {
    const tokens = await new TokenStore(dir).list();
    io.out(
      `MCP (manager tools): ${main}${MCP_PATH} · ${tokens.length === 0 ? "no token yet: kodel web token add --name <client>" : `${tokens.length} token(s)`}\n`,
    );
  }
  const paired = await devices.list();
  if (io.interactive) {
    if (paired.length === 0) await printPairing(io, devices, main);
    else io.out(`${paired.length} device(s) paired. Another one: kodel web pair\n`);
  } else if (paired.length === 0) {
    io.out("No device is paired yet: run `kodel web pair` at a terminal.\n");
  }
  io.out("Ctrl-C stops the server.\n");

  if (!options.signals) return;
  await options.signals.first;
  io.out("Stopping…\n");
  await web.close();
  await mcp?.close();
  if (options.work?.pending()) {
    io.out("Waiting for the engine work your decisions started (Ctrl-C again to stop it)…\n");
    const outcome = await Promise.race([
      options.work.wait().then(() => "done" as const),
      options.signals.second.then(() => "stop" as const),
    ]);
    if (outcome === "stop") await options.work.stop().catch(() => undefined);
  }
}
