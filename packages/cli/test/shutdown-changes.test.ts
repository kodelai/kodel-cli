import { describe, expect, test } from "bun:test";
import type { PipelineHost } from "@kodel-ai/pipeline-core";
import { type StoppableHost, stopAndWait } from "../src/mcp-server";

// Tests of TASK-36TW: leaving the server does not cut off the record of the changes of a run.

const base = {} as unknown as PipelineHost;

describe("leaving the server", () => {
  test("t36tw_mcp_shutdown_settles_end_patch", async () => {
    let written = false;
    const host: StoppableHost = {
      ...base,
      stop: () => 0,
      settle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        written = true;
      },
    };
    await stopAndWait(host);
    expect(written).toBe(true);
  });

  test("t36tw_mcp_shutdown_exits_when_end_patch_hangs", async () => {
    const host: StoppableHost = {
      ...base,
      stop: () => 0,
      settle: () => new Promise<void>(() => undefined),
    };
    const started = Date.now();
    await stopAndWait(host, 50);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("t36tw_mcp_shutdown_without_settle_is_as_before", async () => {
    await stopAndWait({ ...base, stop: () => 0 });
  });
});
