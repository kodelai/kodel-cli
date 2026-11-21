/**
 * The client of `kodel agent attach`: a person's terminal on one side, the attach frames of a session's holder on
 * the other. The terminal is a trait, so the client is tested without one. Nothing here runs at import (raw mode,
 * signals and the window size are touched only inside `processTerminal`), so the module loads on Windows.
 */
import { spawnSync } from "node:child_process";
import {
  type AttachStream,
  createChordMatcher,
  createFrameDecoder,
  createModeTracker,
  encodeChunked,
  encodeHello,
  encodeResize,
  FRAME,
  isTerminalSize,
  parseBye,
  type TerminalSize,
  terminalResetFor,
} from "@kodel-ai/pipeline-core";
import { plain } from "./plain";

/** The signals that end an attach the way a detach does: the terminal is put back first. */
export const ATTACH_SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const;
export type AttachSignal = (typeof ATTACH_SIGNALS)[number];

/** What the client needs of the terminal it runs in. */
export interface AttachTerminal {
  /** `undefined` when the terminal does not say. */
  size(): TerminalSize | undefined;
  raw(on: boolean): void;
  /** `false`: the terminal takes no more for now, and `onDrain` says when it does again. */
  write(data: Uint8Array | string): boolean;
  onDrain(listener: () => void): void;
  /** Starts the reading. `undefined` is the end of the input (the terminal is gone). */
  onInput(listener: (data: Uint8Array | undefined) => void): void;
  onResize(listener: () => void): void;
  onSignal(listener: (signal: AttachSignal) => void): void;
  /** Stops what the listeners above started. */
  release(): void;
}

export interface AttachClientTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: AttachClientTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long the end of a read that may begin the chord is held: a lone Escape is a key, and must not wait for the next one. */
export const ATTACH_ESCAPE_HOLD_MS = 50;
/**
 * How long the input is read and thrown away after the reset: a terminal answers the queries of the last output
 * later than it shows it, and the answer must not land in the shell.
 */
export const ATTACH_DRAIN_MS = 150;
const FALLBACK_SIZE: TerminalSize = { cols: 80, rows: 24 };

export type AttachEnd =
  | { how: "detached" }
  | { how: "ended"; exitCode?: number }
  | { how: "killed"; text?: string }
  /** The holder refused or dropped this client (too many, a client that does not read, another version). */
  | { how: "refused"; text: string }
  /** The socket closed without a word: the holder is gone. */
  | { how: "lost" }
  | { how: "signal"; signal: AttachSignal }
  /** The input of the terminal ended: there is nobody to type any more. */
  | { how: "input_ended" };

export interface AttachResult {
  end: AttachEnd;
  /** The line the person was shown. */
  line: string;
  /** Why the command fails, when it does. */
  problem?: string;
}

/** What the command says when the holder ended with an error and gave no text of its own. */
export const HOLDER_ERROR_TEXT = "the holder of the session ended with an error";

export const attachLine = (name: string, end: AttachEnd): string => {
  const shown = plain(name);
  if (end.how === "ended") {
    return `[ended: ${shown}${end.exitCode !== undefined ? `, exit ${end.exitCode}` : ""}]`;
  }
  return end.how === "killed" ? `[killed: ${shown}]` : `[detached: ${shown}]`;
};

const problemOf = (end: AttachEnd): string | undefined => {
  switch (end.how) {
    case "refused":
      return end.text;
    case "lost":
      return "the connection to the session was lost (kodel agent ls shows its state)";
    case "signal":
      return `interrupted (${end.signal})`;
    case "input_ended":
      return "the input of the terminal ended";
    case "killed":
      return end.text;
    default:
      return undefined;
  }
};

export interface AttachClientOptions {
  stream: AttachStream;
  terminal: AttachTerminal;
  /** What the person called the session: it is in the line they read at the end. */
  name: string;
  timers?: AttachClientTimers;
}

/**
 * Runs until the person detaches, the session ends or the connection goes. On every way out the terminal gets
 * the reset and one visible line, the input that still arrives is thrown away for a moment, and only then the
 * terminal's own settings come back.
 */
export function runAttachClient(options: AttachClientOptions): Promise<AttachResult> {
  const { stream, terminal, name } = options;
  const timers = options.timers ?? realTimers;
  const decoder = createFrameDecoder();
  const matcher = createChordMatcher();
  // Follows what this terminal was shown, so the reset leaves the alternate screen only if it was entered.
  const shown = createModeTracker();
  let over = false;
  let held: unknown;
  let blocked = false;

  return new Promise<AttachResult>((resolve) => {
    const finish = (end: AttachEnd): void => {
      if (over) return;
      over = true;
      timers.clear(held);
      try {
        stream.close();
      } catch {
        // gone already
      }
      const line = attachLine(name, end);
      const problem = problemOf(end);
      terminal.write(`${terminalResetFor(shown.state())}\r\n${line}\r\n`);
      timers.set(() => {
        terminal.raw(false);
        terminal.release();
        resolve({ end, line, ...(problem !== undefined ? { problem } : {}) });
      }, ATTACH_DRAIN_MS);
    };

    const input = (bytes: Uint8Array): void => {
      for (const frame of encodeChunked(FRAME.INPUT, bytes)) stream.write(frame);
    };

    terminal.onDrain(() => {
      if (!blocked) return;
      blocked = false;
      if (!over) stream.resume();
    });
    terminal.onSignal((signal) => finish({ how: "signal", signal }));
    terminal.onResize(() => {
      const size = terminal.size();
      if (!over && size) stream.write(encodeResize(size));
    });
    terminal.onInput((data) => {
      // After the end the input is read and dropped: see ATTACH_DRAIN_MS.
      if (over) return;
      if (data === undefined) {
        finish({ how: "input_ended" });
        return;
      }
      timers.clear(held);
      const { pass, detach } = matcher.push(data);
      if (pass.length > 0) input(pass);
      if (detach) {
        finish({ how: "detached" });
        return;
      }
      held = timers.set(() => {
        const rest = matcher.flush();
        if (!over && rest.length > 0) input(rest);
      }, ATTACH_ESCAPE_HOLD_MS);
    });

    stream.onClose(() => finish({ how: "lost" }));
    stream.onData((data) => {
      if (over) return;
      const { frames, problem } = decoder.push(data);
      for (const frame of frames) {
        if (frame.type === FRAME.OUTPUT) {
          // The holder probes a client that is held at its input bound with an empty frame.
          if (frame.payload.length === 0) continue;
          shown.feed(frame.payload);
          if (!terminal.write(frame.payload) && !blocked) {
            blocked = true;
            stream.pause();
          }
        } else if (frame.type === FRAME.BYE) {
          const bye = parseBye(frame.payload);
          if (bye?.reason === "exited") {
            finish({
              how: "ended",
              ...(bye.exitCode !== undefined ? { exitCode: bye.exitCode } : {}),
            });
          } else if (bye?.reason === "killed" || bye?.reason === "holder_error") {
            finish({
              how: "killed",
              // An error of the holder is a failure of the command, with or without words of its own.
              ...(bye.reason === "holder_error"
                ? { text: bye.text ? plain(bye.text) : HOLDER_ERROR_TEXT }
                : {}),
            });
          } else {
            finish({
              how: "refused",
              text: plain(bye?.text || "the session closed the connection"),
            });
          }
          return;
        }
      }
      if (problem)
        finish({ how: "refused", text: "the session answered with a frame that cannot be read" });
    });

    terminal.raw(true);
    try {
      stream.write(encodeHello(terminal.size() ?? FALLBACK_SIZE));
    } catch {
      // The terminal is raw by now: a connection that fails here ends as every other does, never with a throw.
      finish({ how: "lost" });
    }
  });
}

interface Emitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}
interface TtyIn extends Emitter {
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}
interface TtyOut extends Emitter {
  columns?: number;
  rows?: number;
  write(data: Uint8Array | string): boolean;
}
interface SignalSource {
  on(signal: AttachSignal, listener: () => void): unknown;
  off(signal: AttachSignal, listener: () => void): unknown;
}

/** The size of the terminal this process writes to, when it says one. */
export const terminalSizeOf = (out: {
  columns?: number;
  rows?: number;
}): TerminalSize | undefined => {
  const size = { cols: out.columns, rows: out.rows };
  return isTerminalSize(size) ? size : undefined;
};

/**
 * Node's raw mode leaves the terminal's output processing on: a line feed the session sends is drawn as a
 * carriage return and a line feed, which breaks every program that moves the cursor down with one. `stty` switches
 * it off for the terminal on stdin; leaving raw mode puts back everything that was saved when it was entered.
 */
const outputAsIs = (): void => {
  try {
    spawnSync("stty", ["-opost"], { stdio: ["inherit", "ignore", "ignore"], timeout: 2_000 });
  } catch {
    // no stty: the output keeps the extra carriage returns
  }
};

/** The terminal of this process. */
export function processTerminal(
  stdin: TtyIn = process.stdin,
  stdout: TtyOut = process.stdout,
  signals: SignalSource = process,
  noOutputProcessing: () => void = outputAsIs,
): AttachTerminal {
  const undo: (() => void)[] = [];
  const listen = (source: Emitter, event: string, listener: (...args: unknown[]) => void): void => {
    source.on(event, listener);
    undo.push(() => source.off(event, listener));
  };
  // A terminal that went away answers a write with an error; there is nobody left to show it to.
  listen(stdout, "error", () => {});
  listen(stdin, "error", () => {});
  return {
    size: () => terminalSizeOf(stdout),
    raw(on) {
      try {
        stdin.setRawMode?.(on);
        if (on) noOutputProcessing();
      } catch {
        // the terminal is gone
      }
    },
    write(data) {
      try {
        return stdout.write(data);
      } catch {
        return true;
      }
    },
    onDrain: (listener) => listen(stdout, "drain", listener),
    onInput(listener) {
      listen(stdin, "data", (chunk) =>
        listener(
          typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk as Uint8Array),
        ),
      );
      listen(stdin, "end", () => listener(undefined));
      stdin.resume();
    },
    onResize: (listener) => listen(stdout, "resize", listener),
    onSignal(listener) {
      for (const signal of ATTACH_SIGNALS) {
        const handler = () => listener(signal);
        signals.on(signal, handler);
        undo.push(() => signals.off(signal, handler));
      }
    },
    release() {
      for (const step of undo.splice(0)) step();
      stdin.pause();
    },
  };
}
