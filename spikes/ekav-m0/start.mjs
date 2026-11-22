// Criteria 1, 2, 3, 6 and the idle half of 7: what an interactive claude shows when it is started the
// way a terminal worker will be, in the folder given.
//   node start.mjs <tag> <cwd> [--no-mcp] [--prompt <text>] [--idle <seconds>] [--plain] [--order first|last|dashdash]
// --plain starts `claude` with no flag at all (the control for the dialogs).
import { ALLOWED, CLAUDE, DENIED, open, quit, sleep, transcriptOf, turnsOf, uuid, workerFlags } from "./lib.mjs";

const [tag, cwd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const value = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const prompt = value("--prompt", "Reply with the one word: pong");
const idleS = Number(value("--idle", "20"));
const id = uuid();
// A server that needs no project: `--mcp-config` with a server claude has never seen in this folder.
const mcp = JSON.stringify({ mcpServers: { kodel: { command: "node", args: ["-e", "setInterval(()=>{},1e9)"] } } });
const args = flag("--plain")
  ? []
  : [prompt, ...workerFlags({ mcp, allowed: ALLOWED, denied: DENIED, sessionId: id })];
// --order last: flags, then the prompt; --order dashdash: flags, `--`, the prompt.
const order = value("--order", "first");
if (order !== "first" && !flag("--plain")) args.push(...(order === "dashdash" ? ["--"] : []), args.shift());
if (flag("--no-mcp")) args.splice(args.indexOf("--mcp-config"), 3);

const s = open(tag, CLAUDE, args, { cwd });
console.log(`pid ${s.pid} session ${id} cwd ${cwd}\nargv: claude ${args.map((a) => JSON.stringify(a)).join(" ").slice(0, 400)}`);

// The first thing that holds still is either a dialog or the prompt box.
await s.quiet(3000, 30_000);
s.snap("first still screen");
const screen = s.text();
const seen = {
  trust: /trust (this|the) (folder|files)|Do you trust|Is this a project you/i.test(screen),
  mcpDialog: /New MCP server/i.test(screen),
  login: /Select login method|Paste code here|log ?in/i.test(screen),
  releaseNotes: /What's new|Release notes/i.test(screen),
  theme: /Choose the text style|Let's get started/i.test(screen),
  hook: /hook/i.test(screen),
};
console.log("seen on the first screen:", JSON.stringify(seen));

if (!flag("--plain") && !seen.trust && !seen.mcpDialog) {
  // Criterion 3: the prompt of the argv was submitted (a turn began, with no key from us).
  const answered = await s.waitFor(/pong|authenticat|\/login|API Error|error/i, 60_000, "plain");
  await s.quiet(2000, 20_000);
  s.snap("after the first turn");
  console.log("the turn's sign:", answered ? JSON.stringify(answered[0]) : "none within 60 s");
  // Criterion 7, idle: what is written while nobody types.
  const from = Date.now();
  const before = s.bytes;
  await sleep(idleS * 1000);
  const writes = s.writes.filter(([at]) => at >= from);
  console.log("idle bytes:", JSON.stringify(s.all.slice(-(s.bytes - before) || s.all.length).slice(0, 600)));
  console.log(`idle ${idleS} s: ${s.bytes - before} bytes in ${writes.length} writes`, JSON.stringify(writes.map(([at, n]) => [Math.round((at - from) / 1000), n])));
}
const exit = await quit(s);
console.log("exit:", JSON.stringify(exit));
console.log("transcript:", JSON.stringify(turnsOf(transcriptOf(cwd, id)) ?? "none"));
