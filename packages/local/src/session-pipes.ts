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
  type RedactRule,
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
  type TailStream,
  validateSpec,
} from "@kodel-ai/pipeline-core";
import { KILL_GRACE_MS, killTree } from "./command";
import {
  descendantsOf,
  liveProcess,
  machineId,
  processIdentity,
  sameIdentity,
  sameProcess,
} from "./process-table";
import { sessionEnv } from "./session-env";
import {
  BOOT_FILE,
  frameInput,
  type HolderInput,
  INPUT_FIFO,
  readTail,
  type WireRule,
} from "./session-holder";
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
  readMarker,
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
  /** Project redaction rules; one with a function cannot reach the holder and ends the session `rules_unknown`. */
  rules?: RedactRule[];
}

/** The command a person typed, for `ls`: a shell command, or the argv joined (already redacted in the record). */
const commandOf = (record: SessionRecord): string =>
  record.spec.command ?? (record.spec.argv ?? []).join(" ");

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
    return { pty: false, send: true, attach: false, lastOutputAt: true, streams: true };
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
    if (spec.lifetime === "with-starter" || spec.parent !== undefined) {
      throw new SessionError("UNSUPPORTED", "lifetime with-starter and parent are not built yet");
    }

    ensurePrivateDir(this.place.runDir);
    ensurePrivateDir(this.place.dir);
    ensurePrivateDir(this.place.namesDir);

    const started = this.now();
    let id = newSessionId(started);
    while (existsSync(sessionDirOf(this.place, id))) id = newSessionId(started);
    const dir = sessionDirOf(this.place, id);
    let marker: string | undefined;
    if (spec.name !== undefined) {
      const markerFile = this.markerPath(spec.name);
      marker = markerFile;
      const claim: NameMarker = {
        v: SESSION_FORMAT_VERSION,
        name: foldSessionName(spec.name),
        id,
        started,
      };
      let retried = false;
      for (;;) {
        if (!createExclusive(markerFile, encodeRecord("name", claim))) {
          marker = undefined; // not ours: never rolled back
          const held = readMarker(markerFile);
          if (held === "missing" && !retried) {
            // it was removed between our create and our read: claim again once
            retried = true;
            continue;
          }
          if (held === "newer") {
            throw new SessionError("NEWER_FORMAT", "the name marker was written by a newer kodel");
          }
          // The marker's own id decides: its folder is there (taken) or it is gone (used). A starter that has
          // claimed the name but not yet published its folder is told apart by looking once more a moment later.
          let live = typeof held !== "string" && existsSync(sessionDirOf(this.place, held.id));
          if (!live && typeof held !== "string") {
            await sleep(150);
            live = existsSync(sessionDirOf(this.place, held.id));
          }
          throw new SessionError(
            live || held === "unreadable" ? "NAME_TAKEN" : "NAME_USED",
            live || held === "unreadable"
              ? `a session named ${spec.name} exists`
              : `the name ${spec.name} was used by a session that is gone; a person frees it with \`kodel agent forget-name\``,
          );
        }
        marker = markerFile; // ours now, and rolled back if the start fails
        break;
      }
    }

    let published = false;
    const rollback = () => {
      if (published) removeDir(dir);
      removeDir(`${dir}.tmp-${process.pid}`);
      if (marker) removeDir(marker);
    };

    const { env: _env, command, ...safeSpec } = spec;
    const record: SessionRecord = {
      v: SESSION_FORMAT_VERSION,
      id,
      ...(spec.name !== undefined ? { name: foldSessionName(spec.name) } : {}),
      mode: "pipes",
      spec: {
        ...safeSpec,
        ...(command !== undefined ? { command: redactText(command, this.opts.rules ?? []) } : {}),
        ...(spec.argv !== undefined
          ? { argv: spec.argv.map((a) => redactText(a, this.opts.rules ?? [])) }
          : {}),
        envNames: Object.keys(spec.env ?? {}),
      },
      started,
      root: this.opts.root,
      ...(machineId() ? { machine: machineId() as string } : {}),
    };
    try {
      publishSession(dir, record);
      published = true;
    } catch (error) {
      rollback();
      throw new SessionError("STATE_UNWRITABLE", (error as Error).message);
    }

    const rules = this.opts.rules ?? [];
    const wire: WireRule[] = rules
      .filter((r) => r.replace === undefined)
      .map((r) => ({ name: r.name, source: r.pattern.source, flags: r.pattern.flags }));
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
      ...(wire.length > 0 ? { rules: wire } : {}),
      ...(rules.some((r) => r.replace !== undefined) ? { rulesUnknown: true } : {}),
    };

    const middle = spawn(
      this.opts.intermediate.exec,
      [...this.opts.intermediate.args, "intermediate", JSON.stringify(this.opts.holder)],
      { detached: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    middle.on("error", () => {});
    middle.stdin?.on("error", () => {});
    middle.stdin?.end(frameInput(input));
    const boot = await this.awaitBoot(dir);
    middle.unref();
    if (boot.line !== "ready") {
      const why = redactText(boot.line.replace(/^HOLDER_BOOT_FAILED:?/, ""), rules);
      if (boot.timedOut) {
        // No answer in time. The tombstone, created exclusively, makes the session final: a holder that is late
        // then finds it and never starts the child. If the holder was first, it may be starting the child, so the
        // session and its name stay and the person is told.
        let tombstone = false;
        try {
          tombstone = createExclusive(
            join(dir, STATUS_FILE),
            encodeRecord("status", {
              v: SESSION_FORMAT_VERSION,
              state: "lost",
              by: "reader",
              reason: "no_status",
              since: this.now(),
            }),
          );
        } catch {
          tombstone = true; // the folder is gone: nothing can run in it
        }
        if (!tombstone) {
          throw new SessionError(
            "HOLDER_BOOT_FAILED",
            `the holder did not answer in time but has begun; the session ${id} stays (see \`kodel agent ls\`)`,
          );
        }
      }
      // The holder said it failed (or lost the race to the tombstone): nothing ran, so name and folder go.
      rollback();
      throw new SessionError("HOLDER_BOOT_FAILED", why);
    }
    return { id, ...(spec.name !== undefined ? { name: foldSessionName(spec.name) } : {}) };
  }

  /** The holder reports its boot in `boot.txt` of the session folder; the wait is bounded (10 s by default). */
  private async awaitBoot(dir: string): Promise<{ line: string; timedOut: boolean }> {
    const end = this.now() + (this.opts.bootTimeoutMs ?? 10_000);
    for (;;) {
      try {
        const text = readFileSync(join(dir, BOOT_FILE), "utf8").trim();
        if (text !== "") return { line: text, timedOut: false };
      } catch {
        // not written yet
      }
      if (this.now() >= end) {
        return { line: "HOLDER_BOOT_FAILED:no answer within the boot bound", timedOut: true };
      }
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
    if (typeof recorded !== "string" && recorded.lastOutputAt !== undefined) {
      status.lastOutputAt = recorded.lastOutputAt;
    }
    return status;
  }

  /** Makes `lost` final: the first reader to find no `status.json` after the grace creates the tombstone exclusively. */
  private settle(id: string): SessionStatus {
    const status = this.read(id);
    if (status.state === "lost" && status.reason === "no_status") {
      const dir = sessionDirOf(this.place, id);
      if (this.isForeign(dir)) return status; // another machine's session is never judged lost here
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

  /** A session of another machine (a shared folder): listed, never judged, never signalled. */
  private isForeign(dir: string): boolean {
    const record = readSession(dir);
    const here = machineId();
    return (
      typeof record !== "string" &&
      record.machine !== undefined &&
      here !== undefined &&
      record.machine !== here
    );
  }

  async status(id: string): Promise<SessionStatus> {
    if (this.isForeign(sessionDirOf(this.place, id))) {
      throw new SessionError("IDENTITY_UNKNOWN", `session ${id} belongs to another machine`);
    }
    return this.settle(id);
  }

  async wait(
    id: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SessionStatus & { timedOut?: boolean }> {
    const deadline =
      opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : this.now() + opts.timeoutMs;
    if (this.isForeign(sessionDirOf(this.place, id))) {
      throw new SessionError("IDENTITY_UNKNOWN", `session ${id} belongs to another machine`);
    }
    for (;;) {
      const status = this.settle(id);
      if (status.state !== "starting" && status.state !== "running") return status;
      if (opts.signal?.aborted) return { ...status, timedOut: true };
      if (this.now() >= deadline) return { ...status, timedOut: true };
      await sleep(this.poll);
    }
  }

  async tail(id: string, bytes = 64 * 1024, stream: TailStream = "both"): Promise<TailResult> {
    const dir = sessionDirOf(this.place, id);
    if (!existsSync(dir)) throw new SessionError("NOT_FOUND", `no session ${id}`);
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new SessionError("SPEC_INVALID", "bytes must be a positive whole number");
    }
    const text = readTail(dir, stream);
    const cut = Buffer.from(text).length > bytes;
    return {
      text: cut ? Buffer.from(text).subarray(-bytes).toString("utf8") : text,
      complete: !cut,
    };
  }

  async stop(id: string): Promise<SessionStatus> {
    const dir = sessionDirOf(this.place, id);
    let before = this.settle(id);
    if (this.isForeign(dir)) {
      throw new SessionError("IDENTITY_UNKNOWN", `session ${id} belongs to another machine`);
    }
    // A session that is still starting has no child to signal yet: give the holder a moment to record it, then
    // decide on the status read after the wait, not on the one read before it.
    for (let i = 0; before.state === "starting" && i < 60; i++) {
      await sleep(50);
      before = this.settle(id);
    }
    if (before.state === "starting") {
      throw new SessionError("NOT_RUNNING", `session ${id} is still starting; try again`);
    }
    const recorded = readStatus(dir);
    if (typeof recorded === "string") return before;
    const child = recorded.child;
    if (before.state !== "running" && !(before.childAlive && child)) return before;
    if (!child) return before;
    if (!liveProcess(child.pid)) return this.settle(id);

    // The recorded identity must be the live process. Without a recorded identity, or when it cannot be read or
    // compared now, nothing is signalled: a pid may have been taken by a stranger.
    if (!child.identity) {
      throw new SessionError(
        "IDENTITY_UNKNOWN",
        `no identity was recorded for ${child.pid}; not signalling`,
      );
    }
    const now = processIdentity(child.pid);
    if (!now)
      throw new SessionError("IDENTITY_UNKNOWN", `cannot read the identity of ${child.pid}`);
    const same = sameIdentity(child.identity, now);
    if (same === undefined) {
      throw new SessionError("IDENTITY_UNKNOWN", `cannot compare the identity of ${child.pid}`);
    }
    if (!same) return this.settle(id); // another process has the pid now: the session's child is gone
    if (!existsSync(join(dir, STOP_FILE))) {
      replaceRecord(
        join(dir, STOP_FILE),
        encodeRecord("stop", {
          v: SESSION_FORMAT_VERSION,
          by: "stop",
          at: this.now(),
          identity: now,
        }),
      );
    }
    const descendants = descendantsOf(child.pid).map((pid) => ({
      pid,
      identity: processIdentity(pid),
    }));
    const signalDescendants = (signal: NodeJS.Signals) => {
      for (const d of descendants) {
        const alive = processIdentity(d.pid);
        if (alive && d.identity && sameIdentity(d.identity, alive)) {
          try {
            process.kill(d.pid, signal);
          } catch {
            // gone
          }
        }
      }
    };
    killTree(child.pid);
    signalDescendants("SIGTERM");
    // stop waits past the kill grace so the escalation in killTree runs in this process
    const limit = this.now() + KILL_GRACE_MS + 3_000;
    const descendantsAlive = () =>
      descendants.some((d) => {
        const alive = processIdentity(d.pid);
        return alive && d.identity && sameIdentity(d.identity, alive);
      });
    while (this.now() < limit) {
      const s = this.settle(id);
      const over = s.state !== "running" && s.state !== "starting" && !liveProcess(child.pid);
      if (over && !descendantsAlive()) break;
      await sleep(this.poll);
    }
    signalDescendants("SIGKILL");
    try {
      process.kill(-child.pid, "SIGKILL"); // members of the group that ignored SIGTERM (the identity was checked above)
    } catch {
      // the group is gone
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
    const bytes = Buffer.from(data);
    let written = 0;
    try {
      const fd = openSync(join(dir, INPUT_FIFO), constants.O_WRONLY | constants.O_NONBLOCK);
      try {
        // A full pipe answers EAGAIN: keep writing what is left for a while, so a line is never left cut in two.
        const until = this.now() + 5_000;
        while (written < bytes.length) {
          try {
            written += writeSync(fd, bytes, written);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || this.now() >= until)
              throw error;
            await sleep(10);
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new SessionError(
        code === "EAGAIN" ? "UNSUPPORTED" : "NOT_RUNNING",
        code === "EAGAIN"
          ? `session ${id} did not read its input; ${written} of ${bytes.length} bytes were taken`
          : `could not write to session ${id}: ${(error as Error).message}`,
      );
    }
    return { bytes: written };
  }

  async remove(id: string): Promise<void> {
    const dir = sessionDirOf(this.place, id);
    if (!existsSync(dir)) return;
    const record = readSession(dir);
    if (record === "missing") {
      removeDir(dir); // an orphan without session.json: nothing runs there
      return;
    }
    if (record === "newer") {
      throw new SessionError(
        "NEWER_FORMAT",
        `session ${id} was written by a newer kodel; upgrade kodel`,
      );
    }
    if (record === "unreadable") {
      // The folder cannot be judged; it goes only when nothing of it is alive and nothing in it is a newer kodel's.
      const written = readStatus(dir);
      if (written === "newer") {
        throw new SessionError(
          "NEWER_FORMAT",
          `session ${id} was written by a newer kodel; upgrade kodel`,
        );
      }
      if (typeof written !== "string") {
        const holderAlive =
          written.holder && sameProcess(written.holder.pid, written.holder.identity);
        const childAlive = written.child && sameProcess(written.child.pid, written.child.identity);
        if (holderAlive || childAlive) {
          throw new SessionError("STILL_RUNNING", `session ${id} still runs; stop it first`);
        }
      } else if (written === "unreadable") {
        throw new SessionError(
          "CANNOT_READ",
          `session ${id} cannot be read; remove its folder by hand`,
        );
      }
      removeDir(dir);
      return;
    }
    if (this.isForeign(dir)) {
      throw new SessionError(
        "IDENTITY_UNKNOWN",
        `session ${id} belongs to another machine; remove it there`,
      );
    }
    const status = this.settle(id);
    if (status.state === "starting" || status.state === "running" || status.childAlive) {
      throw new SessionError("STILL_RUNNING", `session ${id} still runs; stop it first`);
    }
    // The name marker stays unless the session says it came from a person at the command line (`origin: "cli"`):
    // a host's retry rule, and any starter that did not say, need "used" to outlive the folder. The marker goes
    // first, so a start with the same name never sees a marker without a folder for a name about to be freed.
    if (record.name !== undefined && record.spec.origin === "cli") {
      const markerFile = this.markerPath(record.name);
      const held = readMarker(markerFile);
      if (typeof held !== "string" && held.id === id) removeDir(markerFile);
    }
    removeDir(dir);
  }

  async list(filter?: { name?: string }): Promise<SessionListEntry[]> {
    if (!existsSync(this.place.dir)) return [];
    const entries: SessionListEntry[] = [];
    const wanted = filter?.name === undefined ? undefined : foldSessionName(filter.name);
    for (const entry of readdirSync(this.place.dir)) {
      if (!isLocalSessionId(entry)) continue;
      const record = readSession(join(this.place.dir, entry));
      if (typeof record === "string") {
        if (wanted === undefined && record !== "missing") {
          entries.push({
            id: entry,
            status: { state: "lost" },
            problem: record === "newer" ? "NEWER_FORMAT" : "CANNOT_READ",
          });
        }
        continue;
      }
      if (wanted !== undefined && record.name !== wanted) continue;
      if (this.isForeign(join(this.place.dir, entry))) {
        // listed, never judged: the holder pid of another machine means nothing here
        entries.push({
          id: entry,
          ...(record.name !== undefined ? { name: record.name } : {}),
          status: { state: "lost" },
          problem: "FOREIGN",
        });
        continue;
      }
      try {
        entries.push({
          id: entry,
          ...(record.name !== undefined ? { name: record.name } : {}),
          command: commandOf(record),
          status: this.read(entry),
        });
      } catch (error) {
        entries.push({
          id: entry,
          ...(record.name !== undefined ? { name: record.name } : {}),
          status: { state: "lost" },
          problem:
            error instanceof SessionError && error.code === "NEWER_FORMAT"
              ? "NEWER_FORMAT"
              : "CANNOT_READ",
        });
      }
    }
    return entries;
  }
}
