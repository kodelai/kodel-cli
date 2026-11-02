import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHolder } from "../src/session-holder";
import { readStatus } from "../src/session-records";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kdjs-holder-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = (over: Record<string, unknown> = {}) => ({
  v: 1,
  dir,
  argv: ["sh", "-c", "exit 0"],
  cwd: dir,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  graceMs: 30_000,
  started: Date.now(),
  ...over,
});

const run = async (over: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const code = await runHolder({ input: base(over) as never, boot: (l) => lines.push(l) });
  return { code, lines };
};

describe("holder, run directly", () => {
  test("tA_input_version_mismatch_refused", async () => {
    const { code, lines } = await run({ v: 2 });
    expect(code).toBe(1);
    expect(lines[0]).toContain("version");
    expect(existsSync(join(dir, "status.json"))).toBe(false);
  });

  test("tA_holder_refuses_a_start_time_in_the_future", async () => {
    const { code, lines } = await run({ started: Date.now() + 60 * 60_000 });
    expect(code).toBe(1);
    expect(lines[0]).toContain("future");
  });

  test("tA_holder_refuses_a_late_start_and_creates_nothing", async () => {
    const { code, lines } = await run({ started: Date.now() - 60_000, graceMs: 1_000 });
    expect(code).toBe(1);
    expect(lines[0]).toContain("start_late");
    expect(existsSync(join(dir, "status.json"))).toBe(false);
  });

  test("tA_holder_forces_engine_mark", async () => {
    const { code } = await run({
      argv: ["sh", "-c", `echo "mark=$KODEL_ENGINE" > ${join(dir, "out.txt")}`],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", KODEL_ENGINE: "0" },
    });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "out.txt"), "utf8").trim()).toBe("mark=1");
  });

  test("tA_holder_rules_unknown_runs_no_child", async () => {
    const { code, lines } = await run({
      argv: ["sh", "-c", `touch ${join(dir, "ran")}`],
      rulesUnknown: true,
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("HOLDER_BOOT_FAILED");
    expect(existsSync(join(dir, "ran"))).toBe(false);
    const status = readStatus(dir);
    expect(status).toMatchObject({ state: "killed", reason: "rules_unknown" });
  });

  test("tA_holder_tail_is_redacted_with_project_rules", async () => {
    const { code } = await run({
      argv: ["sh", "-c", "echo see ZZSECRETZZ here"],
      rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }],
    });
    expect(code).toBe(0);
    const tail = readFileSync(join(dir, "tail.txt"), "utf8");
    expect(tail).toContain("[REDACTED:zz]");
    expect(tail).not.toContain("ZZSECRETZZ");
  });

  test("tA_holder_tail_cut_keeps_a_secret_at_the_cut_redacted", async () => {
    // 2 KiB of filler, then the secret, then filler: a tail of 1 KiB plus the margin is cut inside the filler
    const { code } = await run({
      argv: [
        "sh",
        "-c",
        "head -c 3000 /dev/zero | tr '\\0' x; echo ZZSECRETZZ; head -c 500 /dev/zero | tr '\\0' y",
      ],
      rules: [{ name: "zz", source: "ZZSECRETZZ", flags: "g" }],
      tailBytes: 1000,
    });
    expect(code).toBe(0);
    const tail = readFileSync(join(dir, "tail.txt"), "utf8");
    expect(tail).not.toContain("ZZSECRETZZ");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(1000);
  });

  test("tA_holder_fast_exit_child_is_recorded", async () => {
    for (let i = 0; i < 5; i++) {
      const { code } = await run({ argv: ["true"] });
      expect(code).toBe(0);
      expect(readStatus(dir)).toMatchObject({ state: "exited", exitCode: 0 });
      rmSync(join(dir, "status.json"));
    }
  });
});
