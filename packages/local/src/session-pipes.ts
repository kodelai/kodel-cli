import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_START_GRACE_MS,
  deriveStatus,
  encodeRecord,
  foldSessionName,
  isLocalSessionId,
  planSend,
  redactText,
  SESSION_FORMAT_VERSION,
  type SessionAdapter,
  type SessionCapabilities,
  SessionError,
  type SessionListEntry,
  type SessionSpec,
  type SessionStatus,
  type StartResult,
  type TailResult,
  validateSpec,
} from "@kodel-ai/pipeline-core";
import { KILL_GRACE_MS, killTree } from "./command";
import { descendantsOf, liveProcess, processIdentity, sameIdentity } from "./process-table";
import { sessionEnv } from "./session-env";
import { BOOT_FILE, frameInput, type HolderInput, INPUT_FIFO, readTail } from "./session-holder";
import {
  ensurePrivateDir,
  newSessionId,
  type SessionPlace,
  sessionDirOf,
  sessionPlace,
} from "./session-paths";
import {
  createExclusive,
  type NameMarker,
  publishSession,
  readSession,
  readStatus,
  removeDir,
  replaceRecord,
  type SessionRecord,
  STATUS_FILE,
  STOP_FILE,
  type StatusRecord,
  snapshotOf,
} from "./session-records";

export interface PipesAdapterOptions {
  base: string;
  root: string;
  uid?: number;
  /** How to run the holder entry: `exec args... holder`; the intermediate gets this as JSON. */
  holder: { exec: string; args: string[] };
  /** The intermediate process: `exec args... intermediate <json>`. */
  intermediate: { exec: string; args: string[] };
  now?: () => number;
  graceMs?: number;
  bootTimeoutMs?: number;
  pollMs?: number;
  build?: string;
  baseEnv?: Record<string, string | undefined>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PipesSessionAdapter implements SessionAdapter {
  readonly place: SessionPlace;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly poll: number;

  constructor(private readonly opts: PipesAdapterOptions) {
    this.place = sessionPlace({
      base: opts.base,
      root: opts.root,
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    });
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? DEFAULT_START_GRACE_MS;
    this.poll = opts.pollMs ?? 100;
  }

  capabilities(): SessionCapabilities {
    return { pty: false, send: true, attach: false, lastOutputAt: true };
  }

  private markerPath(name: string): string {
    return join(this.place.namesDir, `${foldSessionName(name)}.json`);
  }

  async start(spec: SessionSpec): Promise<StartResult> {
    if (process.platform === "win32") {
      throw new SessionError("PLATFORM_UNSUPPORTED", "sessions are not supported on Windows yet");
    }
    const problem = validateSpec(spec);
    if (problem) throw new SessionError("SPEC_INVALID", problem);
    if (spec.mode === "pty") throw new SessionError("UNSUPPORTED", "this adapter runs pipes only");

    ensurePrivateDir(this.place.runDir);
    ensurePrivateDir(this.place.dir);
    ensurePrivateDir(this.place.namesDir);

    const id = newSessionId(this.now());
    const started = this.now();
    const dir = sessionDirOf(this.place, id);
    let marker: string | undefined;
    if (spec.name !== undefined) {
      marker = this.markerPath(spec.name);
      const claim: NameMarker = {
        v: SESSION_FORMAT_VERSION,
        name: foldSessionName(spec.name),
        id,
        started,
      };
      if (!createExclusive(marker, encodeRecord("name", claim))) {
        const holders = await this.list({ name: spec.name });
        throw new SessionError(
          holders.length > 0 ? "NAME_TAKEN" : "NAME_USED",
          holders.length > 0
            ? `a session named ${spec.name} exists (${holders[0]?.id})`
            : `the name ${spec.name} was used by a session that is gone; a person frees it with \`kodel agent forget-name\``,
        );
      }
    }

    const rollback = () => {
      removeDir(dir);
      removeDir(`${dir}.tmp-${process.pid}`);
      if (marker) removeDir(marker);
    };

    const { env: _env, ...safeSpec } = spec;
    const record: SessionRecord = {
      v: SESSION_FORMAT_VERSION,
      id,
      ...(spec.name !== undefined ? { name: foldSessionName(spec.name) } : {}),
      mode: "pipes",
      spec: {
        ...safeSpec,
        argv: spec.argv?.map((a) => redactText(a)),
        envNames: Object.keys(spec.env ?? {}),
      },
      started,
      root: this.opts.root,
    };
    try {
      publishSession(dir, record);
    } catch (error) {
      rollback();
      throw new SessionError("STATE_UNWRITABLE", (error as Error).message);
    }

    const input: HolderInput = {
      v: SESSION_FORMAT_VERSION,
      dir,
      ...(spec.command !== undefined ? { command: spec.command } : {}),
      ...(spec.argv !== undefined ? { argv: spec.argv } : {}),
      cwd: spec.cwd,
      env: sessionEnv(spec.env, spec.inheritEnv ?? true, this.opts.baseEnv),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.input ? { input: true } : {}),
      graceMs: this.graceMs,
      started,
      ...(this.opts.build ? { build: this.opts.build } : {}),
    };

    const middle = spawn(
      this.opts.intermediate.exec,
      [...this.opts.intermediate.args, "intermediate", JSON.stringify(this.opts.holder)],
      { detached: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    middle.on("error", () => {});
    middle.stdin?.on("error", () => {});
    middle.stdin?.end(frameInput(input));
    const bootLine = await this.awaitBoot(dir);
    middle.unref();
    if (bootLine !== "ready") {
      // A holder that never reported cannot be trusted: nothing ran (or it is dead), so name and folder go.
      rollback();
      throw new SessionError(
        "HOLDER_BOOT_FAILED",
        redactText(bootLine.replace(/^HOLDER_BOOT_FAILED:?/, "")),
      );
    }
    return { id, ...(spec.name !== undefined ? { name: foldSessionName(spec.name) } : {}) };
  }

  /** The holder reports its boot in `boot.txt` of the session folder; the wait is bounded (10 s by default). */
  private async awaitBoot(dir: string): Promise<string> {
    const end = Date.now() + (this.opts.bootTimeoutMs ?? 10_000);
    for (;;) {
      try {
        const text = readFileSync(join(dir, BOOT_FILE), "utf8").trim();
        if (text !== "") return text;
      } catch {
        // not written yet
      }
      if (Date.now() >= end) return "HOLDER_BOOT_FAILED:no answer within the boot bound";
      await sleep(20);
    }
  }

  /** Read-only: never writes a tombstone. */
  private read(id: string): SessionStatus {
    const dir = sessionDirOf(this.place, id);
    const result = deriveStatus(snapshotOf(dir), this.now(), this.graceMs);
    if (!result.ok) {
      throw new SessionError(
        result.code === "UNKNOWN" ? "NOT_FOUND" : result.code,
        `session ${id}: ${result.code}`,
      );
    }
    const status = result.status;
    const recorded = readStatus(dir);
    if (
      recorded !== "missing" &&
      recorded !== "unreadable" &&
      recorded.lastOutputAt !== undefined
    ) {
      status.lastOutputAt = recorded.lastOutputAt;
    }
    return status;
  }

  /** Makes `lost` final: the first reader to find no `status.json` after the grace creates the tombstone exclusively. */
  private settle(id: string): SessionStatus {
    const status = this.read(id);
    if (status.state === "lost" && status.reason === "no_status") {
      const dir = sessionDirOf(this.place, id);
      createExclusive(
        join(dir, STATUS_FILE),
        encodeRecord("status", {
          v: SESSION_FORMAT_VERSION,
          state: "lost",
          by: "reader",
          reason: "no_status",
          since: this.now(),
        }),
      );
      return this.read(id);
    }
    return status;
  }

  async status(id: string): Promise<SessionStatus> {
    return this.settle(id);
  }

  async wait(
    id: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SessionStatus & { timedOut?: boolean }> {
    const deadline =
      opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : this.now() + opts.timeoutMs;
    for (;;) {
      const status = this.settle(id);
      if (status.state !== "starting" && status.state !== "running") return status;
      if (opts.signal?.aborted) return { ...status, timedOut: true };
      if (this.now() >= deadline) return { ...status, timedOut: true };
      await sleep(this.poll);
    }
  }

  async tail(id: string, bytes = 64 * 1024): Promise<TailResult> {
    const dir = sessionDirOf(this.place, id);
    if (!existsSync(dir)) throw new SessionError("NOT_FOUND", `no session ${id}`);
    const text = readTail(dir);
    const cut = Buffer.from(text).length > bytes;
    return {
      text: cut ? Buffer.from(text).subarray(-bytes).toString("utf8") : text,
      complete: !cut,
    };
  }

  async stop(id: string): Promise<SessionStatus> {
    const dir = sessionDirOf(this.place, id);
    const before = this.settle(id);
    const recorded = readStatus(dir);
    if (recorded === "missing" || recorded === "unreadable") return before;
    const child = recorded.child;
    if (before.state !== "running" && !(before.childAlive && child)) return before;
    if (!child) return before;

    // The recorded identity must still be the live process; unknown means refuse, never signal a stranger.
    const now = processIdentity(child.pid);
    if (child.identity && now) {
      const same = sameIdentity(child.identity, now);
      if (same === undefined)
        throw new SessionError("IDENTITY_UNKNOWN", `cannot compare the identity of ${child.pid}`);
      if (!same) return this.settle(id);
    } else if (child.identity && !now && liveProcess(child.pid)) {
      throw new SessionError("IDENTITY_UNKNOWN", `cannot read the identity of ${child.pid}`);
    }
    if (!existsSync(join(dir, STOP_FILE))) {
      replaceRecord(
        join(dir, STOP_FILE),
        encodeRecord("stop", {
          v: SESSION_FORMAT_VERSION,
          by: "stop",
          at: this.now(),
          ...(now ? { identity: now } : {}),
        }),
      );
    }
    const descendants = descendantsOf(child.pid).map((pid) => ({
      pid,
      identity: processIdentity(pid),
    }));
    killTree(child.pid);
    for (const d of descendants) {
      const alive = processIdentity(d.pid);
      if (alive && d.identity && sameIdentity(d.identity, alive)) {
        try {
          process.kill(d.pid, "SIGTERM");
        } catch {
          // gone
        }
      }
    }
    // stop waits past the kill grace so the escalation in killTree runs in this process
    const limit = this.now() + KILL_GRACE_MS + 3_000;
    while (this.now() < limit) {
      const s = this.settle(id);
      if (s.state !== "running" && s.state !== "starting" && !liveProcess(child.pid)) break;
      await sleep(this.poll);
    }
    for (const d of descendants) {
      const alive = processIdentity(d.pid);
      if (alive && d.identity && sameIdentity(d.identity, alive)) {
        try {
          process.kill(d.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    return this.settle(id);
  }

  /**
   * Writes into the child's stdin (a session started with `input: true`). A pipe is not a terminal, so there is no
   * bracketed paste: the text and a newline. It returns the bytes written and promises nothing about a program that
   * does not read.
   */
  async send(
    id: string,
    text: string,
    opts: { submit?: boolean } = {},
  ): Promise<{ bytes: number }> {
    const dir = sessionDirOf(this.place, id);
    const status = this.settle(id);
    if (status.state !== "running")
      throw new SessionError("NOT_RUNNING", `session ${id} is ${status.state}`);
    const record = readSession(dir);
    if (typeof record === "string" || !record.spec.input) {
      throw new SessionError("UNSUPPORTED", `session ${id} was not started with input`);
    }
    const plan = planSend(text, false, "\n");
    const data = opts.submit === false ? plan.paste : `${plan.paste}${plan.submit}`;
    const fd = openSync(join(dir, INPUT_FIFO), constants.O_WRONLY | constants.O_NONBLOCK);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return { bytes: Buffer.byteLength(data) };
  }

  async remove(id: string): Promise<void> {
    const dir = sessionDirOf(this.place, id);
    if (!existsSync(dir)) return;
    const record = readSession(dir);
    if (record === "missing") {
      removeDir(dir); // an orphan without session.json: nothing runs there
      return;
    }
    const status = this.settle(id);
    if (status.state === "starting" || status.state === "running" || status.childAlive) {
      throw new SessionError("STILL_RUNNING", `session ${id} still runs; stop it first`);
    }
    removeDir(dir); // the name marker stays
  }

  async list(filter?: { name?: string }): Promise<SessionListEntry[]> {
    if (!existsSync(this.place.dir)) return [];
    const entries: SessionListEntry[] = [];
    const wanted = filter?.name === undefined ? undefined : foldSessionName(filter.name);
    for (const entry of readdirSync(this.place.dir)) {
      if (!isLocalSessionId(entry)) continue;
      const record = readSession(join(this.place.dir, entry));
      if (typeof record === "string") continue;
      if (wanted !== undefined && record.name !== wanted) continue;
      try {
        entries.push({
          id: entry,
          ...(record.name !== undefined ? { name: record.name } : {}),
          status: this.read(entry),
        });
      } catch {
        // an unreadable or newer entry is skipped by this listing
      }
    }
    return entries;
  }
}
