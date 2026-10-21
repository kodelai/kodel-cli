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
