/**
 * Claude Code logs built line by line, for tests that need a session of their own shape: a run id in a tool call,
 * a response left open, a repeat after a resume. The lines have the fields the reader looks at and the shape of
 * the real ones (see `fixtures/history/claude-code`); everything else a real line carries is left out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeFolderName } from "./history-fixtures";

type Json = Record<string, unknown>;

export interface ClaudeLogOptions {
  sessionId: string;
  cwd: string;
  version?: string;
  gitBranch?: string;
  /** The time of the first line; each next line is 100 ms later unless it says otherwise. */
  start?: string;
}

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export class ClaudeLogBuilder {
  readonly lines: string[] = [];
  private clock: number;
  private n = 0;

  constructor(private readonly options: ClaudeLogOptions) {
    this.clock = Date.parse(options.start ?? "2026-10-21T10:00:00.000Z");
  }

  private stamp(): string {
    this.clock += 100;
    return new Date(this.clock).toISOString();
  }

  /** Move the clock on, so that the next line is `ms` later than the one before. */
  wait(ms: number): this {
    this.clock += ms;
    return this;
  }

  private entry(type: string, extra: Json): this {
    this.n += 1;
    this.lines.push(
      JSON.stringify({
        sessionId: this.options.sessionId,
        cwd: this.options.cwd,
        gitBranch: this.options.gitBranch ?? "main",
        version: this.options.version ?? "2.1.306",
        uuid: `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`,
        type,
        timestamp: this.stamp(),
        ...extra,
      }),
    );
    return this;
  }

  user(text: string): this {
    return this.entry("user", { message: { role: "user", content: text } });
  }

  /** One line of an assistant response: the response is the lines that share `messageId`. */
  assistant(messageId: string, block: Json, usage: { input?: number; output?: number } = {}): this {
    return this.entry("assistant", {
      requestId: `req_${messageId}`,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [block],
        usage: { input_tokens: usage.input ?? 1, output_tokens: usage.output ?? 1 },
      },
    });
  }

  say(messageId: string, text: string): this {
    return this.assistant(messageId, { type: "text", text });
  }

  call(messageId: string, tool: ToolUse): this {
    return this.assistant(messageId, {
      type: "tool_use",
      id: tool.id,
      name: tool.name,
      input: tool.input,
    });
  }

  result(toolUseId: string, content: unknown, error = false): this {
    return this.entry("user", {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
            ...(error ? { is_error: true } : {}),
          },
        ],
      },
    });
  }

  /** A result that names a subagent log, like the answer to an `Agent` call. */
  subagentResult(toolUseId: string, agentId: string, content = "done"): this {
    return this.entry("user", {
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
      },
      toolUseResult: { agentId, description: "a subagent" },
    });
  }

  system(subtype: string, content?: string): this {
    return this.entry("system", { subtype, ...(content === undefined ? {} : { content }) });
  }

  /** The offset at which line `index` starts, for tests that read from a window start. */
  offsetOf(index: number): number {
    return this.lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  }

  text(): string {
    return this.lines.map((line) => `${line}\n`).join("");
  }

  /** Writes the log where Claude Code keeps it for `cwd`; returns the path. */
  async install(configDir: string, folder?: string): Promise<string> {
    const path = join(
      configDir,
      "projects",
      folder ?? claudeFolderName(this.options.cwd),
      `${this.options.sessionId}.jsonl`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, this.text());
    return path;
  }
}
