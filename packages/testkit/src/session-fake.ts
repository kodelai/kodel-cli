/**
 * An in-memory `SessionAdapter` for tests: no processes. A program is an argv the fake understands:
 * `["fake","exit","3"]`, `["fake","echo","text","3"]`, `["fake","hang"]` (never ends until stopped).
 * It builds a `SessionSnapshot` and asks the core `deriveStatus`, so the contract also exercises the decision table.
 */
import {
  deriveStatus,
  foldSessionName,
  isSessionId,
  type SessionAdapter,
  type SessionCapabilities,
  SessionError,
  type SessionListEntry,
  type SessionSpec,
  type SessionState,
  type SessionStatus,
  type StartResult,
  type TailResult,
  type TailStream,
  validateSpec,
} from "@kodel-ai/pipeline-core";

interface Entry {
  spec: SessionSpec;
  name?: string;
  state: SessionState;
  exitCode?: number;
  reason?: "stopped" | "timeout";
  tail: string;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FakeSessionAdapter implements SessionAdapter {
  protected readonly entries = new Map<string, Entry>();
  protected readonly usedNames = new Set<string>();
  private counter = 0;

  capabilities(): SessionCapabilities {
    return { pty: false, send: false, attach: false, lastOutputAt: false, streams: true };
  }

  async start(spec: SessionSpec): Promise<StartResult> {
    const problem = validateSpec(spec);
    if (problem) throw new SessionError("SPEC_INVALID", problem);
    const name = spec.name === undefined ? undefined : foldSessionName(spec.name);
    if (name !== undefined) {
      const live = [...this.entries.values()].some((e) => e.name === name);
      if (live || this.usedNames.has(name)) {
        throw new SessionError(live ? "NAME_TAKEN" : "NAME_USED", `name ${name}`);
      }
    }
    // a name outlives its session only when a host started it (the consumer's retry rule)
    if (name !== undefined && spec.origin === "host") this.usedNames.add(name);
    this.counter += 1;
    const id = `a_${this.counter.toString(36).padStart(9, "0")}_0000`;
    const entry: Entry = {
      spec,
      ...(name !== undefined ? { name } : {}),
      state: "running",
      tail: "",
      started: Date.now(),
    };
    this.entries.set(id, entry);
    const [, verb, a, b] = spec.argv ?? [];
    if (verb === "exit") this.finish(entry, Number(a ?? 0));
    else if (verb === "echo") {
      entry.tail = `${a ?? ""}\n`;
      this.finish(entry, Number(b ?? 0));
    }
    if (spec.timeoutMs !== undefined && entry.state === "running") {
      entry.timer = setTimeout(() => {
        if (entry.state === "running") {
          entry.state = "killed";
          entry.reason = "timeout";
        }
      }, spec.timeoutMs);
    }
    return { id, ...(name !== undefined ? { name } : {}) };
  }

  private finish(entry: Entry, code: number): void {
    entry.state = "exited";
    entry.exitCode = code;
  }

  private entry(id: string): Entry {
    const entry = isSessionId(id) ? this.entries.get(id) : undefined;
    if (!entry) throw new SessionError("NOT_FOUND", `no session ${id}`);
    return entry;
  }

  private derive(entry: Entry): SessionStatus {
    const result = deriveStatus(
      {
        exists: true,
        session: { v: 1, started: entry.started },
        status: {
          state: entry.state,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        },
        holderAlive: entry.state === "running",
        childAlive: false,
        stop: "missing",
      },
      Date.now(),
    );
    if (!result.ok)
      throw new SessionError(result.code === "UNKNOWN" ? "NOT_FOUND" : result.code, result.code);
    return result.status;
  }

  async status(id: string): Promise<SessionStatus> {
    return this.derive(this.entry(id));
  }

  async wait(
    id: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<SessionStatus & { timedOut?: boolean }> {
    const entry = this.entry(id);
    const deadline =
      opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.timeoutMs;
    while (entry.state === "running") {
      if (Date.now() >= deadline) return { ...this.derive(entry), timedOut: true };
      await sleep(5);
    }
    return this.derive(entry);
  }

  async tail(id: string, _bytes?: number, stream: TailStream = "both"): Promise<TailResult> {
    const entry = this.entry(id);
    // everything the fake prints is stdout
    return { text: stream === "stderr" ? "" : entry.tail, complete: true };
  }

  async stop(id: string): Promise<SessionStatus> {
    const entry = this.entry(id);
    if (entry.state === "running") {
      entry.state = "killed";
      entry.reason = "stopped";
    }
    return this.derive(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = this.entry(id);
    if (entry.state === "running")
      throw new SessionError("STILL_RUNNING", `session ${id} still runs`);
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  async list(filter?: { name?: string }): Promise<SessionListEntry[]> {
    const wanted = filter?.name === undefined ? undefined : foldSessionName(filter.name);
    return [...this.entries.entries()]
      .filter(([, e]) => wanted === undefined || e.name === wanted)
      .map(([id, e]) => ({
        id,
        ...(e.name !== undefined ? { name: e.name } : {}),
        status: this.derive(e),
      }));
  }
}

/**
 * What a remote runner (Kodel Server) offers: the core methods only, opaque ids, no local extras. It wraps the fake,
 * so the contract proves nothing relies on a local detail such as the id shape or a directory.
 */
export class RemoteStyleSessionAdapter implements SessionAdapter {
  private readonly inner = new FakeSessionAdapter();
  private readonly toRemote = new Map<string, string>();
  private readonly toInner = new Map<string, string>();
  private next = 41;

  capabilities(): SessionCapabilities {
    return { pty: false, send: false, attach: false, lastOutputAt: false, streams: false };
  }

  private inside(id: string): string {
    const inner = this.toInner.get(id);
    if (inner === undefined) throw new SessionError("NOT_FOUND", `no session ${id}`);
    return inner;
  }

  async start(spec: SessionSpec): Promise<StartResult> {
    const problem = validateSpec(spec); // the contract's refusals hold before the spec leaves the machine
    if (problem) throw new SessionError("SPEC_INVALID", problem);
    const { cwd: _cwd, ...rest } = spec; // a remote runner may not take a local cwd
    const started = await this.inner.start({ ...rest, cwd: "/remote" });
    this.next += 1;
    const remote = `srv-${this.next}`;
    this.toRemote.set(started.id, remote);
    this.toInner.set(remote, started.id);
    return { id: remote, ...(started.name !== undefined ? { name: started.name } : {}) };
  }
  async status(id: string): Promise<SessionStatus> {
    return this.inner.status(this.inside(id));
  }
  async wait(
    id: string,
    opts?: { timeoutMs?: number },
  ): Promise<SessionStatus & { timedOut?: boolean }> {
    return this.inner.wait(this.inside(id), opts);
  }
  async tail(id: string, bytes?: number, stream?: TailStream): Promise<TailResult> {
    if (stream !== undefined && stream !== "both") {
      throw new SessionError("UNSUPPORTED", "this runner gives one stream");
    }
    return this.inner.tail(this.inside(id), bytes);
  }
  async stop(id: string): Promise<SessionStatus> {
    return this.inner.stop(this.inside(id));
  }
  async remove(id: string): Promise<void> {
    await this.inner.remove(this.inside(id));
    this.toInner.delete(id);
  }
  async list(filter?: { name?: string }): Promise<SessionListEntry[]> {
    const rows = await this.inner.list(filter);
    return rows.map((r) => ({ ...r, id: this.toRemote.get(r.id) ?? r.id }));
  }
}
