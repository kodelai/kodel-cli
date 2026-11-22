// Criteria 8 and 9: `stop` leaves a conversation that an interactive `--resume` continues; a second
// `--resume` of the same id holds the turns of the first resumed session; the same after SIGKILL; no
// question at the start of a resume; and `--resume` across modes (interactive <-> -p), both ways.
//   node resume.mjs <trusted cwd> [--compact N]
// Signed in, the model's answers say whether the turns are held. Not signed in, every turn ends in the
// sign-in error, and what is left to see is the mechanics: whether the resume asks anything, whether
// the earlier turns are shown, and whether the id (one transcript file) stays one.
// --compact N: after the first turn, `/compact` is typed N times (a cheap stand-in for a long
// conversation with several compactions; it does not show what an hour of real work does).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ALLOWED,
  agentEnv,
  CLAUDE,
  DENIED,
  MODEL,
  open,
  quit,
  sleep,
  transcriptOf,
  turnsOf,
  uuid,
  workerFlags,
} from "./lib.mjs";

const cwd = fs.realpathSync(process.argv[2]);
const compactN = process.argv.includes("--compact")
  ? Number(process.argv[process.argv.indexOf("--compact") + 1])
  : 0;
const mcp = JSON.stringify({
  mcpServers: { kodel: { command: "node", args: ["-e", "setInterval(()=>{},1e9)"] } },
});
const flags = (extra) => workerFlags({ mcp, allowed: ALLOWED, denied: DENIED, ...extra });
const QUESTION =
  /Resume from summary|Resume full session|Do you want|\(y\/n\)|❯ 1\.|Enter to confirm|Select|Choose/i;
const files = () => {
  const dir = path.dirname(transcriptOf(cwd, "x"));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length : 0;
};

/** One interactive session: started, its first still screen judged, one optional typed prompt, then ended. */
async function session(tag, args, { typed, end = "stop" } = {}) {
  const s = open(tag, CLAUDE, args, { cwd });
  await s.quiet(3000, 60_000);
  const first = s.text();
  const asks = QUESTION.test(first);
  s.snap(`first still screen${asks ? " (IT ASKS SOMETHING)" : ""}`);
  if (typed && !asks) {
    await s.submit(typed);
    await s.waitFor(/esc to interrupt/i, 5000);
    await s.quiet(4000, 120_000);
    s.snap(`after "${typed.slice(0, 40)}"`);
  }
  if (end === "stop") {
    // What the adapter's `stop` does to the child's group: SIGTERM, a grace, SIGKILL.
    s.kill("SIGTERM");
    if ((await s.end(8000)) === undefined) s.kill("SIGKILL");
  } else if (end === "kill") s.kill("SIGKILL");
  else await quit(s);
  console.log(`[${tag}] ended: ${JSON.stringify(await s.end(5000))}; asked at start: ${asks}`);
  return { first, last: s.text(), asks };
}

async function chain(label, end) {
  const id = uuid();
  const file = transcriptOf(cwd, id);
  const before = files();
  console.log(`\n=== ${label}: conversation ${id}`);
  const a = open(
    `c8-${label}-a`,
    CLAUDE,
    ["Remember the word alpha. Reply with the one word: ok", ...flags({ sessionId: id })],
    { cwd },
  );
  await a.quiet(4000, 120_000);
  for (let i = 0; i < compactN; i++) {
    await a.submit("/compact");
    await a.quiet(5000, 180_000);
    await a.submit(`Remember also the number ${i + 1}. Reply with the one word: ok`);
    await a.quiet(4000, 120_000);
  }
  a.snap("the first session before it is ended");
  if (end === "kill") a.kill("SIGKILL");
  else {
    a.kill("SIGTERM");
    if ((await a.end(8000)) === undefined) a.kill("SIGKILL");
  }
  console.log(
    `first session ended (${end}): ${JSON.stringify(await a.end(5000))}; transcript: ${JSON.stringify(turnsOf(file))}`,
  );

  const b = await session(`c8-${label}-b`, flags({ resume: id }), {
    typed: "Remember also the word beta. Which word did I ask you to remember first? One word.",
    end,
  });
  console.log(
    `first resume shows the first turn: ${/alpha/.test(b.first)}; transcript: ${JSON.stringify(turnsOf(file))}`,
  );
  const c = await session(`c8-${label}-c`, flags({ resume: id }), {
    typed: "Which two words did I ask you to remember? Two words.",
    end: "quit",
  });
  console.log(
    `second resume shows the turn of the first resumed session (beta): ${/beta/.test(c.first)}; transcript: ${JSON.stringify(turnsOf(file))}`,
  );
  console.log(
    `transcript files made for this conversation: ${files() - before} (1 = the id stayed one)`,
  );
  console.log(`a resume asked a question at its start: ${b.asks || c.asks}`);
  return id;
}

const stopped = await chain("stop", "stop");
await chain("sigkill", "kill");

// Criterion 9: across modes.
const env = agentEnv();
const print = (args) => {
  const r = spawnSync(CLAUDE, ["-p", ...args, "--model", MODEL, "--permission-mode", "dontAsk"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return `${(r.stdout + r.stderr).trim().slice(0, 300)} (exit ${r.status})`;
};
console.log("\n=== interactive -> print");
console.log(
  "claude -p --resume <interactive id>:",
  print(["Which words did I ask you to remember? Words only.", "--resume", stopped]),
);
console.log("transcript:", JSON.stringify(turnsOf(transcriptOf(cwd, stopped))));
console.log("\n=== print -> interactive");
const pid = uuid();
console.log(
  "claude -p --session-id <new id>:",
  print(["Remember the word gamma. Reply with the one word: ok", "--session-id", pid]),
);
const d = await session("c9-print-to-tty", flags({ resume: pid }), {
  typed: "Which word did I ask you to remember? One word.",
  end: "quit",
});
console.log(
  `interactive resume of a print conversation: asked ${d.asks}; shows its turn: ${/gamma/.test(d.first)}; transcript: ${JSON.stringify(turnsOf(transcriptOf(cwd, pid)))}`,
);
