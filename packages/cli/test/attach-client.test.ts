import { describe, expect, test } from "bun:test";
import {
  type ByeMessage,
  encodeBye,
  encodeFrame,
  encodeWelcome,
  FRAME,
  fromBinary,
  parseHello,
  parseSize,
  TERMINAL_RESET,
  type TerminalSize,
  toBinary,
} from "@kodel-ai/pipeline-core";
import { ManualTimers, memoryPair, TestClient } from "../../local/test/helpers/attach-fakes";
import {
  ATTACH_DRAIN_MS,
  ATTACH_ESCAPE_HOLD_MS,
  ATTACH_SIGNALS,
  type AttachResult,
  type AttachSignal,
  type AttachTerminal,
  attachLine,
  HOLDER_ERROR_TEXT,
  processTerminal,
  runAttachClient,
} from "../src/attach-client";

const ESC = "\u001b";
const LEAVE_SCREEN = `${ESC}[?1049l`;
/** What the client writes when the program never entered the alternate screen. */
const RESET = TERMINAL_RESET.slice(0, -LEAVE_SCREEN.length);

class FakeTerminal implements AttachTerminal {
  now: TerminalSize | undefined = { cols: 120, rows: 40 };
  /** What happened to the terminal, in order: `raw:on`, `raw:off`, `release`, and every write. */
  log: string[] = [];
  takes = true;
  released = false;
  private drain: (() => void)[] = [];
  private input: ((data: Uint8Array | undefined) => void)[] = [];
  private resizes: (() => void)[] = [];
  private signals: ((signal: AttachSignal) => void)[] = [];

  size = () => this.now;
  raw(on: boolean): void {
    this.log.push(on ? "raw:on" : "raw:off");
  }
  write(data: Uint8Array | string): boolean {
    this.log.push(typeof data === "string" ? data : toBinary(data));
    return this.takes;
  }
  onDrain(listener: () => void): void {
    this.drain.push(listener);
  }
  onInput(listener: (data: Uint8Array | undefined) => void): void {
    this.input.push(listener);
  }
  onResize(listener: () => void): void {
    this.resizes.push(listener);
  }
  onSignal(listener: (signal: AttachSignal) => void): void {
    this.signals.push(listener);
  }
  release(): void {
    this.released = true;
    this.log.push("release");
  }
  type(text: string | undefined): void {
    for (const listener of this.input) listener(text === undefined ? undefined : fromBinary(text));
  }
  resizeTo(cols: number, rows: number): void {
    this.now = { cols, rows };
    for (const listener of this.resizes) listener();
  }
  signal(signal: AttachSignal): void {
    for (const listener of this.signals) listener(signal);
  }
  drained(): void {
    this.takes = true;
    for (const listener of this.drain) listener();
  }
  get screen(): string {
    return this.log.filter((entry) => !/^(raw:|release$)/.test(entry)).join("");
  }
}

function attached(name = "worker") {
  const pair = memoryPair();
  const holder = new TestClient(pair.holder);
  const terminal = new FakeTerminal();
  const clock = new ManualTimers();
  let result: AttachResult | undefined;
  const timers = {
    set: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
    clear: (handle: unknown) => (handle as (() => void) | undefined)?.(),
  };
  void runAttachClient({ stream: pair.client, terminal, name, timers }).then((r) => {
    result = r;
  });
  const say = (text: string) => pair.holder.write(encodeFrame(FRAME.OUTPUT, fromBinary(text)));
  const bye = (message: ByeMessage) => pair.holder.write(encodeBye(message));
  const inputs = () =>
    holder.frames
      .filter((f) => f.type === FRAME.INPUT)
      .map((f) => toBinary(f.payload))
      .join("");
  /** The drain is over: the settled result. */
  const settle = async (): Promise<AttachResult> => {
    clock.advance(ATTACH_DRAIN_MS);
    await Promise.resolve();
    await Promise.resolve();
    if (!result) throw new Error("the client did not finish");
    return result;
  };
  return { pair, holder, terminal, clock, say, bye, inputs, settle, result: () => result };
}

describe("the attach client", () => {
  test("tA_attach_client_hello_carries_size_and_resize_follows", () => {
    const c = attached();
    expect(c.terminal.log[0]).toBe("raw:on");
    const hello = c.holder.frames[0];
    expect(hello?.type).toBe(FRAME.HELLO);
    expect(parseHello(hello?.payload as Uint8Array)).toEqual({
      v: 1,
      size: { cols: 120, rows: 40 },
    });
    c.pair.holder.write(encodeWelcome({ cols: 120, rows: 40 }));
    c.say("hello\r\n");
    expect(c.terminal.screen).toBe("hello\r\n");
    c.terminal.resizeTo(90, 30);
    const resize = c.holder.frames.find((f) => f.type === FRAME.RESIZE);
    expect(parseSize(resize?.payload as Uint8Array)).toEqual({ cols: 90, rows: 30 });
  });

  test("tA_attach_client_chord_detaches_and_keeps_the_session", async () => {
    for (const chord of ["\u001c", `${ESC}[92;5u`, `${ESC}[27;5;92~`]) {
      const c = attached();
      c.terminal.type("ab");
      c.terminal.type(`c${chord}never sent`);
      expect(c.inputs()).toBe("abc");
      expect(c.pair.client.closed).toBe(true);
      const result = await c.settle();
      expect(result).toEqual({ end: { how: "detached" }, line: "[detached: worker]" });
      // nothing but the chord was kept from the session, and no frame asks it to stop
      expect(c.holder.frames.map((f) => f.type)).toEqual([FRAME.HELLO, FRAME.INPUT, FRAME.INPUT]);
    }
  });

  test("tA_attach_client_ctrl_c_and_ctrl_bracket_are_input", () => {
    const c = attached();
    c.terminal.type("\u0003");
    c.terminal.type("\u001d");
    c.terminal.type(`${ESC}[93;5u`);
    c.clock.advance(ATTACH_ESCAPE_HOLD_MS);
    expect(c.inputs()).toBe(`\u0003\u001d${ESC}[93;5u`);
    expect(c.result()).toBeUndefined();
    expect(c.pair.client.closed).toBe(false);
  });

  test("tA_attach_client_flushes_a_lone_escape", () => {
    const c = attached();
    c.terminal.type(ESC);
    expect(c.inputs()).toBe(""); // held: it may begin the chord
    c.clock.advance(ATTACH_ESCAPE_HOLD_MS - 1);
    expect(c.inputs()).toBe("");
    c.clock.advance(1);
    expect(c.inputs()).toBe(ESC);
    // a chord split over two reads inside the hold is still the chord
    c.terminal.type(`${ESC}[92`);
    c.clock.advance(ATTACH_ESCAPE_HOLD_MS - 1);
    c.terminal.type(";5u");
    expect(c.pair.client.closed).toBe(true);
    expect(c.inputs()).toBe(ESC);
  });

  test("tA_attach_client_reset_and_line_on_every_way_out", async () => {
    const ways: [string, (c: ReturnType<typeof attached>) => void, string, string | undefined][] = [
      ["detach", (c) => c.terminal.type("\u001c"), "[detached: worker]", undefined],
      [
        "exit",
        (c) => c.bye({ reason: "exited", exitCode: 3 }),
        "[ended: worker, exit 3]",
        undefined,
      ],
      [
        "kill",
        (c) => c.bye({ reason: "killed", signal: "SIGTERM" }),
        "[killed: worker]",
        undefined,
      ],
      // an error of the holder fails the command, with the holder's words or, when it has none, with fixed ones
      [
        "holder error",
        (c) => c.bye({ reason: "holder_error", text: "the holder ended" }),
        "[killed: worker]",
        "the holder ended",
      ],
      [
        "holder error, empty text",
        (c) => c.bye({ reason: "holder_error", text: "" }),
        "[killed: worker]",
        HOLDER_ERROR_TEXT,
      ],
      [
        "holder error, no text",
        (c) => c.bye({ reason: "holder_error" }),
        "[killed: worker]",
        HOLDER_ERROR_TEXT,
      ],
      ["socket dropped", (c) => c.pair.holder.end(), "[detached: worker]", "connection"],
      ["SIGTERM", (c) => c.terminal.signal("SIGTERM"), "[detached: worker]", "SIGTERM"],
      ["SIGHUP", (c) => c.terminal.signal("SIGHUP"), "[detached: worker]", "SIGHUP"],
      ["SIGINT", (c) => c.terminal.signal("SIGINT"), "[detached: worker]", "SIGINT"],
      ["SIGQUIT", (c) => c.terminal.signal("SIGQUIT"), "[detached: worker]", "SIGQUIT"],
      [
        "terminal gone",
        (c) => c.terminal.type(undefined),
        "[detached: worker]",
        "the input of the terminal ended",
      ],
      [
        "refused",
        (c) => c.bye({ reason: "full", text: "8 clients are attached already" }),
        "[detached: worker]",
        "8 clients",
      ],
    ];
    for (const [way, act, line, problem] of ways) {
      const c = attached();
      c.say("output");
      act(c);
      // the reset and the line are written at once, the terminal's own settings only after the drain
      expect(c.terminal.screen, way).toBe(`output${RESET}\r\n${line}\r\n`);
      expect(c.terminal.log, way).not.toContain("raw:off");
      const result = await c.settle();
      expect(result.line, way).toBe(line);
      if (problem === undefined) expect(result.problem, way).toBeUndefined();
      else expect(result.problem, way).toContain(problem);
      expect(c.terminal.log.slice(-2), way).toEqual(["raw:off", "release"]);
      expect(c.pair.client.closed, way).toBe(true);
      // the end of the input is not reported as a signal nobody sent
      if (way === "terminal gone") expect(result.problem, way).not.toContain("SIG");
    }
  });

  test("tA_attach_client_leaves_the_alternate_screen_it_entered", () => {
    const c = attached();
    c.say(`${ESC}[?1049h${ESC}[?1000h`);
    c.terminal.type("\u001c");
    expect(c.terminal.screen).toContain(`${TERMINAL_RESET}\r\n[detached: worker]`);
  });

  test("tA_attach_client_drains_late_answer", async () => {
    const c = attached();
    c.say(`${ESC}[6n`); // a live query: the terminal answers it later than it shows it
    c.terminal.type("\u001c");
    const before = c.holder.frames.length;
    c.terminal.type(`${ESC}[12;40R`);
    c.clock.advance(ATTACH_DRAIN_MS - 1);
    c.terminal.type(`${ESC}[?62;c`);
    // read and thrown away: still raw (the shell does not see it), and nothing is sent to the session
    expect(c.terminal.log).not.toContain("raw:off");
    expect(c.terminal.released).toBe(false);
    expect(c.holder.frames.length).toBe(before);
    c.clock.advance(1);
    expect(c.terminal.log.slice(-2)).toEqual(["raw:off", "release"]);
    expect((await c.settle()).line).toBe("[detached: worker]");
  });

  test("tA_attach_client_pauses_the_stream_while_the_terminal_is_blocked", () => {
    const c = attached();
    c.terminal.takes = false;
    c.say("one");
    expect(c.pair.client.paused).toBe(true);
    c.say("two"); // stays in the stream: the holder sees the lag, not this process's memory
    expect(c.terminal.screen).toBe("one");
    expect(c.pair.holder.pending()).toBeGreaterThan(0);
    c.terminal.drained();
    expect(c.pair.client.paused).toBe(false);
    expect(c.terminal.screen).toBe("onetwo");
  });

  test("tA_attach_client_ignores_the_empty_probe_frame: the holder probes a client held at its input bound", () => {
    const c = attached();
    c.say("shown");
    const logged = c.terminal.log.length;
    c.say(""); // an empty OUTPUT frame
    expect(c.terminal.log.length).toBe(logged); // no write, so no screen change and no pause either
    expect(c.pair.client.paused).toBe(false);
    expect(c.terminal.screen).toBe("shown");
    c.terminal.takes = false;
    c.say("");
    expect(c.pair.client.paused).toBe(false);
  });

  test("tA_attach_client_refusal_without_words_still_says_something", async () => {
    const c = attached();
    c.bye({ reason: "full", text: "" });
    const result = await c.settle();
    expect(result.end.how).toBe("refused");
    expect(result.problem).toBeTruthy(); // the command fails with words, never with an empty message
  });

  test("tA_attach_client_line_never_carries_escapes", () => {
    expect(attachLine(`a${ESC}[31mb`, { how: "detached" })).not.toContain(ESC);
    expect(attachLine("n", { how: "ended" })).toBe("[ended: n]");
  });

  test("tA_attach_client_failed_hello_leaves_no_raw_terminal: a connection that throws at the first write", async () => {
    const terminal = new FakeTerminal();
    const clock = new ManualTimers();
    const closers: (() => void)[] = [];
    let result: AttachResult | undefined;
    let thrown: unknown;
    const stream = {
      write() {
        throw new Error("EPIPE");
      },
      pending: () => 0,
      onData() {},
      onClose: (listener: () => void) => void closers.push(listener),
      pause() {},
      resume() {},
      close() {
        throw new Error("closed already");
      },
    };
    try {
      void runAttachClient({
        stream,
        terminal,
        name: "worker",
        timers: {
          set: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
          clear: (handle: unknown) => (handle as (() => void) | undefined)?.(),
        },
      }).then(
        (r) => {
          result = r;
        },
        (error) => {
          thrown = error;
        },
      );
    } catch (error) {
      thrown = error;
    }
    clock.advance(ATTACH_DRAIN_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(thrown).toBeUndefined();
    expect(result?.end).toEqual({ how: "lost" });
    expect(terminal.log[0]).toBe("raw:on");
    expect(terminal.log.slice(-2)).toEqual(["raw:off", "release"]);
    expect(terminal.screen).toContain(`${RESET}\r\n[detached: worker]`);
  });

  test("tA_attach_client_process_terminal_touches_nothing_until_used", () => {
    const calls: string[] = [];
    const emitter = (name: string) => ({
      on: (event: string) => void calls.push(`${name}.on:${event}`),
      off: (event: string) => void calls.push(`${name}.off:${event}`),
    });
    const stdin = {
      ...emitter("in"),
      setRawMode: (on: boolean) => void calls.push(`raw:${on}`),
      resume: () => void calls.push("resume"),
      pause: () => void calls.push("pause"),
    };
    const stdout = { ...emitter("out"), columns: 100, rows: 30, write: () => true };
    const terminal = processTerminal(
      stdin,
      stdout,
      emitter("signal") as never,
      () => void calls.push("no-opost"),
    );
    expect(calls.filter((c) => c.startsWith("raw") || c.startsWith("signal"))).toEqual([]);
    expect(terminal.size()).toEqual({ cols: 100, rows: 30 });
    terminal.raw(true);
    // raw input alone keeps the output processing: it is switched off right after, and only on the way in
    expect(calls.slice(-2)).toEqual(["raw:true", "no-opost"]);
    terminal.raw(false);
    expect(calls.at(-1)).toBe("raw:false");
    terminal.onSignal(() => {});
    terminal.onResize(() => {});
    terminal.onInput(() => {});
    expect(ATTACH_SIGNALS).toEqual(["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"]);
    for (const signal of ATTACH_SIGNALS) expect(calls).toContain(`signal.on:${signal}`);
    expect(calls).toContain("out.on:resize");
    terminal.release();
    for (const signal of ATTACH_SIGNALS) expect(calls).toContain(`signal.off:${signal}`);
    expect(calls.at(-1)).toBe("pause");
  });
});
