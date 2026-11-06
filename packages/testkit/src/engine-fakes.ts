/**
 * Fakes for engine steps (T-42): a session adapter whose every answer a test sets, that counts the
 * starts and throws on `remove` (the host must never call it); a resolver that hands back a fixed
 * launch and can be held (a frozen issuer); and a Node script that plays the engine's program.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EngineLaunch,
  type EngineLaunchRequest,
  type EngineResolver,
  foldSessionName,
  type SessionAdapter,
  type SessionCapabilities,
  SessionError,
  type SessionErrorCode,
  type SessionListEntry,
  type SessionSpec,
  type SessionStatus,
  type StartResult,
  type TailResult,
} from "@kodel-ai/pipeline-core";

interface ScriptedSession {
  id: string;
  name?: string;
  spec: SessionSpec;
  status: SessionStatus;
  stdout: string;
  complete: boolean;
}

/** A gate a fake waits at until the test opens it. */
export class Gate {
  private opened = false;
  private waiters: (() => void)[] = [];
  open(): void {
    this.opened = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  wait(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * A session adapter whose sessions are what the test says. `start` records the spec and counts; a
 * session runs until `finish` is called. Faults: `failStart` (a code, and whether the session folder
 * is there all the same, as after a crash inside `start()`), `failList`, `unreadableEntry`, `failWait`.
 */
export class ScriptedSessionAdapter implements SessionAdapter {
  readonly sessions = new Map<string, ScriptedSession>();
  readonly specs: SessionSpec[] = [];
  starts = 0;
  removes = 0;
  failStart: { code: SessionErrorCode; listed?: boolean } | undefined;
  failList = false;
  unreadableEntry = false;
  failWait: SessionErrorCode | undefined;
  /** Held before `start` answers (the start is under the run's lock). */
  startGate: Gate | undefined;
  private counter = 0;
  private readonly finished = new Map<string, () => void>();

  capabilities(): SessionCapabilities {
    return { pty: false, send: false, attach: false, lastOutputAt: false, streams: true };
  }

  async start(spec: SessionSpec): Promise<StartResult> {
    this.starts += 1;
    this.specs.push(spec);
    await this.startGate?.wait();
    const name = spec.name === undefined ? undefined : foldSessionName(spec.name);
    const id = `a_${(++this.counter).toString(36).padStart(9, "0")}_fake`;
    const fault = this.failStart;
    if (fault !== undefined && fault.listed !== true) {
      throw new SessionError(fault.code, `the fake refused the start (${fault.code})`);
    }
    this.sessions.set(id, {
      id,
      ...(name === undefined ? {} : { name }),
      spec,
      status: { state: "running" },
      stdout: "",
      complete: true,
    });
    if (fault !== undefined) {
      throw new SessionError(
        fault.code,
        `the fake failed after the folder was made (${fault.code})`,
      );
    }
    return { id, ...(name === undefined ? {} : { name }) };
  }

  /** End a session with this status and this stdout. */
  finish(id: string, status: SessionStatus, stdout = "", complete = true): void {
    const session = this.get(id);
    session.status = status;
    session.stdout = stdout;
    session.complete = complete;
    this.finished.get(id)?.();
  }

  /** The only session, or the one with this name. */
  only(name?: string): ScriptedSession {
    const all = [...this.sessions.values()].filter(
      (s) => name === undefined || s.name === foldSessionName(name),
    );
    const [first] = all;
    if (first === undefined || all.length !== 1) {
      throw new Error(`expected one session, found ${all.length}`);
    }
    return first;
  }

  private get(id: string): ScriptedSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError("NOT_FOUND", `no session ${id}`);
    return session;
  }

  async status(id: string): Promise<SessionStatus> {
    return { ...this.get(id).status };
  }

  async wait(
    id: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SessionStatus & { timedOut?: boolean }> {
    if (this.failWait !== undefined) throw new SessionError(this.failWait, "the fake cannot read");
    const session = this.get(id);
    const running = () => session.status.state === "running" || session.status.state === "starting";
    if (!running()) return { ...session.status };
    await new Promise<void>((resolve) => {
      this.finished.set(id, resolve);
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      if (opts.timeoutMs !== undefined) setTimeout(resolve, opts.timeoutMs);
    });
    return running() ? { ...session.status, timedOut: true } : { ...session.status };
  }

  async tail(id: string, bytes = 64 * 1024): Promise<TailResult> {
    const { stdout, complete } = this.get(id);
    const buffer = Buffer.from(stdout);
    const cut = buffer.length > bytes;
    return {
      text: cut ? buffer.subarray(-bytes).toString("utf8") : stdout,
      complete: complete && !cut,
    };
  }

  async stop(id: string): Promise<SessionStatus> {
    const session = this.get(id);
    if (session.status.state === "running") this.finish(id, { state: "killed", reason: "stopped" });
    return { ...session.status };
  }

  async remove(_id: string): Promise<void> {
    this.removes += 1;
    throw new Error("an engine step's host must never remove a session");
  }

  async list(): Promise<SessionListEntry[]> {
    if (this.failList) throw new SessionError("CANNOT_READ", "the fake cannot list");
    const rows: SessionListEntry[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      ...(s.name === undefined ? {} : { name: s.name }),
      status: { ...s.status },
    }));
    if (this.unreadableEntry) {
      rows.push({ id: "a_unreadabl_0000", status: { state: "lost" }, problem: "CANNOT_READ" });
    }
    return rows;
  }
}

/** A resolver that hands back one launch (the prompt as the last argument) and can be held. */
export class FakeEngineResolver implements EngineResolver {
  readonly requests: EngineLaunchRequest[] = [];
  gate: Gate | undefined;
  refuse: string | undefined;

  constructor(private readonly launch: Partial<EngineLaunch> & { argv?: string[] } = {}) {}

  async resolve(request: EngineLaunchRequest, where: { cwd: string }) {
    this.requests.push(request);
    await this.gate?.wait();
    if (this.refuse !== undefined) return { ok: false as const, reason: this.refuse };
    return {
      ok: true as const,
      launch: {
        argv: [...(this.launch.argv ?? ["fake-engine"]), "--", request.prompt],
        cwd: where.cwd,
        env: this.launch.env ?? { PATH: "/usr/bin" },
        timeoutMs: this.launch.timeoutMs ?? 60_000,
        secrets: this.launch.secrets ?? [],
      },
    };
  }
}

/**
 * A Node script that plays an engine's program: it prints `stdout` (a JSON result by default) and exits
 * with `exit`. Returns the `command` of a profile that runs it.
 */
export function nodeScriptEngine(
  dir: string,
  options: { stdout?: string; exit?: number; sleepMs?: number; name?: string } = {},
): string[] {
  const path = join(dir, `${options.name ?? "engine"}.mjs`);
  const stdout = options.stdout ?? JSON.stringify({ summary: "done by the engine" });
  writeFileSync(
    path,
    [
      "const prompt = process.argv.at(-1) ?? '';",
      `setTimeout(() => {`,
      `  process.stdout.write(${JSON.stringify(stdout)}.replace('{{prompt_bytes}}', String(Buffer.byteLength(prompt))));`,
      `  process.exitCode = ${options.exit ?? 0};`,
      `}, ${options.sleepMs ?? 0});`,
      "",
    ].join("\n"),
  );
  return [process.execPath, path];
}
