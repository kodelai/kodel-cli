import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { descendantsOf, liveProcess, processIdentity, sameIdentity } from "../src/process-table";

// A sandbox may forbid `ps`; then these tests are skipped, visibly, unless the job requires the table.
const tableAvailable = processIdentity(process.pid) !== undefined;
const skipTable = !tableAvailable && process.env.KODEL_REQUIRE_PROCTABLE !== "1";
const tableTest = test.skipIf(skipTable);

describe("process table", () => {
  tableTest("tA_identity_of_self_is_stable_and_comparable", () => {
    const a = processIdentity(process.pid);
    const b = processIdentity(process.pid);
    expect(a).toBeDefined();
    if (a && b) expect(sameIdentity(a, b)).toBe(true);
  });

  test("tA_identity_methods_never_compare", () => {
    expect(
      sameIdentity({ method: "proc-ticks", value: "1" }, { method: "ps-lstart", value: "1" }),
    ).toBeUndefined();
    expect(
      sameIdentity(
        { method: "proc-ticks", value: "1", boot: "a" },
        { method: "proc-ticks", value: "1", boot: "b" },
      ),
    ).toBe(false);
  });

  test("tA_live_process_and_a_gone_pid", () => {
    expect(liveProcess(process.pid)).toBe(true);
    expect(liveProcess(0)).toBe(false);
    expect(liveProcess(-5)).toBe(false);
    expect(liveProcess(2 ** 22 + 12345)).toBe(false);
  });

  tableTest("tA_descendants_find_a_grandchild_in_another_group", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const found = descendantsOf(child.pid as number);
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const pid of found) process.kill(pid, "SIGKILL");
    child.kill("SIGKILL");
  });
});
