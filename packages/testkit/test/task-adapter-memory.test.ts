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
  [
    "no subtasks, no fields, runs only attachable, no comments",
    { capabilities: { subtasks: false, fields: false, runs: "attach", comment: "none" } },
  ],
];

for (const [name, options] of PROFILES) {
  describe(`task adapter conformance: the in-memory adapter, ${name}`, () => {
    for (const c of taskAdapterContract(() => ({ adapter: new MemoryTaskAdapter(options) }))) {
      test(c.name, c.run);
    }
  });
}
