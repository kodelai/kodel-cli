import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  foldSessionName,
  isLocalSessionId,
  isSessionId,
  isSessionName,
  planSend,
  SESSION_ERROR_CODES,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  STOP_BY,
  stopAskerOf,
  stoppedByPerson,
  trackBracketedPaste,
  trackBracketedPasteChunk,
  validateSpec,
} from "../src/session";

const base: SessionSpec = { argv: ["sleep", "1"], cwd: "/work" };

describe("session ids and names", () => {
  test("tA_session_id_dots_refused", () => {
    for (const bad of ["", ".", "..", ".hidden", "a/b", "a\\b", "a b", "x".repeat(65), "%2e%2e"]) {
      expect(isSessionId(bad)).toBe(false);
    }
    for (const good of ["a", "a_000000000_0000", "Foo.bar-1", "x".repeat(64)]) {
      expect(isSessionId(good)).toBe(true);
    }
  });

  test("tA_local_id_shape_is_strict", () => {
    expect(isLocalSessionId("a_000000000_0000")).toBe(true);
    for (const bad of [
      "names",
      "..",
      "x.names",
      "a_00000000_0000",
      "r_000000000_0000",
      "a_000000000_00000",
    ]) {
      expect(isLocalSessionId(bad)).toBe(false);
    }
  });

  test("tA_name_case_folded", () => {
    expect(isSessionName("n711de6a773")).toBe(true);
    expect(isSessionName("-x")).toBe(false);
    expect(foldSessionName("Foo")).toBe(foldSessionName("foo"));
  });

  test("tA_session_each_code_is_listed_once", () => {
    expect(new Set(SESSION_ERROR_CODES).size).toBe(SESSION_ERROR_CODES.length);
    for (const code of [
      "NAME_TAKEN",
      "NAME_USED",
      "HOLDER_BOOT_FAILED",
      "IDENTITY_UNKNOWN",
      "PLATFORM_UNSUPPORTED",
    ]) {
      expect(SESSION_ERROR_CODES).toContain(code as never);
    }
  });
});

describe("session error codes", () => {
  test("tA_session_error_codes_pin_not_attachable", () => {
    expect(SESSION_ERROR_CODES).toContain("NOT_ATTACHABLE");
    expect([...SESSION_ERROR_CODES]).toEqual([
      "UNKNOWN",
      "NOT_FOUND",
      "CANNOT_READ",
      "NEWER_FORMAT",
      "NAME_TAKEN",
      "NAME_USED",
      "SPEC_INVALID",
      "PLATFORM_UNSUPPORTED",
      "IDENTITY_UNKNOWN",
      "HOLDER_BOOT_FAILED",
      "STATE_UNWRITABLE",
      "NOT_RUNNING",
      "STILL_RUNNING",
      "UNSUPPORTED",
      "NOT_ATTACHABLE",
    ]);
  });
});

describe("validateSpec", () => {
  test("tA_validate_spec_size_only_for_pty", () => {
    const size = { cols: 120, rows: 40 };
    expect(validateSpec({ ...base, mode: "pty", size })).toBeUndefined();
    expect(validateSpec({ ...base, mode: "pty" })).toBeUndefined();
    expect(validateSpec({ ...base, size })).toContain("pty");
    expect(validateSpec({ ...base, mode: "pipes", size })).toContain("pty");
    for (const bad of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: -1 },
      { cols: 80.5, rows: 24 },
      { cols: 80 },
      { cols: 100_000, rows: 24 },
      "80x24",
    ]) {
      expect(validateSpec({ ...base, mode: "pty", size: bad as never })).toBe("size is not valid");
    }
  });

  test("tA_validate_spec_accepts_a_plain_spec", () => {
    expect(validateSpec(base)).toBeUndefined();
    expect(validateSpec({ command: "echo hi", cwd: "C:\\work" })).toBeUndefined();
  });

  test("tA_validate_spec_table", () => {
    const bad: [string, SessionSpec][] = [
      ["both command and argv", { ...base, command: "x" }],
      ["neither", { cwd: "/work" }],
      ["empty argv", { argv: [], cwd: "/work" }],
      ["empty program", { argv: [""], cwd: "/work" }],
      ["relative cwd", { ...base, cwd: "work" }],
      ["relative dotted cwd", { ...base, cwd: "./work" }],
      ["zero timeout", { ...base, timeoutMs: 0 }],
      ["negative timeout", { ...base, timeoutMs: -1 }],
      ["NaN timeout", { ...base, timeoutMs: Number.NaN }],
      ["non-string env", { ...base, env: { A: 1 as unknown as string } }],
      ["bad env name", { ...base, env: { "A-B": "x" } }],
      ["KODEL_ENGINE", { ...base, env: { KODEL_ENGINE: "0" } }],
      ["KODEL_STATE_DIR", { ...base, env: { KODEL_STATE_DIR: "/x" } }],
      ["any KODEL_ name", { ...base, env: { KODEL_OTHER: "x" } }],
      ["bad name", { ...base, name: "../x" }],
      ["bad parent", { ...base, parent: ".." }],
    ];
    for (const [label, spec] of bad) {
      expect(validateSpec(spec), label).toBeTypeOf("string");
    }
  });
});

describe("validateSpec, the agent of a session", () => {
  test("tA_spec_agent_is_validated", () => {
    const id = "0f4b1c2d-0000-4000-8000-000000000001";
    expect(validateSpec({ ...base, agent: { engine: "claude" } })).toBeUndefined();
    expect(validateSpec({ ...base, agent: { engine: "claude", session: id } })).toBeUndefined();
    expect(
      validateSpec({
        ...base,
        agent: { engine: "claude", session: id, resumes: "a_000000000_0001" },
      }),
    ).toBeUndefined();
    const refused: [string, unknown][] = [
      ["not an object", "claude"],
      ["a list", ["claude"]],
      ["no engine", { session: id }],
      ["an engine that is not a profile name", { engine: "Claude Code" }],
      ["an empty engine", { engine: "" }],
      ["a session with a space", { engine: "claude", session: "a b" }],
      ["a session that reads as a flag", { engine: "claude", session: "--resume" }],
      ["an empty session", { engine: "claude", session: "" }],
      ["a session that is not a string", { engine: "claude", session: 7 }],
      ["a session longer than an id", { engine: "claude", session: "a".repeat(200) }],
      ["resumes that is a path", { engine: "claude", resumes: "../other" }],
      ["a prompt", { engine: "claude", prompt: "do the task" }],
      ["a source (the starter's to write)", { engine: "claude", session: id, source: "chosen" }],
    ];
    for (const [label, agent] of refused) {
      const problem = validateSpec({ ...base, agent: agent as never });
      expect(problem, label).toBeTypeOf("string");
      expect(problem, label).toContain("agent");
    }
  });
});

describe("validateSpec, rules added after review", () => {
  test("tA_validate_spec_lifetime_origin_and_host_timeout", () => {
    expect(validateSpec({ ...base, lifetime: "forever" as never })).toBeTypeOf("string");
    expect(validateSpec({ ...base, origin: "robot" as never })).toBeTypeOf("string");
    expect(validateSpec({ ...base, inheritEnv: "yes" as never })).toBeTypeOf("string");
    expect(validateSpec({ ...base, origin: "host" })).toContain("timeoutMs");
    expect(validateSpec({ ...base, origin: "host", timeoutMs: 1000 })).toBeUndefined();
    expect(validateSpec({ ...base, origin: "host", lifetime: "with-starter" })).toBeUndefined();
    expect(validateSpec({ ...base, origin: "cli" })).toBeUndefined();
    expect(validateSpec({ ...base, timeoutMs: 2 ** 31 })).toContain("24 days");
    expect(validateSpec({ ...base, timeoutMs: 2 ** 31 - 1 })).toBeUndefined();
  });
});

describe("deriveStatus", () => {
  const started = 1_000_000;
  const snap = (over: Partial<SessionSnapshot>): SessionSnapshot => ({
    exists: true,
    session: { v: 1, started },
    status: "missing",
    holderAlive: false,
    childAlive: false,
    stop: "missing",
    ...over,
  });
  const at = (s: SessionSnapshot, now = started + 1, grace = 30_000) => deriveStatus(s, now, grace);

  test("tA_derive_status_unknown_and_unreadable", () => {
    expect(at(snap({ exists: false }))).toEqual({ ok: false, code: "UNKNOWN" });
    expect(at(snap({ session: "missing" }))).toEqual({ ok: false, code: "CANNOT_READ" });
    expect(at(snap({ session: "unreadable" }))).toEqual({ ok: false, code: "CANNOT_READ" });
    expect(at(snap({ session: { v: 2, started } }))).toEqual({ ok: false, code: "NEWER_FORMAT" });
    expect(at(snap({ status: "unreadable" }))).toEqual({ ok: false, code: "CANNOT_READ" });
  });

  test("tA_derive_status_no_status_file_waits_then_lost", () => {
    expect(at(snap({}), started + 29_999)).toEqual({ ok: true, status: { state: "starting" } });
    const late = at(snap({ childAlive: true }), started + 30_000);
    expect(late).toEqual({
      ok: true,
      status: { state: "lost", reason: "no_status", childAlive: true },
    });
  });

  test("tA_derive_status_starting_needs_a_live_holder", () => {
    expect(at(snap({ status: { state: "starting" }, holderAlive: true }))).toEqual({
      ok: true,
      status: { state: "starting" },
    });
    expect(at(snap({ status: { state: "starting" }, holderAlive: false }))).toEqual({
      ok: true,
      status: { state: "lost", reason: "holder_gone", childAlive: false },
    });
  });

  test("tA_derive_status_terminal_is_kept_and_child_alive_is_reported", () => {
    const done = at(snap({ status: { state: "exited", exitCode: 3 } }));
    expect(done).toEqual({ ok: true, status: { state: "exited", exitCode: 3 } });
    const killed = at(snap({ status: { state: "killed", reason: "timeout" }, childAlive: true }));
    expect(killed).toEqual({
      ok: true,
      status: { state: "killed", reason: "timeout", childAlive: true },
    });
  });

  test("tA_derive_status_running_rows", () => {
    const running = { state: "running" } as const;
    expect(at(snap({ status: running, holderAlive: true }))).toEqual({
      ok: true,
      status: { state: "running" },
    });
    expect(at(snap({ status: running, stop: "person", childAlive: true }))).toEqual({
      ok: true,
      status: { state: "killed", reason: "stopped", stoppedBy: "person", childAlive: true },
    });
    expect(at(snap({ status: running, stop: "unreadable" }))).toEqual({
      ok: false,
      code: "CANNOT_READ",
    });
    expect(at(snap({ status: running }))).toEqual({
      ok: true,
      status: { state: "lost", reason: "holder_gone", childAlive: false },
    });
  });

  // Every end a status record can name, and every end a reader works out for a holder that is gone.
  const ENDS: [string, Partial<SessionSnapshot>, SessionStatus][] = [
    ["exited", { status: { state: "exited", exitCode: 0 } }, { state: "exited", exitCode: 0 }],
    [
      "killed by a stop",
      { status: { state: "killed", reason: "stopped" } },
      { state: "killed", reason: "stopped" },
    ],
    [
      "killed by its timeout",
      { status: { state: "killed", reason: "timeout" } },
      { state: "killed", reason: "timeout" },
    ],
    [
      "killed by a holder error",
      { status: { state: "killed", reason: "holder_error" } },
      { state: "killed", reason: "holder_error" },
    ],
    [
      "killed by a signal",
      { status: { state: "killed", signal: "SIGTERM" } },
      { state: "killed", signal: "SIGTERM" },
    ],
    [
      "killed: a start that came late",
      { status: { state: "killed", reason: "start_late" } },
      { state: "killed", reason: "start_late" },
    ],
    [
      "killed: rules unknown",
      { status: { state: "killed", reason: "rules_unknown" } },
      { state: "killed", reason: "rules_unknown" },
    ],
    [
      "lost, as a reader recorded it",
      { status: { state: "lost", reason: "no_status" } },
      { state: "lost", reason: "no_status" },
    ],
    [
      "no status after the grace",
      { status: "missing" },
      { state: "lost", reason: "no_status", childAlive: false },
    ],
    [
      "starting, holder gone",
      { status: { state: "starting" } },
      { state: "lost", reason: "holder_gone", childAlive: false },
    ],
  ];
  const late = started + 30_000;

  test("tA_derive_status_a_persons_stop_shows_whatever_the_record_says", () => {
    for (const [label, over, status] of ENDS) {
      // Nobody asked for a stop: no asker, and only the reason `stopped` alone reads as the person's.
      const plain = at(snap(over), late);
      expect(plain, label).toEqual({ ok: true, status });
      expect(stoppedByPerson(status), label).toBe(status.reason === "stopped");
      // The person's stop record is there (their stop ended what the holder had left): the end stays as it
      // was recorded, and the status says a person stopped it.
      for (const childAlive of [false, true]) {
        const stopped = at(snap({ ...over, stop: "person", childAlive }), late);
        expect(stopped.ok, label).toBe(true);
        if (!stopped.ok) continue;
        const { childAlive: _recorded, ...end } = status;
        expect(stopped.status, label).toMatchObject({ ...end, stoppedBy: "person" });
        expect(stopped.status.childAlive === true, label).toBe(childAlive);
        expect(stoppedByPerson(stopped.status), label).toBe(true);
      }
    }
    // A holder that went away while it ran, with the person's stop record.
    const running = at(snap({ status: { state: "running" }, stop: "person" }), late);
    expect(running).toEqual({
      ok: true,
      status: { state: "killed", reason: "stopped", stoppedBy: "person", childAlive: false },
    });
  });

  test("tA_derive_status_a_finish_stop_is_not_the_persons", () => {
    for (const [label, over, status] of ENDS) {
      const finished = at(snap({ ...over, stop: "finish" }), late);
      expect(finished, label).toEqual({ ok: true, status: { ...status, stoppedBy: "finish" } });
      if (!finished.ok) continue;
      // Also for a record whose reason is `stopped`: the stop record says kodel asked.
      expect(stoppedByPerson(finished.status), label).toBe(false);
    }
    const running = at(snap({ status: { state: "running" }, stop: "finish" }), late);
    expect(running).toEqual({
      ok: true,
      status: { state: "killed", reason: "stopped", stoppedBy: "finish", childAlive: false },
    });
    expect(running.ok && stoppedByPerson(running.status)).toBe(false);
  });

  test("tA_derive_status_an_unreadable_stop_record_is_never_nobody_asked", () => {
    for (const [label, over] of ENDS) {
      expect(at(snap({ ...over, stop: "unreadable" }), late), label).toEqual({
        ok: false,
        code: "CANNOT_READ",
      });
    }
  });

  test("tA_derive_status_a_live_session_names_no_stop", () => {
    for (const stop of ["person", "finish", "unreadable"] as const) {
      for (const state of ["starting", "running"] as const) {
        expect(at(snap({ status: { state }, holderAlive: true, stop }))).toEqual({
          ok: true,
          status: { state },
        });
      }
      expect(at(snap({ stop }), started + 1)).toEqual({ ok: true, status: { state: "starting" } });
    }
  });

  test("tA_stop_record_by_names_the_asker", () => {
    expect(STOP_BY).toEqual({ person: "stop", finish: "finish" });
    expect(stopAskerOf("finish")).toBe("finish");
    // `stop` is the person's, and so is anything this build does not know: nobody else is taken for the person.
    for (const by of ["stop", "", "person", "daemon", "FINISH"]) {
      expect(stopAskerOf(by), by).toBe("person");
    }
  });
});

describe("send planning", () => {
  test("tA_send_plain_text_without_bracketed_paste", () => {
    expect(planSend("hello", false)).toEqual({ paste: "hello", submit: "\r" });
  });

  test("tA_send_wraps_only_when_mode_2004_is_on", () => {
    expect(planSend("a\nb", true).paste).toBe("\u001b[200~a\nb\u001b[201~");
  });

  test("tA_send_strips_an_embedded_paste_end", () => {
    expect(planSend("x\u001b[201~rm -rf", true).paste).toBe("\u001b[200~xrm -rf\u001b[201~");
  });

  test("tA_track_bracketed_paste_follows_the_last_switch", () => {
    expect(trackBracketedPaste("no switch", false)).toBe(false);
    expect(trackBracketedPaste("a\u001b[?2004hb", false)).toBe(true);
    expect(trackBracketedPaste("\u001b[?2004h x \u001b[?2004l", true)).toBe(false);
    expect(trackBracketedPaste("\u001b[?2004l x \u001b[?2004h", false)).toBe(true);
    expect(trackBracketedPaste("plain", true)).toBe(true);
  });

  test("tA_track_bracketed_paste_follows_a_full_reset: a program that crashed and was `reset` has the mode off", () => {
    expect(trackBracketedPaste("\u001bc", true)).toBe(false);
    expect(trackBracketedPaste("\u001b[?2004h x \u001bc", false)).toBe(false);
    // a switch after the reset wins; a reset before no switch leaves the mode off
    expect(trackBracketedPaste("\u001bc \u001b[?2004h", false)).toBe(true);
    expect(trackBracketedPaste("\u001bc \u001b[?2004l", true)).toBe(false);
    // `ESC c` inside a longer sequence is not a reset
    expect(trackBracketedPaste("\u001b[?2004h\u001b]0;abc", false)).toBe(true);
  });

  test("tA_track_bracketed_paste_combined_modes: a switch that sets several modes at once", () => {
    expect(trackBracketedPaste("\u001b[?1049;2004h", false)).toBe(true);
    expect(trackBracketedPaste("\u001b[?2004;1004;25l", true)).toBe(false);
    expect(trackBracketedPaste("\u001b[?1;2004;1000h x \u001b[?25;2004l", false)).toBe(false);
    expect(trackBracketedPaste("\u001b[?2004l\u001b[?1049;2004h", false)).toBe(true);
    // other modes, a mode that only ends in the digits, and a sequence that is no switch leave it as it was
    for (const other of [
      "\u001b[?1049h",
      "\u001b[?12004h",
      "\u001b[?20041h",
      "\u001b[?2004$p",
      "\u001b[2004h",
      "\u001b[?2004",
    ]) {
      expect(trackBracketedPaste(other, false), JSON.stringify(other)).toBe(false);
      expect(trackBracketedPaste(other.replace("h", "l"), true), JSON.stringify(other)).toBe(true);
    }
    // cut at every place, the halves in two chunks
    for (const [text, start] of [
      ["\u001b[?1049;2004h", false],
      ["\u001b[?1049;2004;1004l", true],
      ["\u001b[?2004;1h", false],
    ] as const) {
      for (let cut = 1; cut < text.length; cut++) {
        let track = trackBracketedPasteChunk(`text${text.slice(0, cut)}`, { on: start, carry: "" });
        expect(track.on, `${JSON.stringify(text)} ${cut}`).toBe(start);
        track = trackBracketedPasteChunk(`${text.slice(cut)}more`, track);
        expect(track.on, `${JSON.stringify(text)} ${cut}`).toBe(!start);
        expect(track.carry).toBe("");
      }
      let track = { on: start, carry: "" };
      for (const char of text) track = trackBracketedPasteChunk(char, track);
      expect(track.on).toBe(!start);
    }
    // the carry is bounded: nothing that cannot become a switch is kept
    expect(trackBracketedPasteChunk(`\u001b[?${"1;".repeat(100)}`).carry).toBe("");
    expect(trackBracketedPasteChunk("\u001b[31").carry).toBe("");
    expect(trackBracketedPasteChunk("x".repeat(500)).carry).toBe("");
  });
});

describe("bracketed paste over chunks", () => {
  test("tA_bracketed_paste_carry", () => {
    const on = "\u001b[?2004h";
    const off = "\u001b[?2004l";
    for (const [first, second, start, end] of [
      [on, off, false, false],
      [off, on, true, true],
    ] as const) {
      // each switch cut at every place, the two halves in two chunks
      for (let cut = 1; cut < first.length; cut++) {
        let track = { on: start, carry: "" };
        track = trackBracketedPasteChunk(`text${first.slice(0, cut)}`, track);
        expect(track.on).toBe(start);
        track = trackBracketedPasteChunk(`${first.slice(cut)}more`, track);
        expect(track.on).toBe(!start);
        track = trackBracketedPasteChunk(second.slice(0, cut), track);
        track = trackBracketedPasteChunk(second.slice(cut), track);
        expect(track.on).toBe(end);
        // output without a switch keeps the state, however long
        track = trackBracketedPasteChunk("x".repeat(50), track);
        expect(track.on).toBe(end);
      }
    }
    // byte by byte, and the default start
    let track = trackBracketedPasteChunk("");
    for (const char of `a${on}b`) track = trackBracketedPasteChunk(char, track);
    expect(track.on).toBe(true);
    // the old function looks at one string only: the split switch is what the carry is for
    expect(trackBracketedPaste("\u001b[?20", false)).toBe(false);
  });
});
