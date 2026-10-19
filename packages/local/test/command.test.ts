import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@kodel-ai/pipeline-core";
import { runCommand } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-cmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const node = (code: string) => `node -e "${code}"`;
const run = (command: string, over: Record<string, unknown> = {}) =>
  runCommand(command, { cwd: dir, ...over });

describe("running a command", () => {
  test("a command that succeeds: exit 0 and its output", async () => {
    const result = await run(node("console.log('hello from the command')"));
    expect(result).toMatchObject({ exit: 0, timedOut: false, aborted: false, truncated: false });
    expect(result.tail).toContain("hello from the command");
  });

  test("a failing exit code is passed on", async () => {
    expect((await run(node("process.exit(3)"))).exit).toBe(3);
  });

  test("stdout and stderr end up in the same tail, in order", async () => {
    const result = await run(node("console.log('out'); console.error('err')"));
    expect(result.tail).toContain("out");
    expect(result.tail).toContain("err");
  });

  test("the command runs in the given directory", async () => {
    const result = await run(node("console.log(process.cwd())"));
    expect(result.tail.trim().toLowerCase()).toContain(dir.toLowerCase().replace(/^\/private/, ""));
  });

  test("extra environment variables are visible, and unset ones are not", async () => {
    const result = await run(node("console.log('v=' + process.env.KODEL_TEST_VAR)"), {
      env: { KODEL_TEST_VAR: "yes" },
    });
    expect(result.tail).toContain("v=yes");
  });

  test("stdin is closed, so a command that reads it does not hang", async () => {
    const result = await run(
      node("process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"),
      { timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.tail).toContain("eof");
  });

  test("a command that does not exist fails without throwing", async () => {
    const result = await run("kodel-no-such-command-xyz");
    expect(result.exit).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the duration is measured", async () => {
    const result = await run(node("setTimeout(() => {}, 150)"));
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });
});

describe("timeout and abort", () => {
  test("a command that runs too long is killed and reported as timed out", async () => {
    const result = await run(node("setTimeout(() => {}, 60000)"), { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exit).not.toBe(0);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  test.skipIf(process.platform === "win32")(
    "the whole process tree is killed, not only the shell",
    async () => {
      const pidFile = join(dir, "child.pid");
      const code =
        "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
        `require('fs').writeFileSync('${pidFile.replace(/\\/g, "/")}', String(c.pid));` +
        "setTimeout(() => {}, 60000)";
      const result = await run(node(code), { timeoutMs: 800 });
      expect(result.timedOut).toBe(true);
      const pid = Number(await readFile(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
  );

  test("an abort signal stops the command", async () => {
    const controller = new AbortController();
    const pending = run(node("setTimeout(() => {}, 60000)"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("a signal that is already aborted never lets the command run on", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run(node("setTimeout(() => {}, 60000)"), { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  });
});

describe("output", () => {
  test("only the end of long output is kept, and that is said", async () => {
    const result = await run(node("for (let i = 0; i < 20000; i++) console.log('line ' + i)"), {
      maxTailBytes: 2000,
    });
    expect(result.exit).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.tail.startsWith("[earlier output omitted]")).toBe(true);
    expect(result.tail).toContain("line 19999");
    expect(result.tail).not.toContain("line 0\n");
    expect(Buffer.byteLength(result.tail)).toBeLessThan(2200);
  });

  test("short output is not marked as truncated", async () => {
    const result = await run(node("console.log('short')"), { maxTailBytes: 2000 });
    expect(result.truncated).toBe(false);
    expect(result.tail).not.toContain("omitted");
  });

  test("a secret in the output is redacted before it is returned", async () => {
    const key = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const result = await run(node(`console.log('using ${key}')`), {
      redact: (t: string) => redactText(t),
    });
    expect(result.tail).not.toContain(key);
    expect(result.tail).toContain("[REDACTED:aws-key]");
  });

  test("output split in the middle of a multi-byte character does not leave garbage at the start", async () => {
    const result = await run(node("console.log('я'.repeat(3000))"), { maxTailBytes: 1001 });
    expect(result.tail.replace("[earlier output omitted]\n", "").startsWith("�")).toBe(false);
  });
});
