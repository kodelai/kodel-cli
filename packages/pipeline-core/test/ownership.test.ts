import { describe, expect, test } from "bun:test";
import { decide, MAX_TAKEOVERS, parsePipeline, type RunEvent, type RunState } from "../src";

const spec = parsePipeline(
  [
    "name: p",
    "nodes:",
    "  - slug: build",
    "    kind: command",
    "    command: make",
    "  - slug: after",
    "    kind: command",
    "    command: make after",
    "edges:",
    "  - { from: build, to: after }",
    "  - { from: build, to: after, when: failed }",
    "  - { from: after, to: build, when: failed }",
    "",
  ].join("\n"),
);

function session() {
  let state: RunState | undefined;
  const log: string[] = [];
  const send = (now: number, event: RunEvent) => {
    const result = decide(spec, state, event, now);
    if (!result.ok) throw result.error;
    state = result.state;
    log.push(...result.journal.map((r) => `${r.event}:${JSON.stringify(r.reason ?? "")}`));
    return result;
  };
  send(0, { type: "start", runId: "r1", task: "t", specHash: "h" });
  return {
    send,
    log,
    get visit() {
      return (state as RunState).active[0];
    },
    get state() {
      return state as RunState;
    },
  };
}

const beat = (owner: string): RunEvent => ({ type: "heartbeat", node: "build", attempt: 1, owner });

describe("who may say that work is alive", () => {
  test("the first heartbeat names the owner, and the owner's heartbeats keep it alive", () => {
    const s = session();
    s.send(1_000, beat("a:1"));
    expect(s.visit?.owner).toBe("a:1");
    s.send(9_000, beat("a:1"));
    expect(s.visit?.heartbeatAt).toBe(9_000);
  });

  test("a process that is not the owner cannot take the work back with a late heartbeat", () => {
    const s = session();
    s.send(1_000, beat("a:1"));
    const late = s.send(20_000, beat("b:2"));
    expect(late.noop).toBe(true);
    expect(s.visit).toMatchObject({ owner: "a:1", heartbeatAt: 1_000 });
  });

  test("once the work was taken over, the new owner can claim it", () => {
    const s = session();
    s.send(1_000, beat("a:1"));
    s.send(2_000, { type: "tick", deadOwners: ["a:1"] });
    expect(s.visit?.owner).toBeUndefined();
    s.send(3_000, beat("b:2"));
    expect(s.visit?.owner).toBe("b:2");
    // and the old one cannot get it back
    expect(s.send(4_000, beat("a:1")).noop).toBe(true);
    expect(s.visit?.owner).toBe("b:2");
  });
});

describe("taking work over from a process that is gone, and from one that went silent", () => {
  test("work from a dead owner restarts at once, and says why", () => {
    const s = session();
    s.send(1_000, beat("a:1"));
    const taken = s.send(1_500, { type: "tick", deadOwners: ["a:1"] });
    expect(taken.effects.map((e) => e.type)).toEqual(["run_command"]);
    expect(s.log.some((l) => l.includes("node_restarted") && l.includes("is gone"))).toBe(true);
  });

  test("closing the agent again and again is not a crash: takeovers are counted apart", () => {
    const s = session();
    for (let i = 1; i <= MAX_TAKEOVERS; i++) {
      s.send(i * 1_000, beat(`a:${i}`));
      s.send(i * 1_000 + 500, { type: "tick", deadOwners: [`a:${i}`] });
    }
    expect(s.state.status).toBe("running");
    expect(s.visit).toMatchObject({ restarts: 0, takeovers: MAX_TAKEOVERS });
  });

  test("but it cannot go on for ever: one more takeover pauses the run for a person", () => {
    const s = session();
    for (let i = 1; i <= MAX_TAKEOVERS + 1; i++) {
      s.send(i * 1_000, beat(`a:${i}`));
      s.send(i * 1_000 + 500, { type: "tick", deadOwners: [`a:${i}`] });
    }
    expect(s.state.status).toBe("paused");
    expect(s.state.pause?.reason).toBe("restarts");
  });

  test("work that merely went silent still counts against the usual limit of restarts", () => {
    const s = session();
    s.send(1_000, beat("a:1"));
    let now = 1_000;
    for (let i = 0; i < 3; i++) {
      now += 31_000; // longer than the heartbeat may be silent
      s.send(now, { type: "tick" });
    }
    expect(s.state.status).toBe("running");
    expect(s.visit?.restarts).toBe(3);
    s.send(now + 31_000, { type: "tick" });
    expect(s.state.status).toBe("paused");
  });
});
