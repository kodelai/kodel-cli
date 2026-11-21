import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { NOT_A_SIGN_OF_LIFE, type ServeRules } from "@kodel-ai/pipeline-core/serve";
import type { z } from "zod";
import {
  CONFIG_FILE,
  DEFAULT_SERVE,
  loadConfig,
  type serveRulesOf,
  type serveSchema,
} from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kodel-config-serve-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string) => writeFile(join(dir, CONFIG_FILE), text);
const refusal = async (text: string): Promise<KodelError> => {
  await write(text);
  const error = await loadConfig(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(KodelError);
  return error as KodelError;
};

// The zod shape with its defaults is the core type: a key added to one and not the other fails to compile.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _shapeIsTheCoreType: Same<ReturnType<typeof serveRulesOf>, ServeRules> = true;
const _inputKeys: Same<keyof z.infer<typeof serveSchema>, keyof ServeRules> = true;

describe("the serve block of the config (T-44)", () => {
  test("t44_serve_block_defaults_and_strict_keys", async () => {
    expect((await loadConfig(dir)).serve).toEqual({
      enabled: false,
      max_workers: 1,
      max_runs: 1,
      stalled_after_s: 1800,
      start: [],
    });
    expect(DEFAULT_SERVE).toEqual((await loadConfig(dir)).serve);
    await write("version: 1\n");
    expect((await loadConfig(dir)).serve).toEqual(DEFAULT_SERVE);

    await write(
      [
        "serve:",
        "  enabled: true",
        "  max_workers: 2",
        "  max_runs: 4",
        "  stalled_after_s: 0",
        "  start:",
        "    - pipeline: dev",
        "      match:",
        "        status: [todo]",
        "        priority: [urgent, high]",
        "        parent: TASK-AB12",
        "    - pipeline: triage",
        "      match:",
        "        approval: any",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(dir)).serve).toEqual({
      enabled: true,
      max_workers: 2,
      max_runs: 4,
      stalled_after_s: 0,
      start: [
        {
          pipeline: "dev",
          match: {
            status: ["todo"],
            priority: ["urgent", "high"],
            parent: "TASK-AB12",
            approval: "required",
          },
        },
        { pipeline: "triage", match: { approval: "any" } },
      ],
    });
    // An empty match is every `todo` task that needs no approval.
    await write("serve:\n  start:\n    - pipeline: dev\n");
    expect((await loadConfig(dir)).serve.start).toEqual([
      { pipeline: "dev", match: { approval: "required" } },
    ]);
    // An empty list starts nothing, as no list does.
    await write("serve:\n  start: []\n");
    expect((await loadConfig(dir)).serve.start).toEqual([]);

    // Strict at every level, and the refusal names the key.
    for (const [text, key] of [
      ["serve:\n  enable: true\n", "enable"],
      ["serve:\n  start:\n    - pipeline: dev\n      when: always\n", "when"],
      ["serve:\n  start:\n    - pipeline: dev\n      match:\n        state: [todo]\n", "state"],
    ] as const) {
      const error = await refusal(text);
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).toContain(key);
    }
    // Bounds.
    for (const text of [
      "serve:\n  max_workers: 0\n",
      "serve:\n  max_workers: 65\n",
      "serve:\n  max_runs: 0\n",
      "serve:\n  max_runs: 65\n",
      "serve:\n  stalled_after_s: -1\n",
      "serve:\n  stalled_after_s: 86401\n",
      "serve:\n  max_workers: 1.5\n",
      "serve:\n  enabled: yes please\n",
      "serve:\n  start:\n    - match: {}\n",
      // The old shape, one rule and not a list.
      "serve:\n  start:\n    pipeline: dev\n",
      "serve:\n  start:\n    - pipeline: dev\n      match:\n        approval: never\n",
    ]) {
      expect((await refusal(text)).code).toBe("CONFIG_INVALID");
    }
    await write("serve:\n  max_workers: 64\n  max_runs: 64\n  stalled_after_s: 86400\n");
    expect((await loadConfig(dir)).serve.max_workers).toBe(64);
  });

  test("t44_release_note_promises_are_pinned", async () => {
    // What an older kodel says about the block is what this one says about any key it does not know.
    const error = await refusal("serve_v2:\n  enabled: true\n");
    expect(error.message).toContain(
      "unknown key: serve_v2; is the file written for a newer kodel? upgrade kodel or remove the key",
    );
    // The readers that date a wait by the last sign of life leave the note out.
    expect(NOT_A_SIGN_OF_LIFE).toEqual(["agent_session_named", "worker_note"]);
  });
});
