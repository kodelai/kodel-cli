/**
 * Engine steps (T-42): an agent node with `engine:` runs as a session the engine starts. The core holds
 * one open record per run, written by the decision that issues the start; an outcome that cannot be
 * proven fails the attempt and pauses the run until a person resumes.
 */
import { describe, expect, test } from "bun:test";
import {
  type Decision,
  decide,
  ENGINE_RESULT_READ_BYTES,
  ENGINE_STEPS_OFF,
  ENGINE_UNKNOWN_PREFIX,
  type EngineOptions,
  encodeJournalRecord,
  encodeRunState,
  engineOutcome,
  enginePrompt,
  engineSessionName,
  MAX_ENGINE_PROMPT_BYTES,
  MAX_ENGINE_RESULT_BYTES,
  MAX_TAKEOVERS,
  type PipelineSpec,
  parseEngineResult,
  parsePipeline,
  type RunEvent,
  type RunState,
  type SessionState,
  type SessionStatus,
  START_ERROR_OUTCOME,
  unknownReason,
  V1_STATE_KEYS,
  V2_ONLY_EVENTS,
  validatePipeline,
} from "../src";

const MCP: EngineOptions = { engineSteps: { start: true, owner: "host-a:1" } };
const HUMAN: EngineOptions = { engineSteps: { start: false } };

const ENGINE_PIPELINE = `
name: eng
nodes:
  - slug: plan
    kind: agent
    prompt: plan {{task}}
  - slug: review
    kind: agent
    engine: reviewer
    model: big
    prompt: review {{task.slug}}
    checks:
      - kind: command
        command: "true"
  - slug: gate
    kind: human
    prompt: ok?
edges:
  - { from: plan, to: review }
  - { from: review, to: gate }
  - { from: gate, to: review, when: rejected }
`;

const spec = (): PipelineSpec => parsePipeline(ENGINE_PIPELINE);

function ok(decision: Decision): Extract<Decision, { ok: true }> {
  if (!decision.ok) throw decision.error;
  return decision;
}

const start = (): RunEvent => ({ type: "start", runId: "r_test", task: "fix it", specHash: "h1" });

/** A run of the engine pipeline that has just entered `review`, decided with `options`. */
function atReview(options: EngineOptions): Extract<Decision, { ok: true }> {
  const s = ok(decide(spec(), undefined, start(), 1, options)).state;
  return ok(decide(spec(), s, { type: "agent_completed", node: "plan", attempt: 1 }, 2, options));
}

describe("t42 the node fields and their refusals", () => {
  test("t42_engine_node_refusals", () => {
    const node = (extra: string, checks = "") => `
name: p
nodes:
  - slug: a
    kind: agent
    prompt: x
${extra}${checks}
`;
    const refused = (text: string, words: string) => {
      const result = validatePipeline(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.message).toContain(words);
    };
    // the valid control
    expect(validatePipeline(node("    engine: rev\n    model: m\n")).ok).toBe(true);
    refused(node("    model: m\n"), "model is only for a step with engine");
    refused(node("    engine: rev\n    fresh_context: true\n"), "fresh_context");
    refused(
      `${node("    engine: rev\n    outcomes: [small]\n")}edges:\n  - { from: a, to: a, when: small }\n`,
      "outcomes are not supported",
    );
    refused(
      node(
        "    engine: rev\n",
        "    checks:\n      - kind: result\n        columns: { a: text }\n",
      ),
      "a result check",
    );
    refused(node("    engine: Not_A_Name\n"), "profile name");
    // in a pipeline with a fork and a join
    refused(
      `
name: p
nodes:
  - { slug: a, kind: agent, prompt: x }
  - { slug: b, kind: agent, prompt: x, engine: rev }
  - { slug: c, kind: agent, prompt: x }
  - { slug: j, kind: agent, prompt: x, join: all }
edges:
  - { from: a, to: b }
  - { from: a, to: c }
  - { from: b, to: j }
  - { from: c, to: j }
`,
      "fork or a join",
    );
  });

  test("t42_spec_from_resolved_profile_request", () => {
    const review = spec().nodes.find((n) => n.slug === "review");
    expect(review?.params).toMatchObject({ engine: "reviewer", model: "big" });
  });
});

describe("t42 a host without engine steps", () => {
  test("t42_engine_field_refused_before_any_write", () => {
    // every decision on a pipeline with an engine step is refused, and a tick changes nothing
    const refused = decide(spec(), undefined, start(), 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe(ENGINE_STEPS_OFF);
    const state = atReview(HUMAN).state;
    const events: RunEvent[] = [
      { type: "resume" },
      { type: "cancel" },
      { type: "acknowledge" },
      { type: "feedback", category: "x", message: "y" },
      { type: "human_decided", node: "gate", decision: "approved" },
      { type: "agent_completed", node: "plan", attempt: 1 },
      { type: "step_claimed", token: "t", ttlMs: 1000 },
      { type: "run_migrated" },
      { type: "work_finished", node: "review", attempt: 1, passed: true, reason: "" },
      { type: "call_refused", about: "x", code: "X", message: "y" },
    ];
    for (const event of events) {
      const result = decide(spec(), state, event, 3);
      expect(result.ok, event.type).toBe(false);
    }
    const tick = ok(decide(spec(), state, { type: "tick" }, 3));
    expect(tick.noop).toBe(true);
    // the negative control: a pipeline without engine steps decides as before
    const plain = parsePipeline("name: p\nnodes:\n  - { slug: a, kind: agent, prompt: x }\n");
    expect(decide(plain, undefined, start(), 1).ok).toBe(true);
  });

  test("t42_no_engine_key_without_engine_nodes", () => {
    const plain = parsePipeline(
      "name: p\nnodes:\n  - { slug: a, kind: agent, prompt: x }\n  - { slug: b, kind: command, command: 'true', on_fail: failed }\nedges:\n  - { from: a, to: b }\n  - { from: b, to: a, when: failed }\n",
    );
    for (const options of [{}, MCP]) {
      const s = ok(decide(plain, undefined, start(), 1, options));
      const after = ok(
        decide(plain, s.state, { type: "agent_completed", node: "a", attempt: 1 }, 2, options),
      );
      expect(JSON.stringify(after.encoded)).not.toContain("engineSession");
      expect(after.state.engineSession).toBeUndefined();
      // the same bytes whether the host runs engine steps or not
      const without = ok(
        decide(
          plain,
          ok(decide(plain, undefined, start(), 1)).state,
          { type: "agent_completed", node: "a", attempt: 1 },
          2,
        ),
      );
      expect(JSON.stringify(after.encoded)).toBe(JSON.stringify(without.encoded));
    }
  });
});

describe("t42 the record and the start", () => {
  test("t42_record_written_before_start", () => {
    const entered = atReview(MCP);
    const record = entered.state.engineSession;
    expect(record).toEqual({
      node: "review",
      attempt: 1,
      visitId: 2,
      name: engineSessionName("r_test", 2, 1),
    });
    const effect = entered.effects.find((e) => e.type === "run_engine_step");
    expect(effect).toMatchObject({ mode: "start", node: "review", attempt: 1, name: record?.name });
    // the record is in what the store writes, in the same decision that issues the start
    expect((entered.encoded?.state as RunState | undefined)?.engineSession).toEqual(record);
    // the visit is the engine's: no heartbeat (the stale rule never applies), owned by the issuer
    const visit = entered.state.active.find((v) => v.node === "review");
    expect(visit?.phase).toBe("engine");
    expect(visit?.heartbeatAt).toBeUndefined();
    expect(visit?.owner).toBe("host-a:1");
  });

  test("t42_engine_session_started_idempotent", () => {
    const s = atReview(MCP).state;
    const name = s.engineSession?.name ?? "";
    const started: RunEvent = {
      type: "engine_session_started",
      node: "review",
      attempt: 1,
      name,
      id: "a_000000001_fake",
      launch: "f".repeat(64),
    };
    const once = ok(decide(spec(), s, started, 3, MCP));
    expect(once.state.engineSession?.id).toBe("a_000000001_fake");
    expect(once.journal.map((r) => r.event)).toEqual(["engine_session_started"]);
    expect(ok(decide(spec(), once.state, started, 4, MCP)).noop).toBe(true);
    const other = decide(spec(), once.state, { ...started, id: "a_000000002_fake" }, 4, MCP);
    expect(other.ok).toBe(false);
  });

  test("t42_human_decide_does_not_start", () => {
    const entered = atReview(HUMAN);
    expect(entered.state.engineSession).toBeUndefined();
    expect(entered.effects.some((e) => e.type === "run_engine_step")).toBe(false);
    expect(entered.state.active.find((v) => v.node === "review")?.phase).toBe("engine");
  });

  test("t42_pending_start_not_a_restart", () => {
    const s = atReview(HUMAN).state;
    const pending: RunEvent = { type: "engine_start_pending", node: "review", attempt: 1 };
    // a person's host never issues it
    expect(ok(decide(spec(), s, pending, 3, HUMAN)).noop).toBe(true);
    const issued = ok(decide(spec(), s, pending, 3, MCP));
    expect(issued.journal).toEqual([]);
    expect(issued.state.engineSession?.node).toBe("review");
    const visit = issued.state.active.find((v) => v.node === "review");
    expect(visit?.restarts).toBe(0);
    expect(visit?.takeovers).toBeUndefined();
    expect(issued.effects.filter((e) => e.type === "run_engine_step")).toHaveLength(1);
    // with a record open, a second pending is nothing
    expect(ok(decide(spec(), issued.state, pending, 4, MCP)).noop).toBe(true);
  });

  test("t42_only_issuing_decide_starts", () => {
    const s = atReview(MCP).state;
    // a tick, a stale clock and dead owners never restart a session visit
    const later = ok(
      decide(spec(), s, { type: "tick", deadOwners: ["host-a:1"] }, 10_000_000, MCP),
    );
    expect(later.effects).toEqual([]);
    // a heartbeat does not apply to it
    const beat = ok(
      decide(spec(), s, { type: "heartbeat", node: "review", attempt: 1, owner: "x" }, 5, MCP),
    );
    expect(beat.noop).toBe(true);
    // a takeover is a join, counted, never a start
    const joined = ok(
      decide(
        spec(),
        s,
        { type: "engine_session_joined", node: "review", attempt: 1, owner: "host-b:2" },
        5,
        MCP,
      ),
    );
    expect(joined.effects).toEqual([
      expect.objectContaining({ type: "run_engine_step", mode: "join" }),
    ]);
    expect(joined.state.active.find((v) => v.node === "review")?.takeovers).toBe(1);
    // past the limit the outcome is unknown, not a start
    let state = joined.state;
    for (let i = 0; i < MAX_TAKEOVERS; i++) {
      const owner = `host-${i % 2 === 0 ? "c" : "b"}:${i}`;
      state = ok(
        decide(
          spec(),
          state,
          { type: "engine_session_joined", node: "review", attempt: 1, owner },
          6 + i,
          MCP,
        ),
      ).state;
    }
    expect(state.status).toBe("paused");
    expect(state.nodes.review?.lastFailure?.source).toBe("session");
    expect(state.engineSession).toBeDefined();
  });
});

describe("t42 the outcome", () => {
  const exited = (code: number | undefined, extra: Partial<SessionStatus> = {}): SessionStatus => ({
    state: "exited",
    ...(code === undefined ? {} : { exitCode: code }),
    ...extra,
  });
  const json = JSON.stringify({ summary: "fine" });

  test("t42_outcome_table", () => {
    expect(engineOutcome(exited(0), { text: json, complete: true })).toEqual({
      kind: "result",
      summary: "fine",
    });
    expect(engineOutcome(exited(1), { text: json, complete: true }).kind).toBe("failed");
    expect(engineOutcome({ state: "killed", reason: "timeout" }).kind).toBe("failed");
    expect(engineOutcome(exited(0), { text: "nope", complete: true }).kind).toBe("failed");
    expect(engineOutcome(exited(0), { text: json, complete: false }).kind).toBe("failed");
    expect(engineOutcome({ state: "lost", reason: "holder_gone" }).kind).toBe("unknown");
    expect(
      engineOutcome(exited(0, { childAlive: true }), { text: json, complete: true }).kind,
    ).toBe("unknown");
    expect(engineOutcome(exited(0)).kind).toBe("unknown");
    expect(engineOutcome({ state: "running" }).kind).toBe("running");
    // the start table: a used name is unknown, everything else is decided by a list
    expect(START_ERROR_OUTCOME.NAME_USED).toBe("unknown");
  });

  test("t42_outcome_property", () => {
    const states: SessionState[] = ["starting", "running", "exited", "killed", "lost"];
    for (const state of states) {
      for (const exit of [undefined, 0, 1, 137]) {
        for (const childAlive of [false, true]) {
          for (const complete of [true, false]) {
            const status: SessionStatus = {
              state,
              ...(exit === undefined ? {} : { exitCode: exit }),
              ...(childAlive ? { childAlive } : {}),
            };
            const out = engineOutcome(status, { text: json, complete });
            if (childAlive) expect(out.kind).toBe("unknown");
            if (out.kind === "result") {
              expect(state).toBe("exited");
              expect(exit).toBe(0);
              expect(complete).toBe(true);
            }
            if (out.kind === "failed") expect(["exited", "killed"]).toContain(state);
          }
        }
      }
    }
  });

  test("t42_result_contract", () => {
    expect(parseEngineResult('{"summary":"a"}')).toEqual({ ok: true, summary: "a" });
    expect(parseEngineResult('{"result":"b"}')).toEqual({ ok: true, summary: "b" });
    expect(parseEngineResult('{"result":"b","extra":1}')).toEqual({ ok: true, summary: "b" });
    expect(parseEngineResult("").ok).toBe(false);
    expect(parseEngineResult("not json").ok).toBe(false);
    expect(parseEngineResult('{"summary":"a"} trailing').ok).toBe(false);
    expect(parseEngineResult('{"other":"x"}').ok).toBe(false);
    expect(parseEngineResult("[1]").ok).toBe(false);
    const fill = (bytes: number) => {
      const base = '{"summary":""}';
      return `{"summary":"${"x".repeat(bytes - base.length)}"}`;
    };
    expect(parseEngineResult(fill(MAX_ENGINE_RESULT_BYTES)).ok).toBe(true);
    expect(parseEngineResult(fill(MAX_ENGINE_RESULT_BYTES + 1)).ok).toBe(false);
    expect(parseEngineResult(fill(300 * 1024)).ok).toBe(false);
    expect(ENGINE_RESULT_READ_BYTES).toBe(MAX_ENGINE_RESULT_BYTES + 1);
  });

  test("t42_prompt_content_and_single_argv_element", () => {
    const text = enginePrompt("do it", ["report rows"], {
      source: "check:command",
      reason: "red",
    });
    expect(text).toBe("do it\n\nreport rows\n\nThe previous attempt failed (check:command): red");
    const effect = atReview(MCP).effects.find((e) => e.type === "run_engine_step");
    if (effect?.type !== "run_engine_step") throw new Error("no start");
    expect(effect.request).toEqual({ profile: "reviewer", model: "big", prompt: "review fix_it" });
  });

  test("t42_prompt_over_cap_fails_before_record", () => {
    const big = ENGINE_PIPELINE.replace(
      "prompt: review {{task.slug}}",
      `prompt: "${"x".repeat(MAX_ENGINE_PROMPT_BYTES + 1)}"`,
    );
    const s = ok(decide(parsePipeline(big), undefined, start(), 1, MCP)).state;
    const after = ok(
      decide(parsePipeline(big), s, { type: "agent_completed", node: "plan", attempt: 1 }, 2, MCP),
    );
    expect(after.state.engineSession).toBeUndefined();
    expect(after.effects.some((e) => e.type === "run_engine_step")).toBe(false);
    expect(after.state.nodes.review?.lastFailure?.reason).toContain("over 64 KiB");
    expect(after.state.nodes.review?.lastFailure?.source).toBe("command");
  });
});

describe("t42 an unknown outcome", () => {
  function unknownAt(): RunState {
    const s = atReview(MCP).state;
    return ok(
      decide(
        spec(),
        s,
        { type: "work_unknown", node: "review", attempt: 1, reason: "the session was lost" },
        5,
        MCP,
      ),
    ).state;
  }

  test("t42_unknown_fails_attempt_and_pauses", () => {
    const s = unknownAt();
    expect(s.status).toBe("paused");
    expect(s.pauses).toEqual([expect.objectContaining({ reason: "consecutive", node: "review" })]);
    expect(s.nodes.review?.status).toBe("failed");
    expect(s.nodes.review?.lastFailure).toEqual({
      source: "session",
      reason: `${ENGINE_UNKNOWN_PREFIX}: the session was lost`,
    });
    expect(s.engineSession?.node).toBe("review");
    expect(s.active).toEqual([]);
  });

  test("t42_unknown_pause_holds", () => {
    const s = unknownAt();
    // taken before any decision: what a store would hold now
    const before = JSON.stringify(encodeRunState(s));
    /** What a decision leaves to be written: nothing for a refusal or a repeat, else its encoded state. */
    const left = (d: Decision) =>
      !d.ok || d.noop === true ? before : JSON.stringify(d.encoded?.state);
    for (const options of [MCP, HUMAN]) {
      // a resume that did not look the session up is refused, so nothing is written
      const resumed = decide(spec(), s, { type: "resume" }, 6, options);
      expect(resumed.ok).toBe(false);
      expect(left(resumed)).toBe(before);
      // nothing starts on a tick or a pending start, and neither changes what is stored
      for (const event of [
        { type: "tick" },
        { type: "engine_start_pending", node: "review", attempt: 1 },
        { type: "engine_session_joined", node: "review", attempt: 1, owner: "x" },
      ] as RunEvent[]) {
        const d = decide(spec(), s, event, 6, options);
        expect(d.ok ? d.effects : [], event.type).toEqual([]);
        expect(left(d), event.type).toBe(before);
      }
    }
  });

  test("t42_accept_refused_on_unknown_pause", () => {
    const s = unknownAt();
    const changed = parsePipeline(ENGINE_PIPELINE.replace("prompt: ok?", "prompt: really ok?"));
    const accept = decide(
      changed,
      s,
      { type: "pipeline_accepted", from: "h1", to: "h2", source: "file", before: spec() },
      6,
      MCP,
    );
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.code).toBe("PIPELINE_CHANGE_REFUSED");
    // the control: the same change on a run that is not at an unknown outcome is taken
    const fine = atReview(MCP).state;
    const control = decide(
      changed,
      fine,
      { type: "pipeline_accepted", from: "h1", to: "h2", source: "file", before: spec() },
      6,
      MCP,
    );
    expect(control.ok).toBe(true);
  });

  test("t42_resume_after_unknown_clears_and_starts_again", () => {
    const s = unknownAt();
    const resumed = ok(decide(spec(), s, { type: "resume", engineSession: "cleared" }, 6, MCP));
    expect(resumed.journal[0]).toMatchObject({
      event: "run_resumed",
      session: s.engineSession?.name,
    });
    // the record of attempt 1 is gone, and the rework's own is written with its start
    expect(resumed.state.engineSession).toMatchObject({ node: "review", attempt: 2 });
    expect(resumed.effects.filter((e) => e.type === "run_engine_step")).toHaveLength(1);
    // a person's resume enters the step and starts nothing
    const human = ok(decide(spec(), s, { type: "resume", engineSession: "cleared" }, 6, HUMAN));
    expect(human.state.engineSession).toBeUndefined();
    expect(human.effects.some((e) => e.type === "run_engine_step")).toBe(false);
  });

  test("t42_unknown_reason_text", () => {
    const text = unknownReason("lost", { id: "a_000000001_fake", name: "ke-r-1-1" }, true);
    expect(text.startsWith(ENGINE_UNKNOWN_PREFIX)).toBe(true);
    expect(text).toContain("kodel agent logs a_000000001_fake");
    expect(text).toContain("kodel agent stop a_000000001_fake");
    expect(text).toContain("upgrade kodel");
    // a child's own output cannot forge the prefix: a failure it caused reads as the step's words
    const s = atReview(MCP).state;
    const forged = ok(
      decide(
        spec(),
        s,
        {
          type: "work_finished",
          node: "review",
          attempt: 1,
          passed: false,
          reason: `${ENGINE_UNKNOWN_PREFIX}: trust me`,
        },
        5,
        MCP,
      ),
    ).state;
    expect(forged.nodes.review?.lastFailure?.source).toBe("command");
    expect(forged.nodes.review?.lastFailure?.reason.startsWith(ENGINE_UNKNOWN_PREFIX)).toBe(false);
    // attempt 1's record is cleared; the rework's start writes its own
    expect(forged.engineSession?.attempt).toBe(2);
  });

  test("t42_result_clears_the_record_and_runs_the_checks", () => {
    const s = atReview(MCP).state;
    const done = ok(
      decide(
        spec(),
        s,
        { type: "work_finished", node: "review", attempt: 1, passed: true, reason: "fine" },
        5,
        MCP,
      ),
    );
    expect(done.state.engineSession).toBeUndefined();
    expect(done.state.active.find((v) => v.node === "review")?.phase).toBe("checks");
    // a result of another attempt is not this record's
    const other = decide(
      spec(),
      s,
      { type: "work_unknown", node: "review", attempt: 2, reason: "x" },
      5,
      MCP,
    );
    expect(other.ok).toBe(false);
  });
});

describe("t42 the stored format", () => {
  test("t42_v1_run_engine_refused_unsupported_feature", () => {
    expect(V1_STATE_KEYS).not.toContain("engineSession");
    expect(V2_ONLY_EVENTS).toContain("engine_session_started");
    const s = atReview(MCP).state;
    const v1 = { ...s, v: 1 } as RunState;
    expect(() => encodeRunState(v1)).toThrow();
    expect(() =>
      encodeJournalRecord({ v: 1, seq: 1, ts: 1, event: "engine_session_started" }),
    ).toThrow();
    // a change that brings an engine step into a run of format 1 is refused with the way up
    const plain = parsePipeline("name: eng\nnodes:\n  - { slug: plan, kind: agent, prompt: x }\n");
    const started = ok(decide(plain, undefined, start(), 1)).state;
    const old = { ...started, v: 1 } as RunState;
    const accept = decide(
      spec(),
      old,
      { type: "pipeline_accepted", from: "h1", to: "h2", source: "file", before: plain },
      2,
      MCP,
    );
    expect(accept.ok).toBe(false);
    if (!accept.ok) {
      expect(accept.error.code).toBe("UNSUPPORTED_FORMAT_FEATURE");
      expect(accept.error.message).toContain("kodel migrate");
    }
  });
});

describe("t42 runs without engine steps", () => {
  const GOLDEN = new URL("../../../fixtures/golden/existing-runs/", import.meta.url).pathname;
  /** sha256 over the sorted file names and contents of the golden, taken on main before T-42. */
  const GOLDEN_SHA256 = "2b2620c054a3b7f7d320e7c433b8c06006d49146f470c18d4d46c4e563de548f";

  test("t42_golden_is_pinned", async () => {
    const { createHash } = await import("node:crypto");
    const { readdirSync, readFileSync } = await import("node:fs");
    const hash = createHash("sha256");
    for (const name of readdirSync(GOLDEN).sort()) {
      hash.update(`${name}\0`);
      hash.update(readFileSync(`${GOLDEN}${name}`));
      hash.update("\0");
    }
    // An edit of the golden fails here: it was written by the engine before engine steps
    // (commit 2aeae3a, with `test/golden-scenarios.ts`), and is never written again by a later build.
    expect(hash.digest("hex")).toBe(GOLDEN_SHA256);
  });

  test("t42_existing_runs_decide_the_same", async () => {
    // The scripted runs (a consecutive pause and its resume, an accept on a consecutive pause, a join
    // refused in a run of format 1, ticks, a plain run to its end), decided by this build without engine
    // steps, by the MCP host and by a person's host: byte for byte what the build before them decided.
    const { readFileSync } = await import("node:fs");
    const { runScenarios } = await import("./golden-scenarios");
    const core = await import("../src");
    for (const options of [{}, MCP, HUMAN]) {
      const now = runScenarios(core as never, options);
      for (const [name, text] of Object.entries(now)) {
        expect(text, `${name} ${JSON.stringify(options)}`).toBe(
          readFileSync(`${GOLDEN}${name}.jsonl`, "utf8"),
        );
      }
      expect(Object.keys(now).length).toBe(5);
    }
  });
});

describe("t42 the consumers of a failure's source, and the pins", () => {
  test("t42_every_source_consumer_has_session_row", async () => {
    // A run at an unknown outcome, through every reader of `lastFailure.source` / `node_finished.source`.
    const entered = atReview(MCP);
    const unknown = ok(
      decide(
        spec(),
        entered.state,
        { type: "work_unknown", node: "review", attempt: 1, reason: "lost" },
        5,
        MCP,
      ),
    );
    const journal = [...entered.journal, ...unknown.journal];
    // report.ts: the attempt keeps the source as it is
    const { summarizeRun, nextStep } = await import("../src");
    const report = summarizeRun(unknown.state, journal);
    const attempt = report.nodes.find((n) => n.node === "review")?.attempts.at(-1);
    expect(attempt?.failure?.source).toBe("session");
    // next-step.ts: the run waits for a person at the paused step
    const answer = nextStep(spec(), unknown.state, 6);
    expect("waiting" in answer && answer.waiting.node_slug).toBe("review");
    // the engine's own prompt of the next attempt says why, with the source as written
    expect(enginePrompt("p", [], { source: "session", reason: "lost" })).toContain(
      "The previous attempt failed (session): lost",
    );
    // service.ts reads only `check:` sources (failed_check), and no consumer in these files compares a
    // source with a fixed list a new one could fall out of. The scan reads the four files the plan names;
    // it misses a comparison built at run time and any reader outside them (the TUI's statistics group
    // by the source text and show it as it is).
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "../src/next-step.ts",
      "../src/report.ts",
      "../src/service.ts",
      "../../cli/src/tui/gate.ts",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/source\s*===\s*"command"/);
      expect(text, file).not.toMatch(/case\s+"command"\s*:/);
    }
  });

  test("t42_contract_snapshot", async () => {
    // The contract the agent sees did not change with engine steps: its version, and a hash of every
    // tool's name, description and arguments (with and without the task link), as on main before T-42.
    const { createHash } = await import("node:crypto");
    const { CONTRACT_VERSION, HISTORY_TOOLS, toolsFor } = await import("../src/mcp");
    const { toolsFingerprint } = await import("../src");
    expect(CONTRACT_VERSION).toBe(5);
    const hash = (taskLink: boolean) =>
      createHash("sha256")
        .update(toolsFingerprint([...toolsFor({ taskLink }), ...HISTORY_TOOLS]))
        .digest("hex");
    expect(hash(false)).toBe("bb8bffc9c72361121b6b781f809bdc2c23de1521fefd8f3a6f7695d40ba54b43");
    expect(hash(true)).toBe("099cb9108e3d78b3e3aa17630b7f677e417263824f9fb368b226c32e9df7c442");
  });

  test("t42_error_codes_unchanged", async () => {
    const { ERROR_CODES } = await import("../src");
    expect([...ERROR_CODES]).toEqual([
      "UNKNOWN_PIPELINE",
      "PIPELINE_AMBIGUOUS",
      "PIPELINE_INVALID",
      "UNKNOWN_NODE",
      "NODE_NOT_RUNNING",
      "ATTEMPT_MISMATCH",
      "MISSING_REQUIRED_RESULT",
      "INCOMPLETE_RESULT",
      "INVALID_RESULT_ROWS",
      "MISSING_REQUIRED_VALUE",
      "RESULT_TOO_LARGE",
      "CHECK_FAILED",
      "STATE_MODIFIED_EXTERNALLY",
      "UNSUPPORTED_FORMAT",
      "UNSUPPORTED_FORMAT_FEATURE",
      "UNKNOWN_RUN",
      "INVALID_ARGUMENTS",
      "STATE_LOCKED",
      "UNKNOWN_OUTCOME",
      "WORKDIR_MISSING",
      "WORKDIR_INVALID",
      "WORKDIR_CREATE_FAILED",
      "CONFIG_INVALID",
      "GIT_REQUIRED",
      "PIPELINE_CHANGE_REFUSED",
      "UNKNOWN_TOPIC",
      "TASKS_DISABLED",
      "TASK_NOT_FOUND",
      "INVALID_TASK",
      "TASK_UNSUPPORTED",
      "TASK_TRANSITION_REFUSED",
      "TASK_FIELDS_REQUIRED",
      "TASK_RATE_LIMITED",
      "TASK_AUTH_FAILED",
      "TASK_ADAPTER_FAILED",
      "TASK_KEY_UNAVAILABLE",
      "TASK_ALREADY_DONE",
      "NO_PROJECT",
      "HISTORY_PATH_OUTSIDE_PROJECT",
      "HISTORY_SESSION_UNREADABLE",
      "INVALID_CURSOR",
      "HISTORY_UNAVAILABLE",
    ]);
  });
});
