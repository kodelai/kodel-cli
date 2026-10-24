/**
 * The conformance suite of the history collector contract. `agentHistoryContract(make)` returns the cases as
 * plain data (`{ name, run }`, a case fails by throwing), like `taskAdapterContract`: every collector must
 * pass all of them, the Claude Code one and the author of a new agent's collector alike.
 *
 * The subject brings a Kodel project with sessions of its agent in it, and the refs the suite cannot make up
 * itself because they depend on the agent's files.
 */
import {
  type AgentHistoryCollector,
  checkProfiles,
  type HistoryEvent,
  historyEventSchema,
  KodelError,
  newReadStats,
  type SessionRef,
} from "@kodel-ai/pipeline-core";
import type { ContractCase } from "./task-adapter-contract";

export interface HistorySubject {
  collector: AgentHistoryCollector;
  /** A Kodel project with at least one session of this agent that has tool calls and usage in it. */
  projectRoot: string;
  /** Another Kodel project next to the first, with sessions of this agent: `locate` must not return them. */
  otherProjectRoot?: string;
  /** A directory that is not a Kodel project (no marker) but holds sessions of this agent: nothing of it is read. */
  notAProject?: string;
  /** A ref to a session of another project (or a file outside every project): `read` must refuse it. */
  foreignRef: SessionRef;
  /** A ref to a session log whose last line is torn, with the number of events before the tear. */
  torn?: { ref: SessionRef; events: number };
  dispose?: () => Promise<void> | void;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

async function collect(
  source: AsyncIterable<HistoryEvent>,
  limit = 1_000_000,
): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  for await (const event of source) {
    events.push(event);
    assert(events.length <= limit, "a session produced an unbounded number of events");
  }
  return events;
}

export function agentHistoryContract(
  make: () => Promise<HistorySubject> | HistorySubject,
): ContractCase[] {
  const cases: ContractCase[] = [];
  const add = (name: string, body: (subject: HistorySubject) => Promise<void>): void => {
    cases.push({
      name,
      async run() {
        const subject = await make();
        try {
          await body(subject);
        } finally {
          await subject.dispose?.();
        }
      },
    });
  };
  const sessions = async (s: HistorySubject): Promise<SessionRef[]> => {
    const refs = await s.collector.locate(s.projectRoot);
    assert(refs.length > 0, "locate found no sessions in the subject's project");
    return refs;
  };

  add("profiles are declared, ordered and do not overlap", async ({ collector }) => {
    assert(collector.agent.length > 0, "the collector has no agent id");
    const problems = checkProfiles(collector.profiles);
    assert(problems.length === 0, `profiles: ${problems.join("; ")}`);
  });

  add("locate returns refs of this agent and project, parents before subagents", async (s) => {
    const refs = await sessions(s);
    const seen = new Set<string>();
    for (const ref of refs) {
      assert(ref.agent === s.collector.agent, `a ref of agent ${ref.agent}`);
      assert(ref.project_root === s.projectRoot, "a ref names another project root");
      assert(!seen.has(ref.session_id), `session ${ref.session_id} is listed twice`);
      if (ref.parent_session_id !== undefined) {
        assert(seen.has(ref.parent_session_id), `${ref.session_id} comes before its parent`);
      }
      seen.add(ref.session_id);
    }
  });

  add("locate of a project does not return the sessions of the project next to it", async (s) => {
    if (s.otherProjectRoot === undefined) return;
    const mine = new Set((await s.collector.locate(s.projectRoot)).map((r) => r.path));
    const theirs = await s.collector.locate(s.otherProjectRoot);
    assert(theirs.length > 0, "the other project has no sessions, so this case proves nothing");
    for (const ref of theirs) {
      assert(ref.project_root === s.otherProjectRoot, "a ref names the wrong project");
      assert(!mine.has(ref.path), `${ref.session_id} is listed for both projects`);
    }
  });

  add("a directory that is not a Kodel project has no sessions and cannot be read", async (s) => {
    if (s.notAProject === undefined) return;
    assert(
      (await s.collector.locate(s.notAProject)).length === 0,
      "locate returned sessions for a directory without the Kodel marker",
    );
    const [ref] = await s.collector.locate(s.projectRoot);
    assert(ref !== undefined, "no session to build a ref from");
    try {
      await collect(s.collector.read({ ...ref, project_root: s.notAProject }));
    } catch (error) {
      assert(
        error instanceof KodelError && error.code === "HISTORY_PATH_OUTSIDE_PROJECT",
        `refused with ${String(error)}`,
      );
      return;
    }
    throw new Error("conformance: a session of a directory without the Kodel marker was read");
  });

  add("every event is valid, from this agent, and numbered from 1 without gaps", async (s) => {
    for (const ref of await sessions(s)) {
      const events = await collect(s.collector.read(ref));
      events.forEach((event, i) => {
        const parsed = historyEventSchema.safeParse(event);
        assert(
          parsed.success,
          `event ${i + 1} of ${ref.session_id} is invalid: ${JSON.stringify(event)}`,
        );
        assert(event.agent === s.collector.agent, "an event of another agent");
        assert(event.session_id === ref.session_id, "an event of another session");
        assert(event.seq === i + 1, `seq ${event.seq} at position ${i + 1}`);
        if (ref.parent_session_id !== undefined) {
          assert(
            event.parent_session_id === ref.parent_session_id,
            "a subagent event without its parent",
          );
        }
      });
    }
  });

  add("time does not go back inside a session", async (s) => {
    for (const ref of await sessions(s)) {
      let last = "";
      for (const event of await collect(s.collector.read(ref))) {
        assert(event.ts >= last, `ts ${event.ts} after ${last} in ${ref.session_id}`);
        last = event.ts;
      }
    }
  });

  add("a second read gives the same events", async (s) => {
    for (const ref of await sessions(s)) {
      const a = await collect(s.collector.read(ref));
      const b = await collect(s.collector.read(ref));
      assert(JSON.stringify(a) === JSON.stringify(b), `${ref.session_id} reads differently twice`);
    }
  });

  add("one usage event per message", async (s) => {
    let usages = 0;
    for (const ref of await sessions(s)) {
      const seen = new Set<string>();
      for (const event of await collect(s.collector.read(ref))) {
        if (event.kind !== "usage") continue;
        usages += 1;
        const key = `${event.message_id}|${event.request_id ?? ""}`;
        assert(!seen.has(key), `usage of ${key} is reported twice`);
        seen.add(key);
      }
    }
    assert(usages > 0, "the subject has no usage events, so this case proves nothing");
  });

  add("a tool result follows its tool call", async (s) => {
    let results = 0;
    for (const ref of await sessions(s)) {
      const calls = new Map<string, string>();
      for (const event of await collect(s.collector.read(ref))) {
        if (event.kind === "tool_call") calls.set(event.id, event.started);
        if (event.kind !== "tool_result") continue;
        results += 1;
        const started = calls.get(event.id);
        assert(started !== undefined, `result ${event.id} has no earlier call`);
        assert(event.ended >= started, `result ${event.id} ends before it starts`);
        if (event.duration_ms !== undefined) {
          assert(
            event.duration_ms === Date.parse(event.ended) - Date.parse(started),
            `duration of ${event.id} does not match its timestamps`,
          );
        }
      }
    }
    assert(results > 0, "the subject has no tool results, so this case proves nothing");
  });

  add("a window returns the same events as the full read, cut", async (s) => {
    const ref = (await sessions(s)).find((r) => r.parent_session_id === undefined);
    assert(ref !== undefined, "no main session");
    const all = await collect(s.collector.read(ref));
    assert(all.length >= 4, "the subject's first session is too short for a window");
    const mid = all[Math.floor(all.length / 2)];
    assert(mid !== undefined, "no middle event");
    const tail = await collect(s.collector.read(ref, { seq_from: mid.seq }));
    assert(
      JSON.stringify(tail) === JSON.stringify(all.filter((e) => e.seq >= mid.seq)),
      "seq_from cuts differently from filtering",
    );
    const timed = await collect(s.collector.read(ref, { from: mid.ts, to: mid.ts }));
    assert(
      JSON.stringify(timed) === JSON.stringify(all.filter((e) => e.ts === mid.ts)),
      "from/to cut differently from filtering",
    );
  });

  add("reading fills the stats", async (s) => {
    const ref = (await sessions(s))[0];
    assert(ref !== undefined, "no session");
    const stats = newReadStats();
    await collect(s.collector.read(ref, undefined, { stats }));
    assert(stats.lines > 0, "no lines counted");
    assert(Object.keys(stats.profiles).length > 0, "no profile counted");
  });

  add("a session outside the project is refused, not read", async (s) => {
    try {
      await collect(s.collector.read(s.foreignRef));
    } catch (error) {
      assert(
        error instanceof KodelError,
        `refused with something that is not a KodelError: ${String(error)}`,
      );
      assert(
        error.code === "HISTORY_PATH_OUTSIDE_PROJECT" ||
          error.code === "HISTORY_SESSION_UNREADABLE",
        `refused with ${error.code}`,
      );
      return;
    }
    throw new Error("conformance: a session outside the project was read");
  });

  add("a torn last line is not an error", async (s) => {
    if (s.torn === undefined) return;
    const events = await collect(s.collector.read(s.torn.ref));
    assert(events.length === s.torn.events, `${events.length} events, expected ${s.torn.events}`);
  });

  return cases;
}
