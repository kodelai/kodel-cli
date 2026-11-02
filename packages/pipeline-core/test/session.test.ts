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
  trackBracketedPaste,
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

describe("validateSpec", () => {
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
    expect(at(snap({ status: running, stop: "present", childAlive: true }))).toEqual({
      ok: true,
      status: { state: "killed", reason: "stopped", childAlive: true },
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
});
