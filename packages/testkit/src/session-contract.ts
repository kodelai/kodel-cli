/**
 * The conformance suite of the Session adapter contract, as plain data (`{ name, portable, run }`): a test file
 * registers the cases with its own `test`. The same cases run against the in-memory fake, the remote-style adapter,
 * the local pipes adapter and (M2) the PTY adapter. `portable` cases are what a remote runner must also pass: the
 * consumer's retry rule (find a session again by name, `NAME_USED` after `remove`) rests on them.
 */
import { type SessionAdapter, SessionError, type SessionSpec } from "@kodel-ai/pipeline-core";

export interface SessionSubject {
  adapter: SessionAdapter;
  /** A spec for a program: `exit(n)`, `echoExit(text, n)`, `hang()` (never ends until stopped). */
  programs: {
    exit(code: number): Partial<SessionSpec>;
    echoExit(text: string, code: number): Partial<SessionSpec>;
    hang(): Partial<SessionSpec>;
  };
  cwd: string;
  /** An id that was never made and is valid for this adapter's grammar. */
  unknownId: string;
  dispose?: () => Promise<void> | void;
}

export interface SessionContractCase {
  name: string;
  portable: boolean;
  run(): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`session conformance: ${message}`);
}

const code = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof SessionError ? error.code : `other:${String(error)}`;
  }
};

export function sessionContract(
  make: () => Promise<SessionSubject> | SessionSubject,
): SessionContractCase[] {
  const spec = (
    s: SessionSubject,
    program: Partial<SessionSpec>,
    extra: Partial<SessionSpec> = {},
  ): SessionSpec => ({ cwd: s.cwd, ...program, ...extra }) as SessionSpec;

  const withSubject = (
    name: string,
    portable: boolean,
    body: (s: SessionSubject) => Promise<void>,
  ): SessionContractCase => ({
    name,
    portable,
    run: async () => {
      const subject = await make();
      try {
        await body(subject);
      } finally {
        await subject.dispose?.();
      }
    },
  });

  return [
    withSubject("start_wait_exit_code_and_tail", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.echoExit("hello", 3)));
      const done = await s.adapter.wait(id, { timeoutMs: 15_000 });
      assert(
        done.state === "exited" && done.exitCode === 3,
        `expected exited/3, got ${JSON.stringify(done)}`,
      );
      assert((await s.adapter.tail(id)).text.includes("hello"), "tail holds the output");
      assert(done.childAlive !== true, "no child is alive after exit");
    }),
    withSubject("wait_bound_returns_timedOut_while_running", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.hang()));
      const waited = await s.adapter.wait(id, { timeoutMs: 150 });
      assert(
        waited.timedOut === true && waited.state === "running",
        `got ${JSON.stringify(waited)}`,
      );
      await s.adapter.stop(id);
    }),
    withSubject("stop_kills_and_marks_stopped_and_is_idempotent", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.hang()));
      const first = await s.adapter.stop(id);
      assert(
        first.state === "killed" && first.reason === "stopped",
        `got ${JSON.stringify(first)}`,
      );
      const second = await s.adapter.stop(id);
      assert(second.state === "killed", "stop on a terminal session answers the same state");
    }),
    withSubject("timeout_kills_with_reason", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.hang(), { timeoutMs: 300 }));
      const done = await s.adapter.wait(id, { timeoutMs: 15_000 });
      assert(done.state === "killed" && done.reason === "timeout", `got ${JSON.stringify(done)}`);
    }),
    withSubject("remove_refuses_running_and_removes_terminal", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.hang()));
      assert(
        (await code(s.adapter.remove(id))) === "STILL_RUNNING",
        "a running session is not removed",
      );
      await s.adapter.stop(id);
      await s.adapter.remove(id);
      assert((await code(s.adapter.status(id))) === "NOT_FOUND", "a removed session is gone");
    }),
    withSubject("unknown_id_is_not_found", true, async (s) => {
      assert((await code(s.adapter.status(s.unknownId))) === "NOT_FOUND", "status");
      assert((await code(s.adapter.stop(s.unknownId))) === "NOT_FOUND", "stop");
      assert((await code(s.adapter.tail(s.unknownId))) === "NOT_FOUND", "tail");
    }),
    withSubject("invalid_spec_is_refused", true, async (s) => {
      assert(
        (await code(s.adapter.start({ argv: [], cwd: s.cwd }))) === "SPEC_INVALID",
        "empty argv",
      );
      assert(
        (await code(s.adapter.start({ argv: ["x"], cwd: "relative" }))) === "SPEC_INVALID",
        "relative cwd",
      );
      assert(
        (await code(
          s.adapter.start(spec(s, s.programs.exit(0), { env: { KODEL_ENGINE: "0" } })),
        )) === "SPEC_INVALID",
        "reserved env",
      );
    }),
    withSubject("name_taken_while_live_used_after_remove_case_folded", true, async (s) => {
      const first = await s.adapter.start(spec(s, s.programs.hang(), { name: "Step-1" }));
      assert(
        (await code(s.adapter.start(spec(s, s.programs.exit(0), { name: "step-1" })))) ===
          "NAME_TAKEN",
        "taken",
      );
      await s.adapter.stop(first.id);
      await s.adapter.remove(first.id);
      assert(
        (await code(s.adapter.start(spec(s, s.programs.exit(0), { name: "STEP-1" })))) ===
          "NAME_USED",
        "used",
      );
    }),
    withSubject("list_by_name_finds_a_live_session_again", true, async (s) => {
      const { id } = await s.adapter.start(spec(s, s.programs.hang(), { name: "n1" }));
      const found = await s.adapter.list({ name: "N1" });
      assert(found.length === 1 && found[0]?.id === id, `got ${JSON.stringify(found)}`);
      assert((await s.adapter.list({ name: "other" })).length === 0, "another name finds nothing");
      await s.adapter.stop(id);
    }),
  ];
}
