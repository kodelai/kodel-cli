import { runCli } from "./cli";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
process.exit(code);
