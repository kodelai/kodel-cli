import { describe, test } from "bun:test";
import { MemoryTaskAdapter, type MemoryTaskOptions, taskAdapterContract } from "../src";

const PROFILES: [string, MemoryTaskOptions][] = [
  ["full capabilities", {}],
  [
    "a workflow that forbids some moves",
    {
      workflow: { Backlog: ["In Progress"], "In Progress": ["Backlog", "Done"], Done: ["Backlog"] },
    },
  ],
  ["a tracker without priorities", { capabilities: { priority: false } }],
  ["a tracker without links", { capabilities: { links: false } }],
  [
    "no subtasks, no fields, runs only attachable, no comments",
    { capabilities: { subtasks: false, fields: false, runs: "attach", comment: "none" } },
  ],
];

for (const [name, options] of PROFILES) {
  describe(`task adapter conformance: the in-memory adapter, ${name}`, () => {
    for (const c of taskAdapterContract(() => {
      let now = Date.UTC(2026, 0, 1);
      let moving = true;
      const clock = () => {
        if (moving) now += 1000;
        return now;
      };
      return {
        adapter: new MemoryTaskAdapter({ ...options, clock }),
        unknownKey: "MEM-999",
        stopClock: () => {
          moving = false;
        },
      };
    })) {
      test(c.name, c.run);
    }
  });
}
