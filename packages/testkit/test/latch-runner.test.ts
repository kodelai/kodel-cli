import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@kodel-ai/local";
import { createLatchRunner, latchKeyOf } from "../src";

const context = (node: string, attempt = 1, check?: number): CommandContext => ({
  runId: "r",
  node,
  attempt,
  source: check === undefined ? "node" : "check",
  ...(check === undefined ? {} : { checkIndex: check }),
  restart: false,
});

describe("t40 the latch runner of the testkit", () => {
  test("t40_latch_runner_releases_at_once_on_an_aborted_signal", async () => {
    const latch = createLatchRunner();
    const controller = new AbortController();
    controller.abort();
    const options = { cwd: ".", signal: controller.signal } as Parameters<typeof latch.runner>[1];
    expect(await latch.runner("a", options, context("a"))).toMatchObject({
      exit: 137,
      aborted: true,
    });
    expect(latch.running()).toEqual([]);
  });

  test("t40_testkit_latch_runner_blocks_until_released", async () => {
    const latch = createLatchRunner();
    const options = { cwd: ".", signal: new AbortController().signal } as Parameters<
      typeof latch.runner
    >[1];
    let aDone = false;
    let bDone = false;
    const a = latch.runner("a", options, context("a")).then((r) => {
      aDone = true;
      return r;
    });
    const b = latch.runner("b", options, context("b")).then((r) => {
      bDone = true;
      return r;
    });
    await latch.started("a#1");
    await latch.started("b#1");
    expect(latch.running()).toEqual(["a#1", "b#1"]);
    // Nothing ends by itself: the self-test that a race test can fail.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([aDone, bDone]).toEqual([false, false]);
    // Released in the order the test wants, with the exit code it wants.
    latch.release("b#1", 2, "boom");
    expect(await b).toMatchObject({ exit: 2, tail: "boom", aborted: false });
    expect(aDone).toBe(false);
    expect(latch.running()).toEqual(["a#1"]);
    latch.release("a#1");
    expect(await a).toMatchObject({ exit: 0 });
    expect(latch.running()).toEqual([]);
    expect(latch.seen()).toEqual(["a#1", "b#1"]);
  });

  test("t40_testkit_latch_runner_release_before_start_and_abort", async () => {
    const latch = createLatchRunner();
    // A command released before it starts ends as soon as it starts.
    latch.release("a#1", 3);
    const controller = new AbortController();
    const options = { cwd: ".", signal: controller.signal } as Parameters<typeof latch.runner>[1];
    expect(await latch.runner("a", options, context("a"))).toMatchObject({ exit: 3 });
    // An aborted command ends like a killed process, whatever the latch.
    const b = latch.runner("b", options, context("b"));
    await latch.started("b#1");
    controller.abort();
    expect(await b).toMatchObject({ exit: 137, aborted: true });
    // A check of a node has a key of its own.
    expect(latchKeyOf(context("a", 2, 1))).toBe("a#2#check1");
  });
});
