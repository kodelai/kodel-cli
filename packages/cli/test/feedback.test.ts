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
  environment: Record<string, string> = {},
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
    interactive: false,
    environment,
    confirm: async () => true,
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
  test("a bug is posted with the type, the message and the context", async () => {
    const r = await cli(["feedback", "bug", "gate hangs"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sent: fb_0123456789abcdef");
    expect(r.calls[0]?.url).toBe("https://kodel.ai/api/feedback");
    const body = bodyOf(r.calls[0]);
    expect(body.type).toBe("bug");
    expect(body.message).toBe("gate hangs");
    expect(typeof body.context.kodelVersion).toBe("string");
  });

  test("--no-context leaves the context out; note is the type feedback", async () => {
    const r = await cli(["feedback", "note", "nice", "--no-context"]);
    expect(bodyOf(r.calls[0])).toEqual({ type: "feedback", message: "nice" });
  });

  test("- reads the message from stdin, and --url beats the environment", async () => {
    const r = await cli(
      ["feedback", "feature", "-", "--url", "http://localhost:1/"],
      SENT,
      "  long text\n",
      { KODEL_FEEDBACK_URL: "http://elsewhere" },
    );
    expect(r.calls[0]?.url).toBe("http://localhost:1/api/feedback");
    expect(bodyOf(r.calls[0]).message).toBe("long text");
  });

  test("no message: nothing is sent", async () => {
    const r = await cli(["feedback", "bug"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("a message is needed");
    expect(r.calls).toEqual([]);
  });

  test("send checks --type; a refusal of the inbox is an error", async () => {
    expect((await cli(["feedback", "send", "x", "--type", "nope"])).code).toBe(1);
    const r = await cli(["feedback", "bug", "x"], () =>
      Response.json({ error: "invalid_message" }, { status: 400 }),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid_message");
  });

  test("get shows the status and the answer; an unknown id is an error", async () => {
    const r = await cli(["feedback", "get", "fb_1"], () =>
      Response.json({
        id: "fb_1",
        type: "bug",
        message: "boom",
        status: "done",
        comment: "fixed",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(r.out).toContain("fb_1: bug, done");
    expect(r.out).toContain("answer: fixed");
    const missing = await cli(
      ["feedback", "get", "fb_2"],
      () => new Response("{}", { status: 404 }),
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no feedback fb_2");
  });
});
