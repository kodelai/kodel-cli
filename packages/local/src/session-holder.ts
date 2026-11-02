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
import {
  encodeRecord,
  MAX_SESSION_TIMEOUT_MS,
  type RedactRule,
  redactCutPrivateKey,
  redactText,
  SESSION_FORMAT_VERSION,
} from "@kodel-ai/pipeline-core";
import { z } from "zod";
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

/** A redaction rule that can cross to the holder: a pattern, no function. */
export interface WireRule {
  name: string;
  source: string;
  flags: string;
}

const holderInputSchema = z.object({
  v: z.number().int(),
  dir: z.string().min(1),
  command: z.string().optional(),
  argv: z.array(z.string()).optional(),
  cwd: z.string().min(1),
  env: z.record(z.string()),
  timeoutMs: z.number().positive().max(MAX_SESSION_TIMEOUT_MS).optional(),
  input: z.boolean().optional(),
  graceMs: z.number().nonnegative(),
  started: z.number(),
  build: z.string().optional(),
  tailBytes: z.number().positive().optional(),
  rules: z.array(z.object({ name: z.string(), source: z.string(), flags: z.string() })).optional(),
  /** A project rule with a function cannot cross: the session ends `killed/rules_unknown` without a child. */
  rulesUnknown: z.boolean().optional(),
});

/** What the starter sends on the holder's stdin: secrets travel here and never touch a file. */
export type HolderInput = z.infer<typeof holderInputSchema>;

export const INPUT_FIFO = "in.fifo";
export const HOLDER_MARKER = "--kodel-session-holder";
const END = Buffer.from("KEND");
const DEFAULT_TAIL_BYTES = 256 * 1024;
/** Read this much more than is kept: redaction runs before the final cut (the same rule as `runCommand`). */
const REDACT_MARGIN_BYTES = 1024;
/** How long output that is still in the pipes is read after the child has exited. */
const PIPE_DRAIN_MS = 300;
/** The most a clock of the starter may be ahead of the holder's. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** The running record is rewritten while output arrives, but not more often than this. */
const STATUS_MIN_INTERVAL_MS = 5_000;

export const frameInput = (input: HolderInput): Buffer => {
  const body = Buffer.from(JSON.stringify(input));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body, END]);
};

/** Reads one framed input with an explicit end; EOF before the end means the starter died mid-write. */
export const readInput = (stream: NodeJS.ReadableStream): Promise<unknown | undefined> =>
  new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = (value: unknown | undefined) => {
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
        done(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as unknown);
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

const toRules = (wire: WireRule[] | undefined): RedactRule[] =>
  (wire ?? []).map((r) => ({ name: r.name, pattern: new RegExp(r.source, r.flags) }));

/** The last `bytes` bytes of a text, cut at a character boundary (a cut inside a UTF-8 sequence leaves U+FFFD at the start). */
const lastBytes = (text: string, bytes: number): string => {
  const buf = Buffer.from(text);
  if (buf.length <= bytes) return text;
  return buf
    .subarray(buf.length - bytes)
    .toString("utf8")
    .replace(/^�+/, "");
};

/** Runs one session to its end. Returns the holder's exit code. */
export async function runHolder(deps: HolderDeps): Promise<number> {
  const { input, boot } = deps;
  const now = deps.now ?? Date.now;
  const statusPath = join(input.dir, STATUS_FILE);
  const identity = processIdentity(process.pid);
  const holder = identity ? { pid: process.pid, identity } : { pid: process.pid };
  const rules = toRules(input.rules);
  const safe = (text: string) => redactText(text, rules);

  if (input.v !== SESSION_FORMAT_VERSION) {
    boot(
      `HOLDER_BOOT_FAILED:the input has version ${input.v}, this holder reads ${SESSION_FORMAT_VERSION}`,
    );
    return 1;
  }
  // Handshake: a start that is late creates nothing; else the first status.json is created exclusively, so a
  // reader's `lost` tombstone (which makes the session final) wins or loses cleanly.
  if (now() - input.started >= input.graceMs) {
    boot("HOLDER_BOOT_FAILED:start_late");
    return 1;
  }
  if (input.started - now() > MAX_CLOCK_SKEW_MS) {
    boot("HOLDER_BOOT_FAILED:the start time is in the future");
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
  const failBoot = (reason: "holder_error" | "rules_unknown", text: string) => {
    try {
      replaceRecord(
        statusPath,
        encodeRecord("status", { ...first, state: "killed", reason, since: now() }),
      );
    } catch {
      // the folder was removed
    }
    boot(`HOLDER_BOOT_FAILED:${safe(text)}`);
    return 1;
  };
  if (input.rulesUnknown) {
    return failBoot("rules_unknown", "a project redaction rule cannot be given to the holder");
  }

  // The input channel exists before the child does: a failure here means nothing ran, so the starter may roll back.
  let fifoFd: number | undefined;
  if (input.input) {
    const fifo = join(input.dir, INPUT_FIFO);
    try {
      if (spawnSync("mkfifo", [fifo]).status !== 0) throw new Error("mkfifo failed");
      // Opened for reading and writing, the FIFO never reports end of file; `send` writes into it.
      fifoFd = openSync(fifo, constants.O_RDWR);
    } catch {
      return failBoot("holder_error", "could not make the input channel");
    }
  }

  let child: ChildProcess;
  try {
    // The mark is forced here too: a starter that did not use `sessionEnv` still gets a marked child.
    const env = { ...input.env, KODEL_ENGINE: "1" };
    const options = {
      cwd: input.cwd,
      env,
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
    return failBoot("holder_error", (error as Error).message);
  }

  // Listen for the exit at once: a child that ends before the holder has recorded it as running would be missed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    // `exit`, not `close`: a descendant in another session may keep the pipes open long after the child is gone.
    child.once("exit", (c, sig) => {
      if (timer) clearTimeout(timer); // a timeout must not fire during the drain of a normal end
      setTimeout(() => resolve({ code: c, signal: sig }), PIPE_DRAIN_MS);
    });
  });
  let timedOut = false;

  const tailBytes = input.tailBytes ?? DEFAULT_TAIL_BYTES;
  const keepBytes = tailBytes + REDACT_MARGIN_BYTES;
  let tail = Buffer.alloc(0);
  let cut = false;
  let lastOutputAt: number | undefined;
  let dirty = false;
  const collect = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > keepBytes) {
      tail = tail.subarray(tail.length - keepBytes);
      cut = true;
    }
    lastOutputAt = now();
    dirty = true;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  // Redaction runs on the text with its margin, then the end is cut; a cut start loses a private key's header.
  const flush = () => {
    if (!dirty && existsSync(join(input.dir, TAIL_FILE))) return;
    dirty = false;
    const text = tail.toString("utf8").replace(/^�+/, "");
    try {
      const target = join(input.dir, TAIL_FILE);
      writeFileSync(
        `${target}.tmp`,
        lastBytes(safe(cut ? redactCutPrivateKey(text) : text), tailBytes),
        {
          mode: 0o600,
        },
      );
      renameSync(`${target}.tmp`, target);
    } catch {
      // the directory may be gone; the watcher below handles that
    }
  };

  if (fifoFd !== undefined && child.stdin) {
    createReadStream("", { fd: fifoFd, autoClose: false }).pipe(child.stdin);
    child.stdin.on("error", () => {});
  }

  const spawnFailure = await new Promise<Error | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (error) => resolve(error));
  });
  if (spawnFailure) return failBoot("holder_error", spawnFailure.message);

  const childId = processIdentity(child.pid as number);
  const running: StatusRecord = {
    ...first,
    state: "running",
    child: childId ? { pid: child.pid as number, identity: childId } : { pid: child.pid as number },
    since: now(),
  };
  const current = readStatus(input.dir);
  if (typeof current === "string" || current.by !== "holder") {
    killTree(child.pid);
    boot("HOLDER_BOOT_FAILED:tombstone");
    return 1;
  }
  try {
    replaceRecord(statusPath, encodeRecord("status", running));
  } catch {
    // The folder was removed under us (the starter gave up): the child must not run on with no record.
    killTree(child.pid);
    return 1;
  }
  boot("ready");

  if (input.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, input.timeoutMs);
  }
  let lastWritten = now();
  const watcher = setInterval(() => {
    flush();
    if (!existsSync(input.dir)) {
      killTree(child.pid); // the directory was removed under a live child
      return;
    }
    if (lastOutputAt !== undefined && now() - lastWritten >= STATUS_MIN_INTERVAL_MS) {
      lastWritten = now();
      try {
        replaceRecord(statusPath, encodeRecord("status", { ...running, lastOutputAt }));
      } catch {
        // gone
      }
    }
  }, 1_000);

  const code = await exited;
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
    if (typeof check !== "string" && check.by === "holder") {
      replaceRecord(statusPath, encodeRecord("status", final));
    }
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
  const raw = await readInput(process.stdin);
  if (raw === undefined) return 1; // the starter died mid-write: nobody waits for an answer
  const parsed = holderInputSchema.safeParse(raw);
  if (!parsed.success) {
    const dir = (raw as { dir?: unknown } | null)?.dir;
    if (typeof dir === "string" && dir !== "")
      writeBoot(dir, "HOLDER_BOOT_FAILED:the input is not valid");
    return 1;
  }
  const input = parsed.data;
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
