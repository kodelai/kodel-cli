/**
 * The web UI's requests, as a function from a request to a response: no sockets, so that every rule
 * (who may call what, from where) is tested without a port. `server.ts` puts it on `node:http`.
 *
 * Who may call: a paired device (`devices.ts`), by its cookie. Nothing but the app's own files, the
 * health check and the pairing itself answer without one. A write must come from a page of this very
 * server (`Origin`), as JSON, so another site cannot make a browser send it.
 */
import { type ForcedWarning, KodelError, redactText } from "@kodel-ai/pipeline-core";
import { z } from "zod";
import type { ManualCheck, ManualStartResult } from "../manual-start";
import type { ManualStopResult } from "../manual-stop";
import type { DecisionRequest } from "../tui/decide";
import { highlight, languageOf, parseDiff, placeOf } from "../tui/diffview";
import type {
  CheckResult,
  Comment,
  DecisionOutcome,
  DecisionRef,
  DiffState,
  GateDetail,
  Session,
} from "../tui/session";
import type { CardSlot, NewTaskInput, TaskRow, TasksLoad } from "../tui/tasks-load";
import {
  AskError,
  type AskRef,
  type AskThread,
  MAX_REFS,
  QUESTION_CHARS,
  REF_CODE_CHARS,
  REF_NOTE_CHARS,
} from "./ask";
import type { Device, DeviceStore } from "./devices";

export const COOKIE = "kodel_device";
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
/** Failed pairings an address may make in a window, and in all. */
const PAIR_LIMIT_PER_IP = 10;
const PAIR_LIMIT_ALL = 30;
const PAIR_WINDOW_MS = 60_000;
/** The largest body a request may carry. */
export const MAX_BODY = 64 * 1024;

export interface WebRequest {
  method: string;
  /** The path, without the query. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body?: string;
  /** The peer's address, as the socket has it. */
  ip: string;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/** One row of a diff as the page draws it: the parsing and the colours are done here. */
export interface WebDiffRow {
  kind: "hunk" | "ctx" | "add" | "del" | "note";
  old?: number;
  new?: number;
  segs: { text: string; type?: string }[];
  /** Where a comment on this row lands; none for a row that is not a line of the file. */
  place?: string;
}

export type WebDiff =
  | { kind: "rows"; rows: WebDiffRow[]; truncated: boolean }
  | { kind: "missing" }
  | { kind: "error"; message: string };

/** What the server can read and do, the same functions the terminal UI is given. */
export interface WebApi {
  /** `demo` (sample data, nothing is written) or `project`. */
  source: "demo" | "project";
  project: string;
  sessions(): Promise<{ sessions: Session[]; proposals: number }>;
  detail(runId: string, pick?: DecisionRef): Promise<GateDetail | undefined>;
  diff(runId: string, path: string): Promise<DiffState>;
  addComment?(runId: string, node: string, attempt: number, comment: Comment): Promise<void>;
  deleteComment?(runId: string, node: string, attempt: number, index: number): Promise<void>;
  check?(runId: string, request: DecisionRequest): Promise<CheckResult>;
  decide?(runId: string, request: DecisionRequest): Promise<DecisionOutcome>;
  /** Questions about a run to a read-only fork of its agent session; absent unless the config turns them on. */
  ask?(runId: string, question: string, refs: AskRef[]): Promise<AskThread>;
  askThread?(runId: string): Promise<AskThread>;
  /** The project's tasks, as the terminal reads them; absent when the server reads none. */
  tasks?(): Promise<TasksLoad>;
  task?(key: string): Promise<CardSlot>;
  addTaskComment?(key: string, text: string): Promise<void>;
  createTask?(input: NewTaskInput): Promise<{ key: string }>;
  /**
   * Start a task by request, as the terminal's `s` does. Absent in the demo, on Windows and when tasks
   * are off: that is all the page's button depends on (the keys of `decisions.agent` are for agents).
   */
  startTask?: {
    check(key: string): Promise<ManualCheck>;
    /** `force` is the warnings the person was shown, never more. */
    start(input: {
      key: string;
      pipeline?: string;
      force: ForcedWarning[];
    }): Promise<ManualStartResult>;
  };
  /** Stop the agent of a run (the run stays open); absent in the demo and on Windows. */
  stopAgent?(runId: string): Promise<ManualStopResult>;
}

export interface Assets {
  html: string;
  js: string;
  css: string;
}

export interface HandlerOptions {
  api: WebApi;
  devices: DeviceStore;
  assets: Assets;
  /** The address the server is opened at from outside (`--url`); its host is let in as an origin. */
  publicUrl?: URL;
  /** Whether the cookie is sent over HTTPS only: on when the public address is `https:`. */
  secureCookie: boolean;
  /** One line about what a device did (paired, decided, commented, left). */
  audit(line: string): void;
  clock?: () => number;
  /** The redaction of the project, its own rules included; without one, the built-in rules. */
  redact?: (text: string) => string;
}

// ── request bodies ──────────────────────────────────────────────────────────

const refSchema = z.object({
  kind: z.enum(["gate", "pause"]),
  node: z.string().min(1).max(200),
  attempt: z.number().int().min(1).optional(),
  prompt: z.string().max(10_000).default(""),
  command: z.string().max(2_000).default(""),
});

const askBody = z.object({
  question: z.string().max(QUESTION_CHARS).default(""),
  refs: z
    .array(
      z.object({
        place: z.string().min(1).max(300),
        code: z.string().max(REF_CODE_CHARS),
        note: z.string().max(REF_NOTE_CHARS).default(""),
      }),
    )
    .max(MAX_REFS)
    .default([]),
});

const taskCommentBody = z.object({ text: z.string().trim().min(1).max(10_000) });

const newTaskBody = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(20_000).optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
  parent: z.string().max(100).optional(),
});

const TASK_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** As the terminal's form: a text keeps its line breaks and loses every other control character; a line keeps none. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters taken out
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters taken out
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const cleanText = (t: string) => t.replace(CONTROLS_BUT_NEWLINE, "");
const cleanLine = (t: string) => t.replace(CONTROLS, " ").trim();

/** What a task says is text people and agents wrote: it is redacted before it leaves the machine. */
function redactCard(slot: CardSlot, redactText: (text: string) => string): CardSlot {
  if (slot.status !== "ready") return slot;
  const c = slot.card;
  return {
    status: "ready",
    card: {
      ...c,
      title: redactText(c.title),
      ...(c.body === undefined ? {} : { body: redactText(c.body) }),
      comments: c.comments.map((m) => ({ ...m, text: redactText(m.text) })),
      subtasks: c.subtasks.map((k) => ({ ...k, title: redactText(k.title) })),
    },
  };
}

function redactTasks(load: TasksLoad, redactText: (text: string) => string): TasksLoad {
  if (load.status !== "ready") return load;
  const row = (r: TaskRow): TaskRow => ({ ...r, title: redactText(r.title) });
  return { ...load, rows: load.rows.map(row), todo: load.todo.map(row) };
}

const pairBody = z.object({ code: z.string().min(1).max(200), name: z.string().max(200) });

const commentBody = z.object({
  node: z.string().min(1).max(200),
  attempt: z.number().int().min(1),
  severity: z.enum(["blocker", "critical", "major", "minor", "info"]),
  location: z.string().min(1).max(1_000),
  description: z.string().trim().min(1).max(10_000),
});

const deleteCommentBody = z.object({
  node: z.string().min(1).max(200),
  attempt: z.number().int().min(1),
  index: z.number().int().min(0),
});

const checkBody = z.object({
  ref: refSchema,
  decision: z.enum(["approve", "reject", "resume"]),
  reason: z.string().trim().max(10_000).optional(),
});

const decideBody = z.object({ flow: z.number().int().min(1) });

/** Without `flow` it asks; with the `flow` of that answer it does it. */
const startBody = z.object({
  pipeline: z.string().min(1).max(200).optional(),
  flow: z.number().int().min(1).optional(),
});
const stopBody = z.object({ flow: z.number().int().min(1).optional() });

// ── helpers ─────────────────────────────────────────────────────────────────

/** The page may load only what this server serves, and nothing may frame it. */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function respond(status: number, type: string, body: string, extra: Record<string, string> = {}) {
  return {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": type, ...extra },
    body,
  };
}

const json = (status: number, value: unknown, extra: Record<string, string> = {}): WebResponse =>
  respond(status, "application/json; charset=utf-8", JSON.stringify(value), {
    "cache-control": "no-store",
    ...extra,
  });

const fail = (status: number, code: string, message: string) =>
  json(status, { ok: false, code, message });

export function cookieOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function parse<T>(schema: z.ZodType<T>, body: string | undefined): T | undefined {
  try {
    const found = schema.safeParse(JSON.parse(body ?? ""));
    return found.success ? found.data : undefined;
  } catch {
    return undefined;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A diff ready to draw: rows, colours and the place a comment on each row lands. The working tree is
 * not history and has not been through `redact`; what leaves the machine does go through it.
 */
export function diffRows(
  path: string,
  state: DiffState,
  redact: (text: string) => string = (t) => redactText(t),
): WebDiff {
  if (state.kind !== "text") return state;
  const language = languageOf(path);
  const rows = parseDiff(redact(state.text)).map((row): WebDiffRow => {
    const code = row.kind === "add" || row.kind === "del" || row.kind === "ctx";
    return {
      kind: row.kind,
      ...(row.old === undefined ? {} : { old: row.old }),
      ...(row.new === undefined ? {} : { new: row.new }),
      segs: code
        ? highlight(row.text, language).map((s) =>
            s.type === undefined ? { text: s.text } : { text: s.text, type: s.type },
          )
        : [{ text: row.text }],
      ...(code ? { place: placeOf(path, row) } : {}),
    };
  });
  return { kind: "rows", rows, truncated: state.truncated };
}

/** Whether a page at `origin` is this server's own: the address it was opened at, or the public one. */
export function sameSite(origin: string, host: string | undefined, publicUrl?: URL): boolean {
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    return false;
  }
  if (publicUrl !== undefined && from === publicUrl.host) return true;
  return host !== undefined && from === host;
}

// ── the handler ─────────────────────────────────────────────────────────────

export interface Handler {
  handle(request: WebRequest): Promise<WebResponse>;
  /** The device a request comes from, or nothing: what the event stream checks too. */
  authenticate(headers: WebRequest["headers"]): Promise<Device | undefined>;
}

export function createHandler(options: HandlerOptions): Handler {
  const { api, devices, assets } = options;
  const clock = options.clock ?? Date.now;
  const redact = options.redact ?? ((text: string) => redactText(text));
  const failures = new Map<string, { count: number; until: number }>();
  let failuresAll = { count: 0, until: 0 };
  /** The checks a device asked for, by flow: a decision writes only what was checked. */
  const flows = new Map<
    number,
    { device: string; runId: string; request: DecisionRequest; at: number }
  >();
  /** What a device was asked to confirm for a start or a stop: only that is done at its second call. */
  type Action =
    | { kind: "start"; device: string; key: string; warnings: ForcedWarning[]; at: number }
    | { kind: "stop"; device: string; runId: string; at: number };
  const actions = new Map<number, Action>();
  let nextFlow = 1;
  const remember = (flow: number, action: Action) => {
    actions.set(flow, action);
    for (const [k, a] of actions) if (clock() - a.at > 30 * 60_000) actions.delete(k);
  };
  /** The words of an answer come from tasks and runs: they leave the machine redacted. */
  const redactStart = (r: ManualStartResult): ManualStartResult =>
    r.status === "started"
      ? r
      : {
          ...r,
          reason: redact(r.reason),
          ...(r.hint === undefined ? {} : { hint: redact(r.hint) }),
          ...(r.warnings === undefined
            ? {}
            : { warnings: r.warnings.map((w) => ({ ...w, reason: redact(w.reason) })) }),
        };
  const redactStop = (r: ManualStopResult): ManualStopResult =>
    r.status === "stopped" ? { ...r, note: redact(r.note) } : { ...r, reason: redact(r.reason) };

  const authenticate = (headers: WebRequest["headers"]) =>
    devices.verify(cookieOf(headers.cookie)).catch(() => undefined);

  /** A write from a page of another site, or not as JSON, is refused before anything is read. */
  const sameOrigin = (request: WebRequest): boolean =>
    request.headers.origin !== undefined &&
    sameSite(request.headers.origin, request.headers.host, options.publicUrl);

  const limited = (ip: string): boolean => {
    const now = clock();
    const mine = failures.get(ip);
    const tooMany = (w: { count: number; until: number } | undefined, max: number) =>
      w !== undefined && w.until > now && w.count >= max;
    return tooMany(mine, PAIR_LIMIT_PER_IP) || tooMany(failuresAll, PAIR_LIMIT_ALL);
  };

  const failed = (ip: string) => {
    const now = clock();
    const bump = (w: { count: number; until: number } | undefined) =>
      w === undefined || w.until <= now
        ? { count: 1, until: now + PAIR_WINDOW_MS }
        : { count: w.count + 1, until: w.until };
    failures.set(ip, bump(failures.get(ip)));
    failuresAll = bump(failuresAll);
    if (failures.size > 1_000) {
      for (const [key, w] of failures) if (w.until <= now) failures.delete(key);
    }
  };

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.secureCookie ? "; Secure" : ""}`;

  const statics = (path: string): WebResponse | undefined => {
    const cache = { "cache-control": "no-cache" };
    switch (path) {
      case "/":
      case "/index.html":
        return respond(200, "text/html; charset=utf-8", assets.html, cache);
      case "/app.js":
        return respond(200, "text/javascript; charset=utf-8", assets.js, cache);
      case "/app.css":
        return respond(200, "text/css; charset=utf-8", assets.css, cache);
      case "/manifest.webmanifest":
        return respond(200, "application/manifest+json", MANIFEST, cache);
      case "/icon.svg":
        return respond(200, "image/svg+xml", ICON, cache);
      case "/healthz":
        return respond(200, "text/plain; charset=utf-8", "ok\n", { "cache-control": "no-store" });
      default:
        return undefined;
    }
  };

  const pair = async (request: WebRequest): Promise<WebResponse> => {
    if (limited(request.ip)) {
      return fail(429, "too_many", "Too many tries. Wait a minute and scan a new code.");
    }
    const body = parse(pairBody, request.body);
    if (!body) return fail(400, "bad_request", "The request is not understood.");
    const paired = await devices.redeemPairing(body.code, body.name);
    if (!paired) {
      failed(request.ip);
      return fail(
        403,
        "bad_code",
        "This code is wrong, used or older than five minutes. Run `kodel web pair` for a new one.",
      );
    }
    options.audit(`paired device ${paired.device.id} "${paired.device.name}" from ${request.ip}`);
    return json(
      200,
      { ok: true, device: paired.device },
      { "set-cookie": cookie(paired.credential, COOKIE_MAX_AGE_S) },
    );
  };

  const tasks_ = async (
    request: WebRequest,
    device: Device,
    parts: string[],
  ): Promise<WebResponse> => {
    const { method } = request;
    const key = parts[1];
    if (!api.tasks || !api.task) return fail(404, "tasks_off", "This server reads no tasks.");
    if (key === undefined && method === "GET") {
      return json(200, { ok: true, tasks: redactTasks(await api.tasks(), redact) });
    }
    if (key === undefined && method === "POST") {
      if (!api.createTask) return fail(403, "read_only", "Tasks cannot be created here.");
      const body = parse(newTaskBody, request.body);
      if (!body) return fail(400, "bad_request", "The task is not understood.");
      const title = cleanLine(body.title);
      const text = body.body === undefined ? "" : cleanText(body.body).trim();
      const parent = body.parent === undefined ? "" : cleanLine(body.parent);
      if (title === "") return fail(400, "bad_request", "A task needs a title.");
      const made = await api.createTask({
        title,
        ...(text === "" ? {} : { body: text }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(parent === "" ? {} : { parent }),
      });
      options.audit(`device ${device.id} created task ${made.key}`);
      return json(200, { ok: true, key: made.key });
    }
    if (key === undefined || !TASK_KEY.test(key)) return fail(400, "bad_request", "Which task?");
    if (parts[2] === undefined && method === "GET") {
      return json(200, { ok: true, task: redactCard(await api.task(key), redact) });
    }
    if (parts[2] === "comments" && method === "POST") {
      if (!api.addTaskComment) return fail(403, "read_only", "Comments cannot be written here.");
      const body = parse(taskCommentBody, request.body);
      if (!body) return fail(400, "bad_request", "The comment is not understood.");
      const text = cleanText(body.text).trim();
      if (text === "") return fail(400, "bad_request", "The comment is empty.");
      await api.addTaskComment(key, text);
      options.audit(`device ${device.id} commented on task ${key}`);
      return json(200, { ok: true });
    }
    if (parts[2] === "start" && method === "POST") {
      const start = api.startTask;
      if (!start) return fail(403, "read_only", "Tasks cannot be started here.");
      const body = parse(startBody, request.body);
      if (!body) return fail(400, "bad_request", "The request is not understood.");
      try {
        if (body.flow === undefined) {
          const checked = await start.check(key);
          if (!checked.ok) {
            return json(200, { ok: true, step: "done", result: redactStart(checked.result) });
          }
          const flow = nextFlow++;
          const warnings = checked.warnings.map((w) => w.why);
          remember(flow, { kind: "start", device: device.id, key, warnings, at: clock() });
          return json(200, {
            ok: true,
            step: "confirm",
            flow,
            pipelines: checked.pipelines,
            warnings: checked.warnings.map((w) => ({ ...w, reason: redact(w.reason) })),
            ...(checked.note === undefined ? {} : { note: redact(checked.note) }),
          });
        }
        const asked = actions.get(body.flow);
        actions.delete(body.flow);
        if (asked?.kind !== "start" || asked.device !== device.id || asked.key !== key) {
          return fail(409, "not_checked", "Nothing was asked for this start; look again.");
        }
        const result = await start.start({
          key,
          ...(body.pipeline === undefined ? {} : { pipeline: body.pipeline }),
          force: asked.warnings,
        });
        options.audit(
          result.status === "started"
            ? `device ${device.id} started ${key} (run ${result.run_id})`
            : `device ${device.id} tried to start ${key}: refused (${result.why})`,
        );
        return json(200, { ok: true, step: "done", result: redactStart(result) });
      } catch (error) {
        if (error instanceof KodelError && error.code === "TASK_NOT_FOUND") {
          return fail(404, "not_found", "There is no such task.");
        }
        if (error instanceof KodelError && error.code === "INVALID_ARGUMENTS") {
          return fail(400, "bad_pipeline", redact(error.message));
        }
        throw error;
      }
    }
    return fail(404, "not_found", "No such thing.");
  };

  const api_ = async (
    request: WebRequest,
    device: Device,
    parts: string[],
  ): Promise<WebResponse> => {
    const { method } = request;
    if (parts[0] === "me" && method === "GET") {
      return json(200, {
        ok: true,
        device,
        project: api.project,
        source: api.source,
        canDecide: api.decide !== undefined,
        canComment: api.addComment !== undefined,
        canAsk: api.ask !== undefined,
        canTasks: api.tasks !== undefined,
        canCommentTask: api.addTaskComment !== undefined,
        canCreateTask: api.createTask !== undefined,
        canStartTask: api.startTask !== undefined,
        canStopAgent: api.stopAgent !== undefined,
      });
    }
    if (parts[0] === "logout" && method === "POST") {
      await devices.revoke(device.id);
      options.audit(`device ${device.id} "${device.name}" forgot itself`);
      return json(200, { ok: true }, { "set-cookie": cookie("", 0) });
    }
    if (parts[0] === "sessions" && method === "GET" && parts.length === 1) {
      const loaded = await api.sessions();
      return json(200, { ok: true, sessions: loaded.sessions, proposals: loaded.proposals });
    }
    if (parts[0] === "tasks") return await tasks_(request, device, parts);
    if (parts[0] !== "runs" || parts[1] === undefined) {
      return fail(404, "not_found", "No such thing.");
    }
    const runId = parts[1];
    const what = parts[2];
    if (what === "detail" && method === "GET") {
      const kind = request.query.get("kind");
      const node = request.query.get("node");
      const pick: DecisionRef | undefined =
        (kind === "gate" || kind === "pause") && node
          ? { kind, node, prompt: "", command: "" }
          : undefined;
      const detail = await api.detail(runId, pick);
      return detail
        ? json(200, { ok: true, detail })
        : fail(404, "not_found", "This run has nothing to show.");
    }
    if (what === "ask" && method === "GET") {
      if (!api.askThread) return fail(403, "ask_off", "Questions are off for this project.");
      return json(200, { ok: true, thread: await api.askThread(runId) });
    }
    if (what === "ask" && method === "POST") {
      if (!api.ask) return fail(403, "ask_off", "Questions are off for this project.");
      const body = parse(askBody, request.body);
      if (!body) return fail(400, "bad_request", "The question is not understood.");
      try {
        const question = body.question ?? "";
        const refs = (body.refs ?? []).map((r) => ({
          place: r.place,
          code: r.code,
          note: r.note ?? "",
        }));
        const thread = await api.ask(runId, question, refs);
        options.audit(
          `device ${device.id} asked about ${runId} (${question.length} chars, ${refs.length} places)`,
        );
        return json(200, { ok: true, thread });
      } catch (error) {
        if (error instanceof AskError) {
          return fail(error.code === "bad_question" ? 400 : 409, error.code, error.message);
        }
        throw error;
      }
    }
    if (what === "diff" && method === "GET") {
      const path = request.query.get("path");
      if (!path) return fail(400, "bad_request", "Which file?");
      return json(200, { ok: true, diff: diffRows(path, await api.diff(runId, path), redact) });
    }
    if (what === "comments" && method === "POST") {
      if (!api.addComment) return fail(403, "read_only", "Comments cannot be written here.");
      const body = parse(commentBody, request.body);
      if (!body) return fail(400, "bad_request", "The comment is not understood.");
      await api.addComment(runId, body.node, body.attempt, {
        severity: body.severity,
        location: body.location,
        description: body.description,
      });
      options.audit(`device ${device.id} commented on ${runId} ${body.node}#${body.attempt}`);
      return json(200, { ok: true });
    }
    if (what === "comments" && method === "DELETE") {
      if (!api.deleteComment) return fail(403, "read_only", "Comments cannot be written here.");
      const body = parse(deleteCommentBody, request.body);
      if (!body) return fail(400, "bad_request", "Which comment?");
      await api.deleteComment(runId, body.node, body.attempt, body.index);
      options.audit(
        `device ${device.id} removed a comment on ${runId} ${body.node}#${body.attempt}`,
      );
      return json(200, { ok: true });
    }
    if (what === "check" && method === "POST") {
      if (!api.check) return fail(403, "read_only", "Decisions cannot be made here.");
      const body = parse(checkBody, request.body);
      if (!body) return fail(400, "bad_request", "The decision is not understood.");
      const flow = nextFlow++;
      const decision: DecisionRequest = {
        flow,
        ref: body.ref as DecisionRef,
        decision: body.decision,
        ...(body.reason === undefined || body.reason === "" ? {} : { reason: body.reason }),
      };
      const result = await api.check(runId, decision);
      if (result.ok) {
        flows.set(flow, { device: device.id, runId, request: decision, at: clock() });
        for (const [key, f] of flows) if (clock() - f.at > 30 * 60_000) flows.delete(key);
      }
      return json(200, { ok: true, flow, result });
    }
    if (what === "stop-agent" && method === "POST") {
      const stop = api.stopAgent;
      if (!stop) return fail(403, "read_only", "Agents cannot be stopped here.");
      const body = parse(stopBody, request.body);
      if (!body) return fail(400, "bad_request", "The request is not understood.");
      if (body.flow === undefined) {
        const flow = nextFlow++;
        remember(flow, { kind: "stop", device: device.id, runId, at: clock() });
        return json(200, { ok: true, step: "confirm", flow });
      }
      const asked = actions.get(body.flow);
      actions.delete(body.flow);
      if (asked?.kind !== "stop" || asked.device !== device.id || asked.runId !== runId) {
        return fail(409, "not_checked", "Nothing was asked for this stop; look again.");
      }
      const result = await stop(runId);
      options.audit(
        result.status === "stopped"
          ? `device ${device.id} stopped the agent of ${runId}`
          : `device ${device.id} tried to stop the agent of ${runId}: refused (${result.why})`,
      );
      return json(200, { ok: true, step: "done", result: redactStop(result) });
    }
    if (what === "decide" && method === "POST") {
      if (!api.decide) return fail(403, "read_only", "Decisions cannot be made here.");
      const body = parse(decideBody, request.body);
      if (!body) return fail(400, "bad_request", "The decision is not understood.");
      const checked = flows.get(body.flow);
      flows.delete(body.flow);
      if (!checked || checked.device !== device.id || checked.runId !== runId) {
        return fail(409, "not_checked", "Nothing was checked for this decision; look again.");
      }
      const outcome = await api.decide(runId, checked.request);
      const { decision, ref } = checked.request;
      options.audit(
        `device ${device.id} "${device.name}": ${decision} ${runId} ${ref.node}${ref.attempt === undefined ? "" : `#${ref.attempt}`}: ${outcome.ok ? "written" : `refused (${outcome.message})`}`,
      );
      return json(200, { ok: true, outcome });
    }
    return fail(404, "not_found", "No such thing.");
  };

  const handle = async (request: WebRequest): Promise<WebResponse> => {
    try {
      if (request.method === "GET" || request.method === "HEAD") {
        const found = statics(request.path);
        if (found) return found;
      }
      if (!request.path.startsWith("/api/")) {
        return respond(404, "text/plain; charset=utf-8", "not found\n");
      }
      const parts = request.path
        .slice("/api/".length)
        .split("/")
        .map((p) => {
          try {
            return decodeURIComponent(p);
          } catch {
            return "";
          }
        });
      const writes = request.method !== "GET" && request.method !== "HEAD";
      if (writes) {
        if (!sameOrigin(request)) {
          return fail(403, "foreign_origin", "Requests from other sites are refused.");
        }
        if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
          return fail(415, "not_json", "Requests are sent as JSON.");
        }
      }
      if (parts[0] === "pair" && request.method === "POST") return await pair(request);
      const device = await authenticate(request.headers);
      if (!device) {
        return fail(401, "not_paired", "This device is not paired. Run `kodel web pair`.");
      }
      return await api_(request, device, parts);
    } catch (error) {
      return fail(500, "failed", messageOf(error));
    }
  };

  return { handle, authenticate };
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d2433"/><path d="M20 16v32M20 32l16-16M26 27l14 21" stroke="#7dd3a8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

const MANIFEST = JSON.stringify({
  name: "Kodel",
  short_name: "Kodel",
  start_url: "/",
  display: "standalone",
  background_color: "#11151c",
  theme_color: "#11151c",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
});
