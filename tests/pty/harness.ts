/**
 * What the real-terminal tests share. The test runner is Bun, which cannot host a PTY: the session's holder and
 * the CLI under test are the built artifact on Node, and the terminals the CLI runs in are hosted by
 * `host.mjs` (Node). A test that cannot run here is skipped with a printed, counted reason, never passed;
 * with `KODEL_REQUIRE_PTY=1` it fails instead.
 */
import { afterAll, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  type PipesAdapterOptions,
  PipesSessionAdapter,
  sessionDirOf,
} from "../../packages/local/src";
import { TestClient } from "../../packages/local/test/helpers/attach-fakes";
import { type AttachStream, type RedactRule, toBinary } from "../../packages/pipeline-core/src";

export const repo = join(import.meta.dir, "../..");
export const ARTIFACT = join(repo, "packages/cli/dist/kodel.js");
export const HOST = join(import.meta.dir, "host.mjs");
const SOURCE_DIRS = ["packages/cli/src", "packages/local/src", "packages/pipeline-core/src"];

export type Availability = { ok: true } | { ok: false; reason: string };

/** A build older than the sources would test yesterday's code and call it today's. */
export const artifactProblem = (
  artifactMtime: number | undefined,
  newestSourceMtime: number,
): string | undefined => {
  if (artifactMtime === undefined) return "no built artifact: run `bun run build` first";
  if (artifactMtime < newestSourceMtime) {
    return "packages/cli/dist/kodel.js is older than the sources: run `bun run build` again";
  }
  return undefined;
};

const newestMtime = (dir: string): number => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
};

const canBind = (): string | undefined => {
  const dir = mkdtempSync("/tmp/kd-bind-");
  try {
    // A bind that is refused throws at once; one that works is closed again.
    const probe = spawnSync(
      "node",
      [
        "-e",
        "const s=require('node:net').createServer();s.on('error',e=>{console.error(e.message);process.exit(1)});s.listen(process.argv[1],()=>s.close())",
        join(dir, "p.sock"),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    return probe.status === 0
      ? undefined
      : `a unix socket cannot be bound here (${probe.stderr.trim()})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Whether a real terminal session can be run and attached to from this process. */
export function ptyAvailability(): Availability {
  const no = (reason: string): Availability => ({ ok: false, reason });
  if (process.platform === "win32") return no("terminal sessions are not supported on Windows");
  const built = existsSync(ARTIFACT) ? statSync(ARTIFACT).mtimeMs : undefined;
  const stale = artifactProblem(
    built,
    Math.max(...SOURCE_DIRS.map((dir) => newestMtime(join(repo, dir)))),
  );
  if (stale !== undefined) return no(stale);
  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (node.status !== 0) return no("node is not on the PATH");
  const self = spawnSync("node", [HOST, ARTIFACT, "--selftest"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  if (self.status !== 0) {
    return no(
      `a terminal cannot be opened here (${(self.stderr || "no answer").trim().split("\n")[0]})`,
    );
  }
  const bind = canBind();
  return bind === undefined ? { ok: true } : no(bind);
}

type TestBody = () => void;
export interface PtyRegister {
  run(name: string, body: TestBody, timeoutMs: number): void;
  skip(name: string, body: TestBody): void;
}

/**
 * The registration of real tests for one file. Unavailable: every test is registered as skipped and `done()`
 * prints one line with the count and the reason; when the terminal is required, every test fails with it.
 */
export function ptyTests(options: {
  available: Availability;
  required: boolean;
  register: PtyRegister;
  log?: (line: string) => void;
}) {
  const { available, required, register } = options;
  let skipped = 0;
  return {
    test(name: string, body: TestBody, timeoutMs = 60_000): void {
      if (available.ok) register.run(name, body, timeoutMs);
      else if (required) {
        register.run(
          name,
          () => {
            throw new Error(`KODEL_REQUIRE_PTY=1 and this test cannot run: ${available.reason}`);
          },
          timeoutMs,
        );
      } else {
        skipped++;
        register.skip(name, body);
      }
    },
    /** Call once, when every test of the file is registered: prints the line about the skipped ones. */
    done(): number {
      if (skipped > 0 && !available.ok) {
        (options.log ?? console.log)(`PTY tests skipped: ${skipped}, ${available.reason}`);
      }
      return skipped;
    },
  };
}

let known: Availability | undefined;
/** The suite of a test file, against this machine. The line about skipped tests is printed when the file is over. */
export const realPtyTests = () => {
  known ??= ptyAvailability();
  const suite = ptyTests({
    available: known,
    required: process.env.KODEL_REQUIRE_PTY === "1",
    register: {
      run: (name, body, timeoutMs) => test(name, body, timeoutMs),
      skip: (name, body) => test.skip(name, body),
    },
  });
  afterAll(() => void suite.done());
  return suite;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Waits until `check` answers something, or fails with what was seen. */
export async function until<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 15_000,
  seen: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\n--- seen ---\n${JSON.stringify(seen())}`);
    }
    await sleep(25);
  }
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A folder under `/tmp`: the runner's own `TMPDIR` is too long for a socket path on macOS. */
export const shortDir = (prefix = "kd-"): string => realpathSync(mkdtempSync(join("/tmp", prefix)));

export interface World {
  root: string;
  state: string;
  /** The environment a person's shell would give `kodel` here. */
  env: Record<string, string>;
  adapter(options?: Partial<PipesAdapterOptions>): PipesSessionAdapter;
  /** The folder of a session, and its records as they are on disk. */
  dirOf(id: string): string;
  status(id: string): Record<string, unknown> & { sock?: string };
  dispose(): Promise<void>;
}

/** A project and a state base of its own; the holder is the built artifact on Node. */
export function world(options: { longBase?: boolean; rules?: RedactRule[] } = {}): World {
  const top = shortDir();
  const root = join(top, "project");
  // A base this long leaves no room for the primary socket path: the holder falls back to a temporary folder.
  const state = options.longBase ? join(top, "s".repeat(90)) : join(top, "st");
  // A holder under a base this long binds in `kodel-<uid>` under a temporary folder and leaves that folder
  // there. The ones that were not there before this world are removed with it, and only while empty: one that
  // holds the socket of somebody's session stays.
  const socketDirs = options.longBase
    ? [process.env.TMPDIR, "/tmp"]
        .filter((dir): dir is string => dir !== undefined && dir !== "")
        .map((dir) => join(dir, `kodel-${process.getuid?.() ?? 0}`))
        .filter((dir) => !existsSync(dir))
    : [];
  mkdirSync(join(root, ".kodel"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, ".kodel", "config.yaml"), "");
  const adapters: PipesSessionAdapter[] = [];
  const make = (extra: Partial<PipesAdapterOptions> = {}): PipesSessionAdapter => {
    const adapter = new PipesSessionAdapter({
      base: state,
      root,
      holder: { exec: "node", args: [ARTIFACT, "session-holder", "holder"] },
      intermediate: { exec: "node", args: [ARTIFACT, "session-holder"] },
      // The adapter runs here, under Bun; the holder it starts is Node, which the availability check proved.
      ptyProbe: () => ({ ok: true }),
      pollMs: 25,
      ...(options.rules ? { rules: options.rules } : {}),
      ...extra,
    });
    adapters.push(adapter);
    return adapter;
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? top,
    TERM: "xterm-256color",
    KODEL_STATE_DIR: state,
    PS1: "$ ",
  };
  const first = make();
  return {
    root,
    state,
    env,
    adapter: (extra) => (extra ? make(extra) : first),
    dirOf: (id) => sessionDirOf(first.place, id),
    status: (id) =>
      JSON.parse(readFileSync(join(sessionDirOf(first.place, id), "status.json"), "utf8")),
    async dispose() {
      for (const entry of await first.list().catch(() => [])) {
        if (entry.status.state === "running" || entry.status.state === "starting") {
          await first.stop(entry.id).catch(() => {});
        }
        await first.remove(entry.id).catch(() => {});
      }
      rmSync(top, { recursive: true, force: true });
      for (const made of socketDirs) {
        try {
          rmdirSync(made);
        } catch {
          // never made, or not empty
        }
      }
    },
  };
}

/** A client that speaks the frames itself, in this process: what the terminal sent is in `output`. */
export class Wire extends TestClient {
  constructor(readonly stream: AttachStream) {
    super(stream);
  }
  sees(text: string | RegExp, timeoutMs?: number): Promise<true> {
    return until(
      () => (typeof text === "string" ? this.output.includes(text) : text.test(this.output)),
      `the terminal to show ${String(text)}`,
      timeoutMs,
      () => this.output,
    );
  }
  close(): void {
    this.stream.close();
  }
}

/** A terminal the host opened, with the program the test put in it. */
export class Term {
  /** Everything the program wrote, as a binary string. */
  output = "";
  exit: { exitCode: number; signal?: number } | undefined;
  pid = 0;
  private marks = 0;
  constructor(
    readonly id: string,
    private readonly send: (command: Record<string, unknown>) => void,
  ) {}
  type(text: string): void {
    this.send({ op: "write", id: this.id, data: Buffer.from(text, "latin1").toString("base64") });
  }
  resize(cols: number, rows: number): void {
    this.send({ op: "resize", id: this.id, cols, rows });
  }
  pause(): void {
    this.send({ op: "pause", id: this.id });
  }
  resume(): void {
    this.send({ op: "resume", id: this.id });
  }
  kill(signal = "SIGHUP"): void {
    this.send({ op: "kill", id: this.id, signal });
  }
  sees(text: string | RegExp, timeoutMs?: number, from = 0): Promise<true> {
    return until(
      () => {
        const shown = this.output.slice(from);
        return typeof text === "string" ? shown.includes(text) : text.test(shown);
      },
      `the terminal to show ${String(text)}`,
      timeoutMs,
      () => this.output.slice(from),
    );
  }
  ended(timeoutMs?: number): Promise<{ exitCode: number; signal?: number }> {
    return until(
      () => this.exit,
      "the program to end",
      timeoutMs,
      () => this.output,
    );
  }
  /**
   * In a shell: runs a command line and waits for it to end. The marker is typed in two pieces, so the echo
   * of the typing is not taken for it. Answers the exit code and what was shown from the typing on.
   */
  async sh(command: string, timeoutMs?: number): Promise<{ code: number; shown: string }> {
    const from = this.begin(command);
    return this.finished(from, timeoutMs);
  }
  /** Types a command line with its end marker and comes back at once: the test drives what runs. */
  begin(command: string): number {
    const from = this.output.length;
    this.marks++;
    this.type(`${command}; echo "<e""nd${this.marks}:$?>"\r`);
    return from;
  }
  async finished(from: number, timeoutMs?: number): Promise<{ code: number; shown: string }> {
    const pattern = new RegExp(`<end${this.marks}:(\\d+)>`);
    await this.sees(pattern, timeoutMs, from);
    const shown = this.output.slice(from);
    return { code: Number(pattern.exec(shown)?.[1]), shown };
  }
}

/** The Node process that hosts the terminals. */
export class Host {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly terms = new Map<string, Term>();
  private readonly spawned = new Map<string, (pid: number) => void>();
  private pongs = new Map<number, () => void>();
  errors: string[] = [];
  private count = 0;

  constructor() {
    this.child = spawn("node", [HOST, ARTIFACT], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        this.event(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>);
        buffer = buffer.slice(at + 1);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.errors.push(chunk.toString("utf8")));
  }
  private event(event: Record<string, unknown>): void {
    const term = this.terms.get(event.id as string);
    if (event.ev === "pong") this.pongs.get(event.n as number)?.();
    else if (event.ev === "spawned") this.spawned.get(event.id as string)?.(event.pid as number);
    else if (event.ev === "data" && term) {
      term.output += toBinary(new Uint8Array(Buffer.from(event.data as string, "base64")));
    } else if (event.ev === "exit" && term) {
      term.exit = {
        exitCode: event.exitCode as number,
        ...(event.signal ? { signal: event.signal as number } : {}),
      };
    } else if (event.ev === "error") this.errors.push(String(event.message));
  }
  private send = (command: Record<string, unknown>): void => {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  };
  async ping(n: number): Promise<void> {
    const answered = new Promise<void>((resolve) => this.pongs.set(n, resolve));
    this.send({ op: "ping", n });
    await answered;
  }
  async open(
    file: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; cols?: number; rows?: number },
  ): Promise<Term> {
    const id = `t${++this.count}`;
    const term = new Term(id, this.send);
    this.terms.set(id, term);
    const pid = new Promise<number>((resolve) => this.spawned.set(id, resolve));
    this.send({ op: "spawn", id, file, args, cols: 80, rows: 24, ...options });
    term.pid = await Promise.race([
      pid,
      sleep(15_000).then(() => {
        throw new Error(`the host did not open ${file} (${this.errors.join("; ")})`);
      }),
    ]);
    return term;
  }
  /** A shell a person would type `kodel` into, with the prompt and the echo of a real one. */
  async shell(w: World, env: Record<string, string> = {}): Promise<Term> {
    const term = await this.open("/bin/sh", [], { cwd: w.root, env: { ...w.env, ...env } });
    await term.sh("true");
    return term;
  }
  close(): void {
    this.child.stdin.end();
  }
}

/** `kodel` as a person types it at a shell of the tests. */
export const KODEL = `node ${ARTIFACT}`;

/** A server on a socket path, for a test that needs somebody (or nobody) to listen there. */
export const listenAt = (path: string): Promise<{ close(): Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.on("error", () => {}));
    server.once("error", reject);
    server.listen(path, () =>
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }),
    );
  });
