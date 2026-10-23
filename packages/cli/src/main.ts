import { createInterface } from "node:readline/promises";
import { runCli } from "./cli";
import type { Choice } from "./init";

async function confirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await lines.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    lines.close();
  }
}

async function select(question: string, choices: Choice[]): Promise<string[]> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaults = choices.flatMap((c, i) => (c.checked ? [i + 1] : []));
    process.stdout.write(`${question}\n`);
    for (const [i, c] of choices.entries()) process.stdout.write(`  ${i + 1}) ${c.label}\n`);
    for (;;) {
      const answer = await lines.question(
        `Numbers separated by commas, "none" for nothing [${defaults.join(",") || "none"}]: `,
      );
      const text = answer.trim().toLowerCase();
      if (text === "") return defaults.flatMap((n) => choices[n - 1]?.value ?? []);
      if (text === "none") return [];
      const numbers = text.split(/[\s,]+/).map(Number);
      if (numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= choices.length)) {
        return [...new Set(numbers)].flatMap((n) => choices[n - 1]?.value ?? []);
      }
      process.stdout.write("Not understood, try again.\n");
    }
  } finally {
    lines.close();
  }
}

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm,
  select,
  environment: process.env,
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
});
process.exit(code);
