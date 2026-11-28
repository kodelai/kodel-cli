/** The page's calls to its server: JSON in and out, the device's cookie goes along by itself. */

import type {
  CheckResult,
  Comment,
  DecisionOutcome,
  DecisionRef,
  GateDetail,
  Session,
} from "../../tui/session";
import type { CardSlot, NewTaskInput, TasksLoad } from "../../tui/tasks-load";
import type { AskRef, AskThread } from "../ask";
import type { WebCancelOutcome, WebDiff } from "../handler";

export interface Me {
  device: { id: string; name: string };
  project: string;
  source: "demo" | "project";
  canDecide: boolean;
  canComment: boolean;
  canAsk: boolean;
  canTasks: boolean;
  canCommentTask: boolean;
  canCreateTask: boolean;
  canCancel: boolean;
}

export type CancelAnswer = Extract<WebCancelOutcome, { ok: true }>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data: { ok?: boolean; code?: string; message?: string } & Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, "bad_answer", `The server answered ${res.status}.`);
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(res.status, data.code ?? "failed", data.message ?? `Error ${res.status}`);
  }
  return data as T;
}

/** The API of one run; a URL, not a place on disk. */
const RUNS_API = "/api/runs";
const TASKS_API = "/api/tasks";
const run = (id: string) => `${RUNS_API}/${encodeURIComponent(id)}`;

export const api = {
  me: () => call<Me & { ok: true }>("GET", "/api/me"),
  pair: (code: string, name: string) => call<{ ok: true }>("POST", "/api/pair", { code, name }),
  logout: () => call<{ ok: true }>("POST", "/api/logout", {}),
  sessions: () => call<{ sessions: Session[]; proposals: number }>("GET", "/api/sessions"),
  detail: (id: string, pick?: DecisionRef) => {
    const q = pick ? `?kind=${pick.kind}&node=${encodeURIComponent(pick.node)}` : "";
    return call<{ detail: GateDetail }>("GET", `${run(id)}/detail${q}`).then((r) => r.detail);
  },
  diff: (id: string, path: string) =>
    call<{ diff: WebDiff }>("GET", `${run(id)}/diff?path=${encodeURIComponent(path)}`).then(
      (r) => r.diff,
    ),
  addComment: (id: string, node: string, attempt: number, c: Comment) =>
    call<{ ok: true }>("POST", `${run(id)}/comments`, { node, attempt, ...c }),
  deleteComment: (id: string, node: string, attempt: number, index: number) =>
    call<{ ok: true }>("DELETE", `${run(id)}/comments`, { node, attempt, index }),
  check: (
    id: string,
    ref: DecisionRef,
    decision: "approve" | "reject" | "resume",
    reason?: string,
  ) =>
    call<{ flow: number; result: CheckResult }>("POST", `${run(id)}/check`, {
      ref,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }),
  tasks: () => call<{ tasks: TasksLoad }>("GET", TASKS_API).then((r) => r.tasks),
  task: (key: string) =>
    call<{ task: CardSlot }>("GET", `${TASKS_API}/${encodeURIComponent(key)}`).then((r) => r.task),
  commentTask: (key: string, text: string) =>
    call<{ ok: true }>("POST", `${TASKS_API}/${encodeURIComponent(key)}/comments`, { text }),
  createTask: (input: NewTaskInput) =>
    call<{ key: string }>("POST", TASKS_API, input).then((r) => r.key),
  askThread: (id: string) =>
    call<{ thread: AskThread }>("GET", `${run(id)}/ask`).then((r) => r.thread),
  ask: (id: string, question: string, refs: AskRef[] = []) =>
    call<{ thread: AskThread }>("POST", `${run(id)}/ask`, { question, refs }).then((r) => r.thread),
  checkCancel: (id: string, reason: string) =>
    call<{ flow: number; task: string | null }>("POST", `${run(id)}/cancel/check`, { reason }),
  cancel: (id: string, flow: number) =>
    call<{ answer: CancelAnswer }>("POST", `${run(id)}/cancel/decide`, { flow }).then(
      (r) => r.answer,
    ),
  decide: (id: string, flow: number) =>
    call<{ outcome: DecisionOutcome }>("POST", `${run(id)}/decide`, { flow }).then(
      (r) => r.outcome,
    ),
};
