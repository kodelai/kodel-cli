import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  constants,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { encodeRecord, redactText, SESSION_FORMAT_VERSION } from "@kodel-ai/pipeline-core";
import { killTree } from "./command";
import { processIdentity } from "./process-table";
import {
  createExclusive,
  readStatus,
  replaceRecord,
  STATUS_FILE,
  STOP_FILE,
  type StatusRecord,
  TAIL_FILE,
} from "./session-records";

/** What the starter sends on the holder's stdin: secrets travel here and never touch a file. */
export interface HolderInput {
  v: number;
  dir: string;
  command?: string;
  argv?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  /** Open the child's stdin and feed it from the `in.fifo` of the session folder. */
  input?: boolean;
  graceMs: number;
  started: number;
  build?: string;
  tailBytes?: number;
}

export const INPUT_FIFO = "in.fifo";
export const HOLDER_MARKER = "--kodel-session-holder";
const END = Buffer.from("KEND");
const DEFAULT_TAIL_BYTES = 256 * 1024;
/** How long output that is still in the pipes is read after the child has exited. */
const PIPE_DRAIN_MS = 300;

export const frameInput = (input: HolderInput): Buffer => {
  const body = Buffer.from(JSON.stringify(input));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body, END]);
};

/** Reads one framed input with an explicit end; EOF before the end means the starter died mid-write. */
export const readInput = (stream: NodeJS.ReadableStream): Promise<HolderInput | undefined> =>
  new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = (value: HolderInput | undefined) => {
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      resolve(value);
    };
    stream.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk as Buffer]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len + END.length) return;
      if (!buf.subarray(4 + len, 4 + len + END.length).equals(END)) return done(undefined);
      try {
        done(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as HolderInput);
      } catch {
        done(undefined);
      }
    });
    stream.on("end", () => done(undefined));
  });

export interface HolderDeps {
  input: HolderInput;
  /** One line to the starter: `ready` or `HOLDER_BOOT_FAILED:<why>`. */
  boot: (line: string) => void;
  now?: () => number;
}

/** Runs one session to its end. Returns the holder's exit code. */
export async function runHolder(deps: HolderDeps): Promise<number> {
  const { input, boot } = deps;
  const now = deps.now ?? Date.now;
  const statusPath = join(input.dir, STATUS_FILE);
  const identity = processIdentity(process.pid);
  const holder = identity ? { pid: process.pid, identity } : { pid: process.pid };

  // Handshake: a start that is late creates nothing; else the first status.json is created exclusively, so a
  // reader's `lost` tombstone (which makes the session final) wins or loses cleanly.
  if (now() - input.started >= input.graceMs) {
    boot("HOLDER_BOOT_FAILED:start_late");
    return 1;
  }
  const first: StatusRecord = {
    v: SESSION_FORMAT_VERSION,
    state: "starting",
    by: "holder",
    holder,
    since: now(),
    ...(input.build ? { build: input.build } : {}),
  };
  if (!createExclusive(statusPath, encodeRecord("status", first))) {
    boot("HOLDER_BOOT_FAILED:tombstone");
    return 1;
  }

  let child: ChildProcess;
  try {
    const options = {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: [input.input ? "pipe" : "ignore", "pipe", "pipe"] as [
        "pipe" | "ignore",
        "pipe",
        "pipe",
      ],
    };
    child =
      input.command !== undefined
        ? spawn(input.command, { ...options, shell: true })
        : spawn((input.argv ?? [])[0] as string, (input.argv ?? []).slice(1), options);
  } catch (error) {
    replaceRecord(
      statusPath,
      encodeRecord("status", { ...first, state: "killed", reason: "holder_error", since: now() }),
    );
    boot(`HOLDER_BOOT_FAILED:${redactText((error as Error).message)}`);
    return 1;
  }

  // Listen for the exit at once: a child that ends before the holder has recorded it as running would be missed.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // `exit`, not `close`: a descendant in another session may keep the pipes open long after the child is gone.
    child.once("exit", (c, sig) => {
      setTimeout(() => resolve({ code: c, signal: sig }), PIPE_DRAIN_MS);
    });
  });

  const tailBytes = input.tailBytes ?? DEFAULT_TAIL_BYTES;
  let tail = Buffer.alloc(0);
  let lastOutputAt: number | undefined;
  let dirty = false;
  const collect = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes);
    lastOutputAt = now();
    dirty = true;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const flush = () => {
    if (!dirty && existsSync(join(input.dir, TAIL_FILE))) return;
    dirty = false;
    try {
      writeFileSync(join(input.dir, TAIL_FILE), redactText(tail.toString("utf8")), { mode: 0o600 });
    } catch {
      // the directory may be gone; the watcher below handles that
    }
  };

  if (input.input && child.stdin) {
    // A FIFO opened for reading and writing by the holder never reports end of file; `send` writes into it.
    const fifo = join(input.dir, INPUT_FIFO);
    if (spawnSync("mkfifo", [fifo]).status === 0) {
      const fd = openSync(fifo, constants.O_RDWR);
      createReadStream("", { fd, autoClose: false }).pipe(child.stdin);
      child.stdin.on("error", () => {});
    }
  }

  const spawnFailure = await new Promise<Error | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (error) => resolve(error));
  });
  if (spawnFailure) {
    replaceRecord(
      statusPath,
      encodeRecord("status", { ...first, state: "killed", reason: "holder_error", since: now() }),
    );
    boot(`HOLDER_BOOT_FAILED:${redactText(spawnFailure.message)}`);
    return 1;
  }

  const childId = processIdentity(child.pid as number);
  const running: StatusRecord = {
    ...first,
    state: "running",
    child: childId ? { pid: child.pid as number, identity: childId } : { pid: child.pid as number },
    since: now(),
  };
  const current = readStatus(input.dir);
  if (current === "missing" || current === "unreadable" || current.by !== "holder") {
    killTree(child.pid);
    boot("HOLDER_BOOT_FAILED:tombstone");
    return 1;
  }
  replaceRecord(statusPath, encodeRecord("status", running));
  boot("ready");

  let timedOut = false;
  const timer =
    input.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, input.timeoutMs)
      : undefined;
  const watcher = setInterval(() => {
    flush();
    if (!existsSync(input.dir)) killTree(child.pid); // the directory was removed under a live child
  }, 1_000);

  const code = await exited;
  if (timer) clearTimeout(timer);
  clearInterval(watcher);
  flush();

  const stopped = existsSync(join(input.dir, STOP_FILE));
  const final: StatusRecord = {
    ...running,
    since: now(),
    ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
    ...(timedOut
      ? { state: "killed", reason: "timeout" }
      : stopped
        ? { state: "killed", reason: "stopped" }
        : code.signal
          ? { state: "killed", signal: code.signal }
          : { state: "exited", exitCode: code.code ?? 0 }),
  };
  if (existsSync(input.dir)) {
    const check = readStatus(input.dir);
    if (check !== "missing" && check !== "unreadable" && check.by === "holder")
      replaceRecord(statusPath, encodeRecord("status", final));
  }
  return 0;
}

export const BOOT_FILE = "boot.txt";

/** The boot report is a file (written whole, then renamed), not a pipe: an extra stdio pipe is not reliable under Bun and has no equivalent on Windows. */
export const writeBoot = (dir: string, line: string): void => {
  try {
    const tmp = join(dir, `${BOOT_FILE}.tmp`);
    writeFileSync(tmp, `${line}\n`, { mode: 0o600 });
    renameSync(tmp, join(dir, BOOT_FILE));
  } catch {
    // the starter is gone or the folder was removed
  }
};

/** Process entry of the holder: the framed input is stdin; the boot report goes to the session folder. */
export async function holderMain(): Promise<number> {
  process.chdir("/");
  const input = await readInput(process.stdin);
  if (!input) return 1; // the starter died mid-write: nobody waits for an answer
  return runHolder({ input, boot: (line) => writeBoot(input.dir, line) });
}

/** The intermediate process: starts the holder with the same pipe ends and exits at once. */
export function intermediateMain(launch: { exec: string; args: string[] }): void {
  const child = spawn(launch.exec, [...launch.args, HOLDER_MARKER], {
    detached: true,
    stdio: [0, "ignore", "ignore"],
  });
  child.unref();
}

export const readTail = (dir: string): string => {
  try {
    return readFileSync(join(dir, TAIL_FILE), "utf8");
  } catch {
    return "";
  }
};
