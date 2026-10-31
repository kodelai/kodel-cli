/** The small pipelines and fixture files the real-agent scenarios run on. */

export interface Fixture {
  pipeline: string;
  files?: Record<string, string>;
}

/** The agent cannot know the word; the engine's failure message teaches it. */
export const SECRET: Fixture = {
  pipeline: [
    "name: secret",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create answer.txt containing the secret word and nothing else. The word is not given",
    "      to you: complete the step, and if the engine says it was wrong it will say why.",
    "    checks:",
    "      - { kind: command, command: node check.js }",
    "",
  ].join("\n"),
  files: {
    "check.js": [
      "const fs = require('node:fs');",
      "const word = fs.existsSync('answer.txt') ? fs.readFileSync('answer.txt', 'utf8').trim() : '';",
      "if (word !== 'swordfish') {",
      "  console.log('answer.txt must contain the word swordfish, it has: ' + word);",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};

/**
 * A check that contradicts the step: the step asks for two words and the check accepts one. Only a
 * change of the pipeline can make this run pass, and it is a change of the check, not of the work.
 */
export const TIGHT: Fixture = {
  pipeline: [
    "name: tight",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    '      Create greeting.txt containing exactly the two words "hello world" on one line and',
    "      nothing else.",
    "    checks:",
    `      - { kind: command, command: 'test "$(cat greeting.txt)" = hello' }`,
    "",
  ].join("\n"),
};

/** Gate that can send the work back, and a command after it. */
export const REVIEWED: Fixture = {
  pipeline: [
    "name: reviewed",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create note.txt containing one line with the word hello. Change nothing else.",
    "    checks:",
    '      - { kind: diff, paths: ["note.txt"], mode: changed_only }',
    "  - slug: approve",
    "    kind: human",
    "    prompt: Is note.txt right?",
    "  - slug: verify",
    "    kind: command",
    `    command: node -e "process.exit(0)"`,
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: verify }",
    "  - { from: approve, to: write, when: rejected }",
    "  - { from: verify, to: write, when: failed }",
    "",
  ].join("\n"),
};

/** A gate with `instructions` for the person, whose details the agent cannot know unless the gate gives them. */
export const INSTRUCTED: Fixture = {
  pipeline: [
    "name: instructed",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create note.txt containing one line with the word hello. Change nothing else.",
    "    checks:",
    '      - { kind: diff, paths: ["note.txt"], mode: changed_only }',
    "  - slug: approve",
    "    kind: human",
    "    prompt: Is note.txt right?",
    "    instructions: |",
    "      Run `node verify-note.js` and check that it prints OK.",
    "      Then compare note.txt with the ticket TKT-9137, and approve only if they agree.",
    "  - slug: verify",
    "    kind: command",
    `    command: node -e "process.exit(0)"`,
    "edges:",
    "  - { from: write, to: approve }",
    "  - { from: approve, to: verify }",
    "  - { from: approve, to: write, when: rejected }",
    "  - { from: verify, to: write, when: failed }",
    "",
  ].join("\n"),
  files: { "verify-note.js": "console.log('OK');\n" },
};

/** A check nothing can pass, with a low limit, so the run pauses. */
export const STUBBORN: Fixture = {
  pipeline: [
    "name: stubborn",
    "nodes:",
    "  - slug: attempt",
    "    kind: agent",
    "    max_consecutive_failures: 2",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create hello.txt containing the word hello.",
    "    checks:",
    "      - { kind: command, command: node fail.js }",
    "",
  ].join("\n"),
  files: {
    "fail.js": "console.log('this check always fails');\nprocess.exit(1);\n",
  },
};

/** An engine command that takes longer than the 20 s a tool call waits. */
export const SLOW: Fixture = {
  pipeline: [
    "name: slow",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create hello.txt containing the word hello. Change nothing else.",
    "    checks:",
    '      - { kind: diff, paths: ["hello.txt"], mode: changed_only }',
    "  - slug: wait",
    "    kind: command",
    "    command: node slow.js",
    "    expected_duration: 25",
    "edges:",
    "  - { from: write, to: wait }",
    "  - { from: wait, to: write, when: failed }",
    "",
  ].join("\n"),
  files: {
    "slow.js": "setTimeout(() => console.log('done'), 25000);\n",
  },
};

/** A node that has to hand in a report of findings, made by someone who has not seen the work. */
export const INDEPENDENT: Fixture = {
  pipeline: [
    "name: independent",
    "nodes:",
    "  - slug: audit",
    "    kind: agent",
    "    fresh_context: true",
    "    prompt: |",
    "      Task: {{task}}",
    "      Read notes.txt. Every line that starts with BUG( is one finding. Report each of them.",
    "    checks:",
    "      - kind: result",
    "        columns:",
    "          severity: { enum: [major, minor] }",
    "          location: location",
    "          description: text",
    "        fail_when: { severity: [major] }",
    "",
  ].join("\n"),
  files: {
    "notes.txt": ["BUG(minor): the title has a typo", "all else is fine", ""].join("\n"),
  },
};

/** A node that has to hand in a report of findings. */
export const AUDIT: Fixture = {
  pipeline: [
    "name: audit",
    "nodes:",
    "  - slug: audit",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Read notes.txt. Every line that starts with BUG( is one finding. Report each of them.",
    "    checks:",
    "      - kind: result",
    "        columns:",
    "          severity: { enum: [major, minor] }",
    "          location: location",
    "          description: text",
    "        fail_when: { severity: [major] }",
    "",
  ].join("\n"),
  files: {
    "notes.txt": [
      "BUG(minor): the title has a typo",
      "this line is fine",
      "BUG(minor): startup is a little slow",
      "",
    ].join("\n"),
  },
};

// ── forks ─────────────────────────────────────────────────────────────────────
// The commands are `node <file>.js`, so they run the same in a POSIX shell and in `cmd.exe`.

/** `node check.js <file> <word>`: passes when the file holds exactly the word; says what is wrong otherwise. */
const CHECK_JS = [
  "const fs = require('node:fs');",
  "const [file, word] = process.argv.slice(2);",
  "const has = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;",
  "if (has !== word) {",
  "  console.log(file + ' must contain exactly the word ' + word + '; it ' + (has === null ? 'is missing' : 'has: ' + has));",
  "  process.exit(1);",
  "}",
  "",
].join("\n");

/**
 * `node work.js <name> <word> <seconds>`: the step's own work, which takes a while so that two workers
 * that really run at once overlap in the journal by a wide margin.
 */
const WORK_JS = [
  "const fs = require('node:fs');",
  "const [name, word, seconds] = process.argv.slice(2);",
  "setTimeout(() => {",
  "  fs.writeFileSync(name + '.txt', word + '\\n');",
  "  console.log('wrote ' + name + '.txt');",
  "}, Number(seconds ?? 0) * 1000);",
  "",
].join("\n");

const PASS_JS = "process.exit(0);\n";

const WORDS = ["alpha", "beta", "gamma", "delta"] as const;

/**
 * A fork into agent branches that meet at an agent join. `prep` is an agent step (the fork comes out of
 * a completion, as in a real pipeline) or a command (the run forks as soon as it starts, so a test can
 * start it and act on the open steps before the agent comes in).
 */
export function forkFixture(
  options: { branches?: number; seconds?: number; kickoff?: "agent" | "command" } = {},
): Fixture {
  const count = options.branches ?? 2;
  const seconds = options.seconds ?? 0;
  const names = ["a", "b", "c", "d"].slice(0, count);
  const kickoff =
    options.kickoff === "command"
      ? [
          "  - slug: prep",
          "    kind: command",
          "    command: node pass.js",
          // A command needs a way out on failure; `pass.js` never fails, so this is never taken.
          "  - slug: broken",
          "    kind: agent",
          "    prompt: The first step failed. Say so and stop.",
        ]
      : [
          "  - slug: prep",
          "    kind: agent",
          "    prompt: |",
          "      Task: {{task}}",
          "      Create plan.txt containing the word go. Change nothing else.",
          "    checks:",
          "      - { kind: command, command: node check.js plan.txt go }",
        ];
  const branch = (name: string, index: number) => {
    const word = WORDS[index] ?? "word";
    const work =
      seconds > 0
        ? `      Run \`node work.js ${name} ${word} ${seconds}\` (it takes about ${seconds} seconds); it writes ${name}.txt.`
        : `      Create ${name}.txt containing the word ${word}.`;
    return [
      `  - slug: ${name}`,
      "    kind: agent",
      "    prompt: |",
      work,
      "      Change nothing else.",
      "    checks:",
      `      - { kind: command, command: node check.js ${name}.txt ${word} }`,
    ];
  };
  return {
    pipeline: [
      "name: pair",
      "description: Prepare, write one file per branch at the same time, then finish.",
      "nodes:",
      ...kickoff,
      ...names.flatMap(branch),
      "  - slug: join",
      "    kind: agent",
      "    join: all",
      "    prompt: |",
      "      Create done.txt containing the word done. Change nothing else.",
      "    checks:",
      "      - { kind: command, command: node check.js done.txt done }",
      "edges:",
      ...names.map((name) => `  - { from: prep, to: ${name} }`),
      ...(options.kickoff === "command" ? ["  - { from: prep, to: broken, when: failed }"] : []),
      ...names.map((name) => `  - { from: ${name}, to: join }`),
      "",
    ].join("\n"),
    files: { "check.js": CHECK_JS, "work.js": WORK_JS, "pass.js": PASS_JS },
  };
}

/** The join prompt of the documented fork example: fix what failed, then run only that again. */
const FIX_PROMPT = [
  "    prompt: |",
  "      The branches before you ran at the same time. If a branch failed, the feedback names it",
  "      and says why: fix the cause, then finish with the outcome restart_failed so that only the",
  "      failed steps run again. If every branch passed, finish normally.",
];

/**
 * The documented fork pattern with command branches: `verify` passes, `test` fails until the join
 * creates `fixed.txt`, and its output says so.
 */
export const FORKFIX: Fixture = {
  pipeline: [
    "name: forkfix",
    "description: Make a change, verify and test it at the same time, fix what failed.",
    "nodes:",
    "  - slug: impl",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create hello.txt containing the word hello. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js hello.txt hello }",
    "  - slug: verify",
    "    kind: command",
    "    command: node pass.js",
    "  - slug: test",
    "    kind: command",
    "    command: node test.js",
    "  - slug: fix",
    "    kind: agent",
    "    join: all",
    ...FIX_PROMPT,
    "edges:",
    "  - { from: impl, to: verify }",
    "  - { from: impl, to: test }",
    "  - { from: verify, to: fix }",
    "  - { from: verify, to: fix, when: failed }",
    "  - { from: test, to: fix }",
    "  - { from: test, to: fix, when: failed }",
    "",
  ].join("\n"),
  files: {
    "check.js": CHECK_JS,
    "pass.js": PASS_JS,
    "test.js": [
      "const fs = require('node:fs');",
      "const ok = fs.existsSync('fixed.txt') && fs.readFileSync('fixed.txt', 'utf8').trim() === 'ok';",
      "if (!ok) {",
      "  console.log('test failed: fixed.txt containing the word ok is missing; create it');",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};

/** A fork whose branches each end at a gate of their own, so two decisions wait at once. */
export const GATES: Fixture = {
  pipeline: [
    "name: gates",
    "description: Prepare, write two files at the same time, have each approved, then finish.",
    "nodes:",
    "  - slug: prep",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create plan.txt containing the word go. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js plan.txt go }",
    "  - slug: a",
    "    kind: agent",
    "    prompt: |",
    "      Create a.txt containing the word alpha. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js a.txt alpha }",
    "  - slug: gate-a",
    "    kind: human",
    "    prompt: Is a.txt right?",
    "  - slug: b",
    "    kind: agent",
    "    prompt: |",
    "      Create b.txt containing the word beta. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js b.txt beta }",
    "  - slug: gate-b",
    "    kind: human",
    "    prompt: Is b.txt right?",
    "  - slug: join",
    "    kind: agent",
    "    join: all",
    "    prompt: |",
    "      Create done.txt containing the word done. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js done.txt done }",
    "edges:",
    "  - { from: prep, to: a }",
    "  - { from: prep, to: b }",
    "  - { from: a, to: gate-a }",
    "  - { from: gate-a, to: join }",
    "  - { from: gate-a, to: a, when: rejected }",
    "  - { from: b, to: gate-b }",
    "  - { from: gate-b, to: join }",
    "  - { from: gate-b, to: b, when: rejected }",
    "",
  ].join("\n"),
  files: { "check.js": CHECK_JS },
};

/**
 * Agent branches where `b` fails on its first attempt, whatever the worker does: its check needs
 * `allow-b.txt`, which the step forbids it to create and the join is told to. The failure routes the
 * branch to the join, and only `restart_failed` brings it back.
 */
export const FAILFIX: Fixture = {
  pipeline: [
    "name: failfix",
    "description: Prepare, write two files at the same time, fix what failed.",
    "nodes:",
    "  - slug: prep",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create plan.txt containing the word go. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js plan.txt go }",
    "  - slug: a",
    "    kind: agent",
    "    prompt: |",
    "      Create a.txt containing the word alpha. Change nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js a.txt alpha }",
    "  - slug: b",
    "    kind: agent",
    "    prompt: |",
    "      Create b.txt containing the word beta. Change nothing else; in particular do not create",
    "      allow-b.txt: only the step after this one may.",
    "    checks:",
    "      - { kind: command, command: node check-b.js }",
    "  - slug: fix",
    "    kind: agent",
    "    join: all",
    ...FIX_PROMPT,
    "edges:",
    "  - { from: prep, to: a }",
    "  - { from: prep, to: b }",
    "  - { from: a, to: fix }",
    "  - { from: b, to: fix }",
    "  - { from: b, to: fix, when: failed }",
    "",
  ].join("\n"),
  files: {
    "check.js": CHECK_JS,
    "check-b.js": [
      "const fs = require('node:fs');",
      "if (!fs.existsSync('allow-b.txt')) {",
      "  console.log('b failed: allow-b.txt is missing; the join step has to create it (any content)');",
      "  process.exit(1);",
      "}",
      "const has = fs.existsSync('b.txt') ? fs.readFileSync('b.txt', 'utf8').trim() : '';",
      "if (has !== 'beta') {",
      "  console.log('b.txt must contain exactly the word beta');",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};

/**
 * One step whose check looks for the file in the directory the engine runs it in: whether the
 * agent wrote it where the run works is the whole question.
 */
export const WORKTREE: Fixture = {
  pipeline: [
    "name: worktree",
    "nodes:",
    "  - slug: write",
    "    kind: agent",
    "    prompt: |",
    "      Task: {{task}}",
    "      Create answer.txt containing the word hello and nothing else.",
    "    checks:",
    "      - { kind: command, command: node check.js }",
    "",
  ].join("\n"),
  files: {
    "check.js": [
      "const fs = require('node:fs');",
      "const word = fs.existsSync('answer.txt') ? fs.readFileSync('answer.txt', 'utf8').trim() : '';",
      "if (word !== 'hello') {",
      "  console.log('there is no answer.txt with the word hello in ' + process.cwd());",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"),
  },
};
