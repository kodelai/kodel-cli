import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli";

interface Call {
  url: string;
  init?: RequestInit;
}

const SENT = () => Response.json({ id: "fb_0123456789abcdef" }, { status: 201 });

async function cli(
  args: string[],
  respond: (call: Call) => Response = SENT,
  stdin = "",
  { interactive = false, answer = true } = {},
) {
  const calls: Call[] = [];
  let out = "";
  let err = "";
  const code = await runCli(args, {
    cwd: "/nonexistent",
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    interactive,
    environment: {},
    confirm: async () => answer,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    },
    readStdin: async () => stdin,
  });
  return { code, out, err, calls };
}

const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.init?.body));

describe("feedback", () => {
  test("a person is shown the text and the context and asked; yes sends it", async () => {
    const r = await cli(["feedback", "gate hangs"], SENT, "", { interactive: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://kodel.ai/api/feedback");
    expect(r.out).toContain("gate hangs");
    expect(r.out).toContain("kodelVersion");
    expect(r.out).toContain("sent: fb_0123456789abcdef");
    const body = bodyOf(r.calls[0]);
    expect(r.calls[0]?.url).toBe("https://kodel.ai/api/feedback");
    expect(body.type).toBe("feedback");
    expect(typeof body.context.kodelVersion).toBe("string");
  });

  test("a no from the person sends nothing", async () => {
    const r = await cli(["feedback", "x"], SENT, "", { interactive: true, answer: false });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });

  test("without a terminal and without --yes nothing is sent", async () => {
    const r = await cli(["feedback", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--yes");
    expect(r.calls).toEqual([]);
  });

  test("--yes sends without asking and still shows what was sent", async () => {
    const r = await cli(["feedback", "boom", "--type", "bug", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("boom");
    expect(bodyOf(r.calls[0]).type).toBe("bug");
  });

  test("--no-context leaves the context out", async () => {
    const r = await cli(["feedback", "boom", "--no-context", "--yes"]);
    expect(bodyOf(r.calls[0])).toEqual({ type: "feedback", message: "boom" });
  });

  test("- reads the text from stdin", async () => {
    const r = await cli(["feedback", "-", "--yes"], SENT, "  long text\n");
    expect(bodyOf(r.calls[0]).message).toBe("long text");
  });

  test("no text or a wrong type: nothing is sent", async () => {
    const none = await cli(["feedback", "--yes"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("a text is needed");
    const wrong = await cli(["feedback", "x", "--type", "nope", "--yes"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("--type is bug, feature or feedback");
    expect([...none.calls, ...wrong.calls]).toEqual([]);
  });

  test("the inbox cannot be redirected", async () => {
    const r = await cli(["feedback", "x", "--url", "http://evil", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
  });

  test("a refusal of the inbox is an error", async () => {
    const r = await cli(["feedback", "x", "--yes"], () =>
      Response.json({ error: "invalid_message" }, { status: 400 }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid_message");
  });
});
