/**
 * A session adapter for the tests of `kodel agent start | prune`: no processes. A start makes a row that
 * runs; the test sets every other row and state. It keeps what the real adapter's contract promises to
 * these commands: `remove` refuses a session that runs, `attach` one that does not.
 */
import type { StartOptions } from "@kodel-ai/local";
import {
  type Attachable,
  type AttachStream,
  foldSessionName,
  isTerminalState,
  type SessionCapabilities,
  SessionError,
  type SessionListEntry,
  type SessionSpec,
  type SessionStatus,
  type StartResult,
  type TailResult,
} from "@kodel-ai/pipeline-core";
import type { AgentSessions } from "../src/agent-commands";

const stream = (): AttachStream => ({
  write() {},
  pending: () => 0,
  onData() {},
  onClose() {},
  pause() {},
  resume() {},
  close() {},
});

export class FakeSessions implements AgentSessions {
  rows: SessionListEntry[] = [];
  readonly specs: SessionSpec[] = [];
  readonly options: StartOptions[] = [];
  readonly removed: string[] = [];
  readonly attached: string[] = [];
  readonly stopped: string[] = [];
  readonly tailed: string[] = [];
  /** Everything asked of the adapter, in order. */
  readonly calls: string[] = [];
  failStart: SessionError | undefined;
  /** Called at each listing, with its number (the first is 1): a test changes a row between two reads. */
  onList: ((read: number) => void) | undefined;
  /** What a session that was just started is: `running` unless a test says it ended at once. */
  startedAs: SessionStatus = { state: "running" };
  private counter = 0;
  private reads = 0;

  capabilities(): SessionCapabilities {
    return { pty: true, send: false, attach: true, lastOutputAt: false, streams: false };
  }

  /** Adds a row as a listing would show it. */
  add(row: Partial<SessionListEntry> & { id: string }): SessionListEntry {
    const entry: SessionListEntry = { status: { state: "exited", exitCode: 0 }, ...row };
    this.rows.push(entry);
    return entry;
  }

  private get(id: string): SessionListEntry {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new SessionError("NOT_FOUND", `no session ${id}`);
    return row;
  }

  async start(spec: SessionSpec, options: StartOptions = {}): Promise<StartResult> {
    this.calls.push("start");
    this.specs.push(spec);
    this.options.push(options);
    if (this.failStart) throw this.failStart;
    const id = `a_${(++this.counter).toString(36).padStart(9, "0")}_new0`;
    const name = spec.name === undefined ? undefined : foldSessionName(spec.name);
    this.rows.push({
      id,
      ...(name === undefined ? {} : { name }),
      command: (spec.argv ?? []).join(" "),
      mode: spec.mode ?? "pipes",
      ...(spec.agent === undefined ? {} : { agent: { ...spec.agent, source: "chosen" } }),
      status: { ...this.startedAs },
    });
    return { id, ...(name === undefined ? {} : { name }) };
  }

  async list(): Promise<SessionListEntry[]> {
    this.calls.push("list");
    this.onList?.(++this.reads);
    return this.rows.map((row) => ({ ...row, status: { ...row.status } }));
  }

  async status(id: string): Promise<SessionStatus> {
    this.calls.push(`status ${id}`);
    return { ...this.get(id).status };
  }

  async wait(id: string): Promise<SessionStatus> {
    return this.status(id);
  }

  async tail(id: string): Promise<TailResult> {
    this.get(id);
    this.tailed.push(id);
    return { text: `output of ${id}\n`, complete: true };
  }

  async stop(id: string): Promise<SessionStatus> {
    const row = this.get(id);
    this.stopped.push(id);
    row.status = { state: "killed", reason: "stopped" };
    return { ...row.status };
  }

  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${id}`);
    const row = this.get(id);
    if (!isTerminalState(row.status.state) || row.status.childAlive === true) {
      throw new SessionError("STILL_RUNNING", `session ${id} still runs; stop it first`);
    }
    this.rows = this.rows.filter((r) => r.id !== id);
    this.removed.push(id);
  }

  async attachable(id: string): Promise<Attachable> {
    const row = this.get(id);
    if (row.mode !== "pty") return { ok: false, reason: `session ${id} runs on pipes` };
    return row.status.state === "running"
      ? { ok: true }
      : { ok: false, reason: `session ${id} is ${row.status.state}` };
  }

  async attach(id: string): Promise<AttachStream> {
    this.calls.push(`attach ${id}`);
    const answer = await this.attachable(id);
    if (!answer.ok) throw new SessionError("NOT_ATTACHABLE", answer.reason);
    this.attached.push(id);
    return stream();
  }
}
