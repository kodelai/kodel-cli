/**
 * Questions a person asks about a run from the web app (`web: { ask: true }` in the project config, off
 * by default). Claude Code only: the session the run was worked in is resumed as a fork
 * (`--resume <id> --fork-session`), so the answer knows the run from the inside, and the run's own
 * session is never touched. The fork may only read (Read, Grep, Glob; no MCP server, no project
 * settings, so no kodel hook and no kodel tool), so a question cannot change the run or the code. A
 * follow-up resumes the fork. Everything the fork writes is redacted before it leaves the machine.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactText } from "@kodel-ai/pipeline-core";

/** The tools the fork may use: reading the code, nothing else. */
export const ASK_TOOLS = ["Read", "Grep", "Glob"] as const;
export const ASK_TIMEOUT_MS = 5 * 60_000;
export const QUESTION_CHARS = 4_000;
const ANSWER_CHARS = 64_000;
const TOOL_LINES = 40;
const FILE_V = 1;

/** Lines of the diff the question is about: where they are, what they say, and the person's note on them. */
export interface AskRef {
  place: string;
  code: string;
  note: string;
}

export const MAX_REFS = 10;
export const REF_CODE_CHARS = 4_000;
export const REF_NOTE_CHARS = 2_000;

export interface AskTurn {
  question: string;
  refs?: AskRef[];
  at: number;
  state: "running" | "done" | "failed";
  /** What the fork has said so far; its final answer once it is done. */
  answer: string;
  /** One short line per tool the fork called, in order. */
  tools: string[];
  error?: string;
  cost?: number;
}

export interface AskThread {
  turns: AskTurn[];
}

/** Where the session to ask is, found by the caller: the session's id and the directory it ran in. */
export type AskTarget =
  | { ok: true; sessionId: string; cwd: string }
  | { ok: false; message: string };

export interface AskProcess {
  lines: AsyncIterable<string>;
  /** Resolves when the process has ended, with the tail of what it wrote to stderr. */
  ended: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

export type Spawner = (
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string },
) => AskProcess;

export interface AskerOptions {
  /** Where the threads are kept (`<state base>/web/asks`). */
  dir: string;
  locate(runId: string): Promise<AskTarget>;
  spawn?: Spawner;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  timeoutMs?: number;
  /** The redaction of the project, its own rules included; without one, the built-in rules. */
  redact?: (text: string) => string;
}

export class AskError extends Error {
  constructor(
    readonly code: "busy" | "no_session" | "bad_question",
    message: string,
  ) {
    super(message);
  }
}

interface Stored {
  v: number;
  /** The fork the follow-ups resume, and the directory it lives in. */
  fork?: string;
  cwd?: string;
  turns: AskTurn[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The argv of one turn: the first one forks the run's session, a follow-up resumes the fork. */
export function askArgv(sessionId: string, fork: boolean): string[] {
  return [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    sessionId,
    ...(fork ? ["--fork-session"] : []),
    "--tools",
    ASK_TOOLS.join(","),
    "--allowedTools",
    ASK_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    // The project's settings carry the kodel hook and its MCP server: the fork has neither.
    "--setting-sources",
    "user",
  ];
}

/** The text the fork is given; the question goes in on stdin, never in argv. */
export function askPrompt(question: string, first: boolean, refs: readonly AskRef[] = []): string {
  const head = first
    ? "[Kodel web] The person reviewing this run asks a question from their phone. Answer it from " +
      "what you know about the run and by reading the code. You can only read: nothing you do " +
      "changes the run or the files, so do not offer to. Keep it short, it is read on a phone.\n\n"
    : "[Kodel web] A follow-up question.\n\n";
  const parts = [
    head + (question === "" ? "Question: see the places below." : `Question: ${question}`),
  ];
  if (refs.length > 0) {
    parts.push(
      `It is about ${refs.length === 1 ? "this place" : "these places"} in the run's changes ` +
        "(lines of the diff: + added, - removed). Answer for each one.",
    );
    refs.forEach((r, i) => {
      parts.push(
        `${i + 1}. ${r.place}${r.note === "" ? "" : `\n   The person asks: ${r.note}`}\n\`\`\`\n${r.code}\n\`\`\``,
      );
    });
  }
  return parts.join("\n\n");
}

/** The environment of the fork: the machine's, without what would tie it to a run. */
export function askEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("KODEL_")) out[key] = value;
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One short line for a tool call: its name and the file or pattern it looked at. */
function toolLine(name: string, input: unknown, cwd: string): string {
  const field = (k: string) =>
    isObject(input) && typeof input[k] === "string" ? (input[k] as string) : undefined;
  let what = field("file_path") ?? field("pattern") ?? field("path") ?? "";
  if (what.startsWith(`${cwd}/`)) what = what.slice(cwd.length + 1);
  const line = `${name} ${what}`.trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export type AskEvent =
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; line: string }
  | { kind: "result"; text: string; error: boolean; cost?: number; id?: string };

/** The events of one `stream-json` line that the thread keeps; anything else is no event. */
export function askEventsOf(line: string, cwd: string): AskEvent[] {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(e)) return [];
  const sid = typeof e["session_id"] === "string" ? e["session_id"] : undefined;
  if (e["type"] === "system" && e["subtype"] === "init" && sid)
    return [{ kind: "session", id: sid }];
  if (e["type"] === "assistant" && isObject(e["message"])) {
    const content = e["message"]["content"];
    if (!Array.isArray(content)) return [];
    const out: AskEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        out.push({ kind: "text", text: block["text"] });
      } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        out.push({ kind: "tool", line: toolLine(block["name"], block["input"], cwd) });
      }
    }
    return out;
  }
  if (e["type"] === "result") {
    return [
      {
        kind: "result",
        text: typeof e["result"] === "string" ? e["result"] : "",
        error: e["is_error"] === true,
        ...(typeof e["total_cost_usd"] === "number" ? { cost: e["total_cost_usd"] } : {}),
        ...(sid ? { id: sid } : {}),
      },
    ];
  }
  return [];
}

const cut = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;

function spawnClaude(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string },
): AskProcess {
  const [cmd = "claude", ...args] = argv;
  const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderr = (stderr + d).slice(-2_000);
  });
  const ended = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (error) => resolve({ code: null, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin);
  child.stdout.setEncoding("utf8");
  async function* lines(): AsyncGenerator<string> {
    let rest = "";
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      rest += chunk;
      let at = rest.indexOf("\n");
      while (at >= 0) {
        yield rest.slice(0, at);
        rest = rest.slice(at + 1);
        at = rest.indexOf("\n");
      }
    }
    if (rest.trim() !== "") yield rest;
  }
  return { lines: lines(), ended, kill: () => child.kill("SIGTERM") };
}

/** The threads of every run the server was asked about, one turn at a time per run. */
export class Asker {
  private readonly live = new Map<string, Stored>();
  /** A thread being read: two first requests share one read, so neither loses the other's turn. */
  private readonly loading = new Map<string, Promise<Stored>>();
  /** Runs whose turn is being started: a second question is busy before the first one has a turn. */
  private readonly starting = new Set<string>();
  private readonly spawn: Spawner;
  private readonly clock: () => number;
  private readonly redact: (text: string) => string;

  constructor(private readonly options: AskerOptions) {
    this.spawn = options.spawn ?? spawnClaude;
    this.clock = options.clock ?? Date.now;
    this.redact = options.redact ?? ((text) => redactText(text));
  }

  private file(runId: string): string {
    return join(this.options.dir, `${runId}.json`);
  }

  private load(runId: string): Promise<Stored> {
    const held = this.live.get(runId);
    if (held) return Promise.resolve(held);
    let pending = this.loading.get(runId);
    if (pending === undefined) {
      pending = this.read(runId).finally(() => this.loading.delete(runId));
      this.loading.set(runId, pending);
    }
    return pending;
  }

  private async read(runId: string): Promise<Stored> {
    let stored: Stored = { v: FILE_V, turns: [] };
    try {
      const raw = JSON.parse(await readFile(this.file(runId), "utf8")) as Stored;
      if (raw.v > FILE_V)
        throw new Error(`${this.file(runId)} was written by a newer kodel; upgrade kodel`);
      // A turn that was going when the server stopped has no process any more.
      stored = {
        ...raw,
        turns: raw.turns.map((t) =>
          t.state === "running" ? { ...t, state: "failed", error: "The server stopped." } : t,
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    this.live.set(runId, stored);
    return stored;
  }

  private async save(runId: string, stored: Stored): Promise<void> {
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(runId)}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await rename(tmp, this.file(runId));
  }

  /** The thread as the phone sees it: everything the fork wrote passes through redaction. */
  async thread(runId: string): Promise<AskThread> {
    if (!SAFE_ID.test(runId)) return { turns: [] };
    const stored = await this.load(runId);
    return {
      turns: stored.turns.map((t) => ({
        ...t,
        answer: this.redact(t.answer),
        ...(t.refs === undefined
          ? {}
          : {
              refs: t.refs.map((r) => ({
                ...r,
                code: this.redact(r.code),
                note: this.redact(r.note),
              })),
            }),
        tools: t.tools.map((l) => this.redact(l)),
        ...(t.error === undefined ? {} : { error: this.redact(t.error) }),
      })),
    };
  }

  /** Starts a turn and answers at once; the turn goes on in the background. */
  async ask(runId: string, question: string, refs: readonly AskRef[] = []): Promise<AskThread> {
    const q = question.trim();
    if ((q === "" && refs.length === 0) || q.length > QUESTION_CHARS) {
      throw new AskError("bad_question", `A question is 1 to ${QUESTION_CHARS} characters.`);
    }
    if (
      refs.length > MAX_REFS ||
      refs.some(
        (r) =>
          r.place.length > 300 || r.code.length > REF_CODE_CHARS || r.note.length > REF_NOTE_CHARS,
      )
    ) {
      throw new AskError("bad_question", `At most ${MAX_REFS} places, each a few lines long.`);
    }
    if (!SAFE_ID.test(runId)) throw new AskError("no_session", "There is no such run.");
    const stored = await this.load(runId);
    if (this.starting.has(runId) || stored.turns.some((t) => t.state === "running")) {
      throw new AskError("busy", "The agent is still answering the last question.");
    }
    this.starting.add(runId);
    try {
      return await this.start(runId, stored, q, refs);
    } finally {
      this.starting.delete(runId);
    }
  }

  private async start(
    runId: string,
    stored: Stored,
    q: string,
    refs: readonly AskRef[],
  ): Promise<AskThread> {
    let sessionId = stored.fork;
    let cwd = stored.cwd;
    const first = sessionId === undefined || cwd === undefined;
    if (first) {
      const target = await this.options.locate(runId);
      if (!target.ok) throw new AskError("no_session", target.message);
      if (!SAFE_ID.test(target.sessionId)) {
        throw new AskError("no_session", "The run's session id cannot be used.");
      }
      sessionId = target.sessionId;
      cwd = target.cwd;
    }
    const turn: AskTurn = {
      question: q,
      ...(refs.length > 0 ? { refs: refs.map((r) => ({ ...r, note: r.note.trim() })) } : {}),
      at: this.clock(),
      state: "running",
      answer: "",
      tools: [],
    };
    stored.turns.push(turn);
    await this.save(runId, stored);
    void this.run(runId, stored, turn, sessionId as string, cwd as string, first);
    return this.thread(runId);
  }

  private async run(
    runId: string,
    stored: Stored,
    turn: AskTurn,
    sessionId: string,
    cwd: string,
    first: boolean,
  ): Promise<void> {
    let proc: AskProcess;
    try {
      proc = this.spawn(askArgv(sessionId, first), {
        cwd,
        env: askEnv(this.options.env ?? process.env),
        stdin: askPrompt(turn.question, first, turn.refs),
      });
    } catch (error) {
      turn.state = "failed";
      turn.error = error instanceof Error ? error.message : String(error);
      await this.save(runId, stored).catch(() => undefined);
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.options.timeoutMs ?? ASK_TIMEOUT_MS);
    let result: Extract<AskEvent, { kind: "result" }> | undefined;
    let fork: string | undefined;
    try {
      for await (const line of proc.lines) {
        for (const event of askEventsOf(line, cwd)) {
          if (event.kind === "session") fork = event.id;
          else if (event.kind === "text") {
            turn.answer = cut(
              turn.answer === "" ? event.text : `${turn.answer}\n\n${event.text}`,
              ANSWER_CHARS,
            );
          } else if (event.kind === "tool") {
            if (turn.tools.length < TOOL_LINES) turn.tools.push(event.line);
          } else {
            result = event;
            if (event.id) fork = event.id;
          }
        }
      }
    } catch {
      // The end below says what happened.
    }
    const end = await proc.ended;
    clearTimeout(timer);
    if (result && !result.error) {
      turn.state = "done";
      if (result.text !== "") turn.answer = cut(result.text, ANSWER_CHARS);
      if (result.cost !== undefined) turn.cost = result.cost;
    } else {
      turn.state = "failed";
      turn.error = timedOut
        ? "The agent took longer than five minutes; ask again, more narrowly."
        : result?.text || end.stderr.trim() || `claude ended with code ${end.code ?? "?"}`;
    }
    if (fork && SAFE_ID.test(fork)) {
      stored.fork = fork;
      stored.cwd = cwd;
    }
    await this.save(runId, stored).catch(() => undefined);
  }
}
