/**
 * The precedence of stop records on the three fake session adapters, as the real `writeStop` has it: a person's
 * record is never replaced, and a person's stop replaces what a `finish` left of an ended session.
 */
import { describe, expect, test } from "bun:test";
import type { SessionAdapter, SessionSpec } from "@kodel-ai/pipeline-core";
import { ScriptedSessionAdapter } from "../../testkit/src/engine-fakes";
import { FakeSessionAdapter } from "../../testkit/src/session-fake";
import { FakeSessions } from "./fake-sessions";

const spec: SessionSpec = { argv: ["fake", "exit", "0"], cwd: "/" };

const subjects: [string, () => Promise<{ adapter: SessionAdapter; id: string }>][] = [
  [
    "FakeSessionAdapter",
    async () => {
      const adapter = new FakeSessionAdapter();
      return { adapter, id: (await adapter.start(spec)).id };
    },
  ],
  [
    "ScriptedSessionAdapter",
    async () => {
      const adapter = new ScriptedSessionAdapter();
      const { id } = await adapter.start(spec);
      adapter.finish(id, { state: "exited", exitCode: 0 });
      return { adapter, id };
    },
  ],
  [
    "FakeSessions",
    async () => {
      const adapter = new FakeSessions();
      return { adapter, id: adapter.add({ id: "a_000000001_abcd" }).id };
    },
  ],
];

describe("stop records of the fake adapters", () => {
  for (const [name, make] of subjects) {
    test(`mstart_stop_record_precedence (${name})`, async () => {
      const { adapter, id } = await make();
      // A `finish` leaves its record on an ended session; a person's stop replaces it.
      expect((await adapter.stop(id, { by: "finish", via: "manager" })).stoppedBy).toBe("finish");
      const person = await adapter.stop(id, { by: "person", via: "manager" });
      expect(person.stoppedBy).toBe("person");
      expect(person.stoppedVia).toBe("manager");
      // A person's record is never replaced.
      expect((await adapter.stop(id, { by: "finish", via: "manager" })).stoppedBy).toBe("person");
      expect((await adapter.stop(id, { by: "person", via: "manager" })).stoppedBy).toBe("person");
    });
  }
});
