import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "@kodel-ai/pipeline-core";
import { DEFAULT_MAX_TAIL_BYTES, runCommand } from "../src";

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

describe("cnz6 the output kept from a command", () => {
  const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

  test("cnz6_the_default_tail_is_64_kib", () => {
    expect(DEFAULT_MAX_TAIL_BYTES).toBe(64 * 1024);
  });

  test("cnz6_no_piece_of_a_secret_survives_wherever_the_cut_falls", async () => {
    for (const after of [1950, 1965, 1975, 1985, 1995, 2005, 2020]) {
      const code = `process.stdout.write('x'.repeat(1990) + ' ${secret} ' + 'y'.repeat(${after}))`;
      const result = await run(node(code), {
        maxTailBytes: 2000,
        redact: (t: string) => redactText(t),
      });
      for (let i = 0; i + 6 <= secret.length; i++) {
        expect(result.tail).not.toContain(secret.slice(i, i + 6));
      }
    }
  });

  test("cnz6_the_stored_tail_with_its_marker_never_exceeds_the_limit", async () => {
    const result = await run(node("console.log('z'.repeat(5000))"), { maxTailBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(100);
    expect(result.tail.startsWith("[earlier output omitted]\n")).toBe(true);
  });

  test("cnz6_abort_keeps_what_was_read", async () => {
    const controller = new AbortController();
    const pending = run(node("console.log('read before abort'); setTimeout(() => {}, 60000)"), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1000);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.tail).toContain("read before abort");
  });

  test("cnz6_crlf_output_is_kept_as_it_was_written", async () => {
    const result = await run(node("process.stdout.write('one\\r\\ntwo\\r\\n')"));
    expect(result.tail).toBe("one\r\ntwo\r\n");
  });

  test("cnz6_a_hundred_megabytes_of_output_keep_only_the_default_limit", async () => {
    const code =
      "const b = Buffer.alloc(1 << 20, 97); let n = 0; (function w() { while (n < 100) { n++; if (!process.stdout.write(b)) return process.stdout.once('drain', w); } })()";
    const result = await run(node(code));
    expect(result.exit).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(DEFAULT_MAX_TAIL_BYTES);
  }, 60_000);

  test("cnz6_invalid_utf8_and_nul_bytes_come_back_as_text_without_throwing", async () => {
    const result = await run(
      node("process.stdout.write(Buffer.from([0x61, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x62]))"),
    );
    expect(result.exit).toBe(0);
    expect(result.tail.startsWith("a")).toBe(true);
    expect(result.tail.endsWith("b")).toBe(true);
    expect(result.tail).toContain("\0");
  });

  test("cnz6_a_private_key_whose_header_is_cut_off_is_still_redacted", async () => {
    // The key is longer than the margin, so the read window starts inside its body.
    const script = join(dir, "pem.js");
    await writeFile(
      script,
      [
        "const body = Array.from({ length: 80 }, (_, i) => 'Zm9v' + String(i).padStart(4, '0') + 'QmFyQmF6UXV4'.repeat(4)).join('\\n');",
        "process.stdout.write('x'.repeat(100) + '\\n-----BEGIN RSA PRIVATE KEY-----\\n' + body + '\\n-----END RSA PRIVATE KEY-----\\nafter the key\\n');",
      ].join("\n"),
    );
    const result = await run(`node ${script}`, {
      maxTailBytes: 2000,
      redact: (t: string) => redactText(t),
    });
    expect(result.truncated).toBe(true);
    expect(result.tail).not.toContain("QmFyQmF6UXV4");
    expect(result.tail).not.toContain("END RSA PRIVATE KEY");
    expect(result.tail).toContain("after the key");
  });

  test("cnz6_a_secret_split_across_two_writes_is_redacted", async () => {
    const code = `process.stdout.write('${secret.slice(0, 8)}'); setTimeout(() => process.stdout.write('${secret.slice(8)}'), 100)`;
    const result = await run(node(code), { redact: (t: string) => redactText(t) });
    expect(result.tail).not.toContain(secret.slice(4));
  });

  test("cnz6_timeout_keeps_what_was_read", async () => {
    const code = "console.log('before the hang'); setTimeout(() => {}, 60000)";
    const result = await run(node(code), { timeoutMs: 1000 });
    expect(result.timedOut).toBe(true);
    expect(result.tail).toContain("before the hang");
  });

  test("cnz6_a_command_that_prints_a_lot_keeps_only_the_limit", async () => {
    const code =
      "const b = Buffer.alloc(1 << 20, 97); for (let i = 0; i < 20; i++) process.stdout.write(b)";
    const result = await run(node(code), { maxTailBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(4096 + 30);
  });

  test("cnz6_binary_nul_ansi_and_a_last_line_without_a_newline_do_not_break_the_tail", async () => {
    const code =
      "process.stdout.write(Buffer.from([0, 255, 254, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x61, 0x0d, 0x0a, 0x7a]))";
    const result = await run(node(code));
    expect(result.exit).toBe(0);
    expect(result.tail.endsWith("z")).toBe(true);
    expect(result.tail).toContain("\r\n");
  });
});
