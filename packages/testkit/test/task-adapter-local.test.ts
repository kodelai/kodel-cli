import { describe, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTaskAdapter } from "@kodel-ai/local";
import { taskAdapterContract } from "../src";

/** A small seeded generator: the keys of a run are the same every time. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("task adapter conformance: the local adapter, on real files", () => {
  for (const c of taskAdapterContract(async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "kodel-tasks-"));
    let now = Date.UTC(2026, 9, 22);
    const adapter = new LocalTaskAdapter({
      storeRoot,
      prefix: "KDL",
      clock: () => {
        now += 1000;
        return now;
      },
      random: seeded(7),
    });
    return { adapter, dispose: () => rm(storeRoot, { recursive: true, force: true }) };
  })) {
    test(c.name, c.run);
  }
});
