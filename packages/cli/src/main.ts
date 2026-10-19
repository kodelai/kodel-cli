import { createInterface } from "node:readline/promises";
import { runCli } from "./cli";

async function confirm(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await lines.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
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
  environment: process.env,
});
process.exit(code);
