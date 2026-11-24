/**
 * The worker keys of the `engines:` block (T-47, TASK-EKAV step 5): `worker`, `terminal.command`, who may
 * carry them, and the block as committed (`HEAD` of the checkout) for a start nobody watches.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodelError } from "@kodel-ai/pipeline-core";
import { serverInstructions } from "@kodel-ai/pipeline-core/mcp";
import { parse } from "yaml";
import {
  COMMIT_TO_USE_TERMINAL_COMMAND,
  CONFIG_FILE,
  configEngineResolver,
  ENGINES_ONLY_AS_COMMITTED,
  engineProfileSchema,
  enginesAgainstHead,
  enginesQuestion,
  type GitExec,
  gitHeadConfigReader,
  type HeadConfig,
  type HeadConfigReader,
  loadConfig,
  ONLY_CLAUDE_IS_A_WORKER,
  unattendedEngines,
  WORKER_ENGINES,
} from "../src";

const REPO = join(import.meta.dir, "../../..");

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "kodel-config-engines-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (text: string, at: string = dir) => writeFile(join(at, CONFIG_FILE), text);
const refusal = async (text: string): Promise<KodelError> => {
  await write(text);
  const error = await loadConfig(dir).catch((e: unknown) => e);
  expect(error, text).toBeInstanceOf(KodelError);
  return error as KodelError;
};

describe("t42 the worker keys of a profile", () => {
  test("t42_worker_and_terminal_keys_parse", async () => {
    await write(
      [
        "engines:",
        "  claude:",
        "    worker: terminal",
        "    terminal:",
        "      command: [/opt/bin/claude, --model, opus, --effort=high]",
        "",
      ].join("\n"),
    );
    expect((await loadConfig(dir)).engines).toEqual({
      claude: {
        worker: "terminal",
        terminal: { command: ["/opt/bin/claude", "--model", "opus", "--effort=high"] },
      },
    });
    await write("engines:\n  claude:\n    worker: print\n");
    expect((await loadConfig(dir)).engines).toEqual({ claude: { worker: "print" } });
    // An empty `terminal` and an empty profile are what the defaults are.
    await write("engines:\n  claude:\n    terminal: {}\n");
    expect((await loadConfig(dir)).engines).toEqual({ claude: { terminal: {} } });
    await write("engines:\n  claude: {}\n");
    expect((await loadConfig(dir)).engines).toEqual({ claude: {} });

    // A misspelled key or value is named, with where it is.
    const rows: [string, string[]][] = [
      ["engines:\n  claude:\n    workr: terminal\n", ["workr", "engines.claude"]],
      ["engines:\n  claude:\n    worker: pty\n", ["'terminal' | 'print'", "engines.claude.worker"]],
      ["engines:\n  claude:\n    worker: true\n", ["engines.claude.worker"]],
      [
        "engines:\n  claude:\n    terminal:\n      comand: [claude]\n",
        ["comand", "engines.claude.terminal"],
      ],
      [
        "engines:\n  claude:\n    terminal:\n      command: []\n",
        ["engines.claude.terminal.command"],
      ],
      [
        "engines:\n  claude:\n    terminal:\n      command: claude --model opus\n",
        ["engines.claude.terminal.command"],
      ],
    ];
    for (const [text, said] of rows) {
      const error = await refusal(text);
      expect(error.code).toBe("CONFIG_INVALID");
      for (const part of said) expect(error.message, text).toContain(part);
    }

    // A schema that does not have the keys (an older kodel) answers `unknown key`, as it did for `serve`.
    const older = engineProfileSchema.omit({ worker: true, terminal: true }).strict();
    const answer = older.safeParse({ worker: "print", terminal: { command: ["claude"] } });
    expect(answer.success).toBe(false);
    if (!answer.success) {
      expect(answer.error.issues[0]).toMatchObject({
        code: "unrecognized_keys",
        keys: ["worker", "terminal"],
      });
    }
  });

  test("t47_engines_terminal_command_grammar_is_checked_when_the_config_is_read", async () => {
    const rows: [string, string][] = [
      ["[claude, --dangerously-skip-permissions]", 'the flag "--dangerously-skip-permissions"'],
      ["[claude, --permission-mode, bypassPermissions]", 'the flag "--permission-mode"'],
      ["[claude, --permission-mode=bypassPermissions]", 'the flag "--permission-mode"'],
      ["[claude, -m, opus]", 'the flag "-m"'],
      ["[claude, doctor]", '"doctor" is a bare word'],
      ["[claude, --model, opus, again]", '"again" is a bare word'],
      ["[claude, --model, --effort]", 'the value of "--model" ("--effort") begins with -'],
      ["[claude, --model=-x]", 'the value of "--model" ("-x") begins with -'],
      ["[claude, --model]", 'the flag "--model" has no value'],
      ["[--model, opus]", "is a flag"],
    ];
    for (const [command, said] of rows) {
      const error = await refusal(
        `engines:\n  claude:\n    terminal:\n      command: ${command}\n`,
      );
      expect(error.message, command).toContain("engines.claude.terminal.command: ");
      expect(error.message, command).toContain(said);
    }
    for (const flag of WORKER_ENGINES.claude?.terminalFlags ?? []) {
      for (const pair of [`${flag}, v`, `${flag}=v`]) {
        await write(`engines:\n  claude:\n    terminal:\n      command: [wrap, ${pair}]\n`);
        expect((await loadConfig(dir)).engines.claude?.terminal?.command?.[0], pair).toBe("wrap");
      }
    }
  });

  test("t42_present_engine_configs_still_load", async () => {
    // The profile the documentation shows, under the name `claude` and under any other name.
    const doc = readFileSync(join(REPO, "docs/engines.md"), "utf8");
    const block = /```yaml\n(engines:\n[\s\S]*?)```/.exec(doc)?.[1];
    expect(block).toBeDefined();
    await write(block as string);
    const profile = {
      command: ["claude", "-p", "--output-format", "json"],
      model_flag: "--model",
      pass_env: ["ANTHROPIC_API_KEY"],
      env: { CLAUDE_CODE_DISABLE_TELEMETRY: "1" },
      timeout: 1800,
    };
    expect((await loadConfig(dir)).engines).toEqual({ claude: profile });
    await write(
      `${(block as string).replace("  claude:", "  reviewer:")}  codex:\n    command: [codex]\n`,
    );
    expect((await loadConfig(dir)).engines).toEqual({
      reviewer: profile,
      codex: { command: ["codex"] },
    });
    // This repository's own config, and one with no block.
    const own = join(REPO, ".kodel");
    const raw: unknown = parse(readFileSync(join(own, CONFIG_FILE), "utf8"));
    const written = (raw as { engines?: unknown } | null)?.engines ?? {};
    expect((await loadConfig(own)).engines).toEqual(written as never);
    await write("version: 1\n");
    expect((await loadConfig(dir)).engines).toEqual({});
  });

  test("t42_profile_without_step_command_is_refused_for_a_step", async () => {
    await write("engines:\n  claude:\n    worker: print\n  reviewer:\n    command: [review]\n");
    const resolver = configEngineResolver(
      async () => (await loadConfig(dir)).engines,
      () => ({ PATH: "/usr/bin" }),
    );
    const refused = await resolver.resolve({ profile: "claude", prompt: "p" }, { cwd: "/w" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('the engine profile "claude" has no command');
    }
    const run = await resolver.resolve({ profile: "reviewer", prompt: "p" }, { cwd: "/w" });
    expect(run.ok && run.launch.argv).toEqual(["review", "--", "p"]);
  });

  test("t47_only_claude_is_a_worker", async () => {
    for (const name of ["codex", "opencode", "reviewer", "claude-2"]) {
      for (const keys of [
        "    worker: terminal\n",
        "    worker: print\n",
        "    terminal: {}\n",
        "    terminal:\n      command: [codex]\n",
        "    command: [x]\n    worker: print\n",
      ]) {
        const error = await refusal(`engines:\n  ${name}:\n${keys}`);
        expect(error.code).toBe("CONFIG_INVALID");
        expect(error.message, `${name} ${keys}`).toContain(
          `engines.${name}: only claude can be a worker in this version; codex and opencode are a follow-up task`,
        );
      }
    }
    expect(ONLY_CLAUDE_IS_A_WORKER).toContain("follow-up task");
    // A step profile of another name with neither key loads as it did; `claude` may carry both.
    await write(
      "engines:\n  codex:\n    command: [codex, exec]\n  claude:\n    command: [claude, -p]\n    worker: print\n",
    );
    expect((await loadConfig(dir)).engines).toEqual({
      codex: { command: ["codex", "exec"] },
      claude: { command: ["claude", "-p"], worker: "print" },
    });
  });

  test("t47_instructions_name_engines", () => {
    for (const options of [{}, { dialog: true }, { decisions: { gate: true } }]) {
      const text = serverInstructions(options);
      expect(text).toMatch(/`engines` block of the project config[^\n]*is the person's/);
      expect(text).toContain("never add to it or change it");
    }
    const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
    const rule = /^- Do not edit `\.mcp\.json`[\s\S]*?(?=^- )/m.exec(agents)?.[0] ?? "";
    expect(rule).toContain("the `engines` block");
    expect(rule).toContain("only as committed");
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

const TERMINAL = "engines:\n  claude:\n    worker: terminal\n";
const PRINT = "engines:\n  claude:\n    worker: print\n";
const WITH_COMMAND =
  "engines:\n  claude:\n    worker: terminal\n    terminal:\n      command: [wrap, --model, opus]\n";

/** A repository at `top` whose project is `top/<sub>`, with `committed` as its config when given. */
async function project(sub = "", committed?: string): Promise<{ root: string; store: string }> {
  git(dir, "init", "-q", "-b", "main");
  const root = sub === "" ? dir : join(dir, sub);
  const store = join(root, ".kodel");
  await mkdir(store, { recursive: true });
  await writeFile(join(dir, "README.md"), "x\n");
  if (committed !== undefined) await write(committed, store);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return { root, store };
}

describe("t47 the engines block is used as committed", () => {
  test("t47_engines_block_is_read_from_head", async () => {
    const { root, store } = await project("", TERMINAL);
    const against = () => enginesAgainstHead({ root, storeRoot: store });
    const unattended = async () => unattendedEngines(await against());
    const used = { ok: true, engines: { claude: { worker: "terminal" } } } as const;
    const refused = { ok: false, reason: ENGINES_ONLY_AS_COMMITTED } as const;
    expect(ENGINES_ONLY_AS_COMMITTED).toBe(
      "engines is used only as committed: commit .kodel/config.yaml or put the block back as it was",
    );

    // Equal: used. Nothing is asked of a person.
    expect(await unattended()).toEqual(used);
    expect(enginesQuestion(await against())).toEqual([]);

    // A `serve` edit beside it, a comment and another order of the keys: still the committed block.
    await write(
      "# mine\nserve:\n  max_workers: 2\nengines:\n  claude: { worker: terminal }\n",
      store,
    );
    expect(await unattended()).toEqual(used);

    // A working-copy edit: refused for a start nobody watches; a person is shown the difference.
    await write(PRINT, store);
    expect(await unattended()).toEqual(refused);
    expect(enginesQuestion(await against())).toEqual([
      "the engines block of .kodel/config.yaml is not the committed one:",
      '  engines.claude.worker: committed "terminal", now "print"',
    ]);

    // A staged-only edit is not a committed one.
    git(dir, "add", "-A");
    expect(await unattended()).toEqual(refused);

    // A block in `HEAD` that the working copy removed (the key, or the whole file).
    await write("version: 1\n", store);
    expect(await unattended()).toEqual(refused);
    expect(enginesQuestion(await against())).toEqual([
      "the engines block of .kodel/config.yaml is not the committed one:",
      '  engines.claude.worker: committed "terminal", now absent',
    ]);
    await rm(join(store, CONFIG_FILE));
    expect(await unattended()).toEqual(refused);

    // Put back as it was: used again.
    await write(TERMINAL, store);
    expect(await unattended()).toEqual(used);

    // A commit a worker made on its run's branch changes nothing: `HEAD` is the checkout's.
    const worktree = join(dir, ".kodel", "worktrees", "r_0abc_0000");
    git(dir, "worktree", "add", "-q", "-b", "kodel/r_0abc_0000", worktree);
    await write(WITH_COMMAND, join(worktree, ".kodel"));
    git(worktree, "commit", "-q", "-am", "the worker's");
    expect(await unattended()).toEqual(used);
    // One on the checkout's own branch does (the stated limit).
    await write(WITH_COMMAND, store);
    expect(await unattended()).toEqual(refused);
    git(dir, "commit", "-q", "-am", "the person's");
    expect(await unattended()).toEqual({
      ok: true,
      engines: {
        claude: { worker: "terminal", terminal: { command: ["wrap", "--model", "opus"] } },
      },
    });

    // A value of `env` is named, never printed.
    await write(
      `${WITH_COMMAND}  reviewer:\n    command: [r]\n    env: { TOKEN: sk-secret-value-0123456789 }\n`,
      store,
    );
    const shown = enginesQuestion(await against()).join("\n");
    expect(shown).toContain("engines.reviewer.env: committed absent, now changed");
    expect(shown).toContain('engines.reviewer.command: committed absent, now ["r"]');
    expect(shown).not.toContain("sk-secret");
  });

  test("t47_engines_block_is_read_from_head: a project in a subfolder of the repository", async () => {
    const { root, store } = await project("apps/web", TERMINAL);
    // Another config at the top of the repository is not this project's.
    await mkdir(join(dir, ".kodel"));
    await write(PRINT, join(dir, ".kodel"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "top");
    expect(unattendedEngines(await enginesAgainstHead({ root, storeRoot: store }))).toEqual({
      ok: true,
      engines: { claude: { worker: "terminal" } },
    });
    await write(PRINT, store);
    expect(unattendedEngines(await enginesAgainstHead({ root, storeRoot: store })).ok).toBe(false);
  });

  test("t47_engines_block_is_read_from_head: a config with no committed version", async () => {
    const note =
      "engines.claude.worker: terminal is taken from a .kodel/config.yaml that git does not track (there is no committed version to hold it to)";
    expect(COMMIT_TO_USE_TERMINAL_COMMAND).toBe(
      "commit .kodel/config.yaml to use terminal.command",
    );
    const rows = async (root: string, store: string, name: string) => {
      const against = () => enginesAgainstHead({ root, storeRoot: store });
      // `worker:` is honoured, and one line says so.
      await write(TERMINAL, store);
      expect((await against()).state, name).toBe("untracked");
      expect(unattendedEngines(await against()), name).toEqual({
        ok: true,
        engines: { claude: { worker: "terminal" } },
        note,
      });
      // `terminal.command` refuses a start nobody watches; a person is shown it and asked.
      await write(WITH_COMMAND, store);
      const refused = unattendedEngines(await against());
      expect(refused.ok, name).toBe(false);
      if (!refused.ok) {
        expect(refused.reason, name).toContain(COMMIT_TO_USE_TERMINAL_COMMAND);
        expect(refused.reason, name).toContain("engines.claude.terminal.command");
      }
      expect(enginesQuestion(await against()), name).toEqual([
        "git does not track .kodel/config.yaml, so its engines block has no committed version:",
        '  engines.claude.terminal: {"command":["wrap","--model","opus"]}',
        '  engines.claude.worker: "terminal"',
      ]);
      // No block and no file: nothing to say.
      await write("version: 1\n", store);
      expect(unattendedEngines(await against()), name).toEqual({ ok: true, engines: {} });
      expect(enginesQuestion(await against()), name).toEqual([]);
    };

    // No git at all.
    const bare = join(dir, "bare");
    await mkdir(join(bare, ".kodel"), { recursive: true });
    const noRepository = gitHeadConfigReader(undefined, () => false);
    expect(await noRepository(bare, join(bare, ".kodel", CONFIG_FILE))).toEqual({
      kind: "untracked",
    });
    await write(TERMINAL, join(bare, ".kodel"));
    expect(
      unattendedEngines(
        await enginesAgainstHead({
          root: bare,
          storeRoot: join(bare, ".kodel"),
          read: noRepository,
        }),
      ),
    ).toEqual({ ok: true, engines: { claude: { worker: "terminal" } }, note });

    // A repository that ignores the config, and one with no commit yet.
    const ignoring = join(dir, "ignoring");
    await mkdir(join(ignoring, ".kodel"), { recursive: true });
    git(ignoring, "init", "-q", "-b", "main");
    await rows(ignoring, join(ignoring, ".kodel"), "no commit yet");
    await writeFile(join(ignoring, ".gitignore"), ".kodel/\n");
    git(ignoring, "add", "-A");
    git(ignoring, "commit", "-q", "-m", "first");
    await rows(ignoring, join(ignoring, ".kodel"), "ignored");

    // Staged and never committed: git tracks it, so it is held to a committed version that has no block.
    const staged = join(dir, "staged");
    await mkdir(join(staged, ".kodel"), { recursive: true });
    git(staged, "init", "-q", "-b", "main");
    await write(TERMINAL, join(staged, ".kodel"));
    git(staged, "add", "-A");
    const found = await enginesAgainstHead({ root: staged, storeRoot: join(staged, ".kodel") });
    expect(found.state).toBe("differs");
    expect(unattendedEngines(found)).toEqual({ ok: false, reason: ENGINES_ONLY_AS_COMMITTED });
  });

  test("t47_engines_block_is_read_from_head: HEAD is read once, and a committed file that cannot be read differs", async () => {
    const store = join(dir, ".kodel");
    await mkdir(store);
    await write(TERMINAL, store);
    let reads = 0;
    const reader =
      (head: HeadConfig): HeadConfigReader =>
      async (root, file) => {
        reads += 1;
        expect(root).toBe(dir);
        expect(file).toBe(join(store, CONFIG_FILE));
        return head;
      };
    const against = (head: HeadConfig) =>
      enginesAgainstHead({ root: dir, storeRoot: store, read: reader(head) });
    expect((await against({ kind: "held", text: TERMINAL })).state).toBe("committed");
    expect(reads).toBe(1);
    // Not YAML, and a block the schema refuses (a worker that is not claude).
    for (const text of ["engines: [\n", "engines:\n  codex:\n    worker: terminal\n"]) {
      const found = await against({ kind: "held", text });
      expect(found).toEqual({ state: "differs", engines: { claude: { worker: "terminal" } } });
      expect(unattendedEngines(found)).toEqual({ ok: false, reason: ENGINES_ONLY_AS_COMMITTED });
      expect(enginesQuestion(found)[0]).toContain("cannot be read");
    }
    // A committed file with no block, and a working copy with none: equal.
    await write("serve:\n  max_workers: 2\n", store);
    expect((await against({ kind: "held", text: "version: 1\n" })).state).toBe("committed");
    expect((await against({ kind: "not_committed" })).state).toBe("committed");
    // A working copy that does not load is the caller's error, before git is asked.
    reads = 0;
    await write("engines:\n  codex:\n    worker: terminal\n", store);
    const error = await against({ kind: "held", text: TERMINAL }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KodelError);
    expect(reads).toBe(0);
  });

  test("t47_engines_head_reader_failure_refuses", async () => {
    const store = join(dir, ".kodel");
    await mkdir(store);
    await write(TERMINAL, store);
    const file = join(store, CONFIG_FILE);
    const inside = () => true;
    const answers =
      (table: Record<string, { code: number | null; stdout?: string; stderr?: string }>): GitExec =>
      async (args) => {
        const answer = table[args[0] ?? ""] ?? { code: 0 };
        return { code: answer.code, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
      };
    const notFound: GitExec = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const dubious = "fatal: detected dubious ownership in repository at '/proj'";
    const locked = "fatal: Unable to create '/proj/.git/index.lock': File exists.";
    const rows: [string, GitExec, string][] = [
      ["git not found", notFound, "git was not found"],
      ["safe.directory", answers({ "rev-parse": { code: 128, stderr: dubious } }), dubious],
      [
        "a locked index",
        answers({
          "rev-parse": { code: 0, stdout: "abc\n" },
          "ls-files": { code: 128, stderr: locked },
        }),
        locked,
      ],
      [
        "the tree cannot be listed",
        answers({ "ls-tree": { code: 128, stderr: "fatal: bad object HEAD" } }),
        "git ls-tree failed: fatal: bad object HEAD",
      ],
      [
        "the file cannot be shown",
        answers({
          "ls-tree": { code: 0, stdout: "100644 blob abc\t.kodel/config.yaml\n" },
          show: { code: 128, stderr: "fatal: unable to read abc" },
        }),
        "git show failed: fatal: unable to read abc",
      ],
      ["git does not answer", answers({ "rev-parse": { code: null } }), "did not answer"],
      ["a failure with no words", answers({ "rev-parse": { code: 2 } }), "exit code 2"],
    ];
    for (const [name, exec, said] of rows) {
      const read = gitHeadConfigReader(exec, inside);
      const head = await read(dir, file);
      expect(head.kind, name).toBe("failed");
      const found = await enginesAgainstHead({ root: dir, storeRoot: store, read });
      expect(found.state, name).toBe("failed");
      // A start nobody watches is refused with git's own reason; nothing falls back to the working copy.
      const refused = unattendedEngines(found);
      expect(refused.ok, name).toBe(false);
      if (!refused.ok) {
        expect(refused.reason, name).toContain("engines is used only as committed");
        expect(refused.reason, name).toContain(said);
      }
      // `agent start` is told why and shows what it would use, to ask.
      const asked = enginesQuestion(found);
      expect(asked[0], name).toContain(said);
      expect(asked[1], name).toBe('  engines.claude.worker: "terminal"');
    }
    // A reader that throws is a failure too, never "untracked".
    const thrown = await enginesAgainstHead({
      root: dir,
      storeRoot: store,
      read: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown).toMatchObject({ state: "failed", reason: "boom" });
    // The answers that are not failures, through the same fake: no commit yet, and a tracked file.
    const unborn = gitHeadConfigReader(answers({ "rev-parse": { code: 1 } }), inside);
    expect(await unborn(dir, file)).toEqual({ kind: "untracked" });
    const tracked = gitHeadConfigReader(
      answers({
        "rev-parse": { code: 1 },
        "ls-files": { code: 0, stdout: ".kodel/config.yaml\n" },
      }),
      inside,
    );
    expect(await tracked(dir, file)).toEqual({ kind: "not_committed" });
  });

  test("t47_engines_head_reader_failure_refuses: a real repository git refuses to read", async () => {
    const { root, store } = await project("", TERMINAL);
    // A `HEAD` that names no commit git can read: git's own words, not "untracked".
    await writeFile(join(dir, ".git", "HEAD"), "garbage\n");
    const found = await enginesAgainstHead({ root, storeRoot: store });
    expect(found.state).toBe("failed");
    const refused = unattendedEngines(found);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/git rev-parse failed: \S/);
  });
});
