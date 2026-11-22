// THROWAWAY spike for TASK-EKAV step 1. Never copied into the product.
// A PTY driver for the real `claude` (node only: a PTY under Bun reports no data), a small screen
// emulator to read what a TUI drew, and the fixture of a throwaway kodel project.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// The checkout that has node_modules and the built artifact (the run's worktree has neither).
export const MAIN = process.env.EKAV_MAIN ?? "/Users/tyurin23/Code/KodelAI/etude";
export const ARTIFACT = path.join(MAIN, "packages/cli/dist/kodel.js");
export const CLAUDE = process.env.EKAV_CLAUDE ?? "claude";
export const MODEL = process.env.EKAV_MODEL ?? "haiku";
export const OUT = process.env.EKAV_OUT ?? path.join(fs.realpathSync(os.tmpdir()), "ekav-m0");
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(path.join(MAIN, "packages/cli/package.json"));
const pty = require("@lydell/node-pty");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The environment a worker gets (`workerEnv` of claude-worker.ts): no KODEL_*, no marker of an outer
 * Claude Code session, KODEL_ENGINE=1 forced. This spike may be started from inside a Claude Code
 * session, so every CLAUDE* and ANTHROPIC* variable is dropped as well: a person's shell has none.
 */
export function agentEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(KODEL_|CLAUDE|ANTHROPIC_|EKAV_)/.test(k)) continue;
    if (/^(VSCODE_|TMUX|TERM_PROGRAM|ITERM_|WEZTERM_)/.test(k) || k === "STY") continue;
    env[k] = v;
  }
  return { ...env, TERM: "xterm-256color", KODEL_ENGINE: "1", ...extra };
}

const ESC = "\x1b";
const BEL = "\x07";
const CSI = new RegExp(`^${ESC}\\[([0-9;?<>=]*)([ -/]*)([@-~])`);
const OSC = new RegExp(`^${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`);
const CUT = new RegExp(`^${ESC}(\\[[0-9;?<>=]*[ -/]*|\\][^${BEL}${ESC}]*${ESC}?)?$`);
const CHARSET = new RegExp(`^${ESC}[()][0-9A-Z]`);
const CSI_ALL = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, "g");
const OSC_ALL = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, "g");

/** A screen of rows x cols that understands enough of a terminal to show what an Ink TUI drew. */
export class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.g = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.r = 0;
    this.c = 0;
    this.pending = "";
    this.saved = [0, 0];
  }
  blank() {
    return Array(this.cols).fill(" ");
  }
  lf() {
    if (this.r === this.rows - 1) {
      this.g.shift();
      this.g.push(this.blank());
    } else this.r++;
  }
  write(data) {
    const s = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ESC) {
        const rest = s.slice(i);
        let m = CSI.exec(rest);
        if (m) {
          this.csi(m[1], m[3]);
          i += m[0].length;
          continue;
        }
        m = OSC.exec(rest);
        if (m) {
          i += m[0].length;
          continue;
        }
        if (CUT.test(rest)) {
          this.pending = rest; // a sequence cut by the chunk boundary
          return;
        }
        m = CHARSET.exec(rest);
        if (m) {
          i += m[0].length;
          continue;
        }
        const n = s[i + 1];
        if (n === "7") this.saved = [this.r, this.c];
        else if (n === "8") [this.r, this.c] = this.saved;
        else if (n === "M") this.r = Math.max(0, this.r - 1);
        i += 2;
        continue;
      }
      if (ch === "\r") this.c = 0;
      else if (ch === "\n") this.lf();
      else if (ch === "\b") this.c = Math.max(0, this.c - 1);
      else if (ch === "\t") this.c = Math.min(this.cols - 1, (this.c + 8) & ~7);
      else if (ch >= " ") {
        const text = String.fromCodePoint(s.codePointAt(i));
        if (this.c >= this.cols) {
          this.c = 0;
          this.lf();
        }
        this.g[this.r][this.c++] = text;
        i += text.length;
        continue;
      }
      i++;
    }
  }
  csi(params, final) {
    const priv = params.startsWith("?");
    const p = params
      .replace(/^[?<>=]/, "")
      .split(";")
      .map((x) => (x === "" ? undefined : Number(x)));
    const n = p[0] ?? 1;
    if (final === "A") this.r -= n;
    else if (final === "B") this.r += n;
    else if (final === "C") this.c += n;
    else if (final === "D") this.c -= n;
    else if (final === "E") {
      this.r += n;
      this.c = 0;
    } else if (final === "F") {
      this.r -= n;
      this.c = 0;
    } else if (final === "G") this.c = n - 1;
    else if (final === "d") this.r = n - 1;
    else if (final === "H" || final === "f") {
      this.r = (p[0] ?? 1) - 1;
      this.c = (p[1] ?? 1) - 1;
    } else if (final === "J") {
      const mode = p[0] ?? 0;
      if (mode === 2 || mode === 3) this.g = this.g.map(() => this.blank());
      else if (mode === 0) {
        this.g[this.r].fill(" ", this.c);
        for (let r = this.r + 1; r < this.rows; r++) this.g[r] = this.blank();
      } else {
        this.g[this.r].fill(" ", 0, this.c + 1);
        for (let r = 0; r < this.r; r++) this.g[r] = this.blank();
      }
    } else if (final === "K") {
      const mode = p[0] ?? 0;
      if (mode === 0) this.g[this.r].fill(" ", this.c);
      else if (mode === 1) this.g[this.r].fill(" ", 0, this.c + 1);
      else this.g[this.r] = this.blank();
    } else if (final === "X") this.g[this.r].fill(" ", this.c, this.c + n);
    else if (final === "S") {
      for (let k = 0; k < n; k++) {
        this.g.shift();
        this.g.push(this.blank());
      }
    } else if ((final === "h" || final === "l") && priv && (p[0] === 1049 || p[0] === 47)) {
      this.g = this.g.map(() => this.blank());
      this.r = 0;
      this.c = 0;
    } else if (final === "s") this.saved = [this.r, this.c];
    else if (final === "u" && params === "") [this.r, this.c] = this.saved;
    this.r = Math.min(this.rows - 1, Math.max(0, this.r));
    this.c = Math.min(this.cols - 1, Math.max(0, this.c));
  }
  text() {
    return this.g
      .map((row) => row.join("").trimEnd())
      .join("\n")
      .replace(/\n+$/, "");
  }
}

/** Starts a program in a PTY. Everything it writes goes to `<OUT>/<tag>.raw` and to the screen. */
export function open(tag, file, args, { cwd, env = agentEnv(), cols = 120, rows = 40 } = {}) {
  const raw = path.join(OUT, `${tag}.raw`);
  fs.writeFileSync(raw, "");
  const screen = new Screen(cols, rows);
  const child = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
  const s = {
    tag,
    raw,
    screen,
    pid: child.pid,
    bytes: 0,
    startedAt: Date.now(),
    lastAt: Date.now(),
    all: "",
    exit: undefined,
    /** [time, bytes] of every write of the program to its terminal. */
    writes: [],
    text: () => screen.text(),
    /** Everything written so far with escape sequences dropped: for a word that scrolled off the screen. */
    plain: () => s.all.replace(CSI_ALL, " ").replace(OSC_ALL, ""),
    write: (data) => child.write(data),
    /** Text as a bracketed paste, then Enter as its own write (what kdjs-m0 found works). */
    async submit(text) {
      child.write(`${ESC}[200~${text}${ESC}[201~`);
      await sleep(400);
      child.write("\r");
    },
    async waitFor(re, ms, where = "screen") {
      const until = Date.now() + ms;
      for (;;) {
        const m = re.exec(where === "screen" ? screen.text() : s.plain());
        if (m) return m;
        if (s.exit !== undefined || Date.now() > until) return undefined;
        await sleep(100);
      }
    },
    /** Waits until nothing was written for `quietMs`. Answers false when `ms` passed first. */
    async quiet(quietMs, ms) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (Date.now() - s.lastAt >= quietMs) return true;
        await sleep(100);
      }
      return false;
    },
    kill(signal = "SIGTERM") {
      try {
        process.kill(child.pid, signal);
      } catch {}
    },
    async end(ms = 5000) {
      const until = Date.now() + ms;
      while (s.exit === undefined && Date.now() < until) await sleep(50);
      return s.exit;
    },
    snap(label) {
      const t = `--- [${tag}] ${label} ---\n${screen.text()}\n--- end ---`;
      fs.appendFileSync(path.join(OUT, `${tag}.screens`), `${t}\n`);
      console.log(t);
    },
  };
  child.onData((d) => {
    s.bytes += d.length;
    s.lastAt = Date.now();
    s.all += d;
    s.writes.push([Date.now(), d.length]);
    fs.appendFileSync(raw, d);
    screen.write(d);
    // Answer the terminal queries a TUI may wait for, as a real terminal would.
    if (d.includes(`${ESC}[6n`)) child.write(`${ESC}[${screen.r + 1};${screen.c + 1}R`);
    if (d.includes(`${ESC}[c`)) child.write(`${ESC}[?62;c`);
  });
  child.onExit((e) => {
    s.exit = e;
  });
  return s;
}

/** Quits an interactive claude the way a person does (Ctrl+C twice); a signal if it stays. */
export async function quit(s) {
  if (s.exit !== undefined) return s.exit;
  s.write("\x03");
  await sleep(300);
  s.write("\x03");
  if ((await s.end(4000)) === undefined) s.kill("SIGTERM");
  if ((await s.end(4000)) === undefined) s.kill("SIGKILL");
  return s.end(2000);
}

export const sh = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

/** Where claude keeps the transcript of a conversation started in `cwd`. */
export function transcriptOf(cwd, id) {
  const slug = fs.realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug, `${id}.jsonl`);
}

/** The lines of a transcript by type, and the prompts a person (or the argv) gave. */
export function turnsOf(file) {
  if (!fs.existsSync(file)) return undefined;
  const count = {};
  const prompts = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    count[rec.type] = (count[rec.type] ?? 0) + 1;
    if (rec.type === "user" && typeof rec.message?.content === "string") {
      prompts.push(rec.message.content.slice(0, 60));
    }
  }
  return { count, prompts };
}

const MINI = `name: mini
description: Ask a person, then verify.
nodes:
  - slug: approve
    kind: human
    prompt: Is it right?
  - slug: verify
    kind: command
    command: "true"
  - slug: fix
    kind: agent
    prompt: Reply that nothing is to be fixed.
edges:
  - { from: approve, to: verify }
  - { from: approve, to: fix, when: rejected }
  - { from: verify, to: fix, when: failed }
  - { from: fix, to: approve }
`;

/**
 * A throwaway kodel project (git, one pipeline whose first step is a gate) and a state base of its own.
 * Placed under `parent`, which has to be a folder claude already trusts: the spike never accepts a trust
 * dialog for the person.
 */
export function project(parent) {
  // EKAV_TOP: one fixed folder the person trusted once by hand (`sh trust.sh`); it is emptied and reused,
  // because claude keeps trust by path.
  const fixed = process.env.EKAV_TOP;
  if (fixed) {
    for (const entry of fs.existsSync(fixed) ? fs.readdirSync(fixed) : []) {
      fs.rmSync(path.join(fixed, entry), { recursive: true, force: true });
    }
    fs.mkdirSync(fixed, { recursive: true });
  }
  const top = fixed ?? fs.mkdtempSync(path.join(fs.realpathSync(parent), "ekav-"));
  const root = path.join(top, "project");
  const state = path.join(top, "st");
  fs.mkdirSync(path.join(root, ".kodel/pipelines"), { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(root, ".kodel/pipelines/mini.yaml"), MINI);
  fs.writeFileSync(path.join(root, ".kodel/config.yaml"), "worktree:\n  mode: off\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".kodel/runs\n");
  const git = (...a) => sh("git", a, { cwd: root });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  // `kodel` on the PATH of the agent's shell: the built artifact, as an installed kodel is.
  const bin = path.join(top, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "kodel"), `#!/bin/sh\nexec node ${ARTIFACT} "$@"\n`, {
    mode: 0o755,
  });
  const mcp = JSON.stringify({
    mcpServers: {
      kodel: {
        command: "node",
        args: [ARTIFACT, "--root", root, "mcp", "--no-decisions"],
        env: { KODEL_STATE_DIR: state },
      },
    },
  });
  return { top, root, state, bin, mcp };
}

/** One tool call of the kodel MCP server over stdio, as a client of its own: starts the throwaway run. */
export function mcpCall(p, tool, args) {
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ekav-spike", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n");
  const out = execFileSync(
    "sh",
    ["-c", `(cat; sleep 3) | node "${ARTIFACT}" --root "${p.root}" mcp --no-decisions`],
    { input: `${input}\n`, encoding: "utf8", env: { ...agentEnv(), KODEL_STATE_DIR: p.state } },
  );
  const line = out.split("\n").find((l) => l.includes('"id":2'));
  if (!line) return { raw: out };
  const text = JSON.parse(line).result?.content?.[0]?.text;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text ?? line };
  }
}

export const uuid = () => crypto.randomUUID();

/** The flags of a terminal worker as step 4 of the plan spells them. */
export function workerFlags({ mcp, allowed, denied, sessionId, resume }) {
  return [
    ...(resume ? ["--resume", resume] : sessionId ? ["--session-id", sessionId] : []),
    "--mcp-config",
    mcp,
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    denied.join(","),
    "--model",
    MODEL,
  ];
}

/** The deny list of a worker (claude-worker.ts `workerDenylist`), the commands only. */
export const DENIED = (() => {
  const verbs = [
    "gate*",
    "ack*",
    "seal*",
    "resume*",
    "migrate*",
    "pipeline changes apply*",
    "pipeline proposals apply*",
    "task approve*",
    "agent stop*",
    "agent rm*",
    "agent exec*",
    "agent attach*",
  ];
  const out = ["mcp__kodel__pipeline_decide_gate", "mcp__kodel__pipeline_accept_change"];
  for (const spelling of ["*kodel*", "*main.ts*", "*kodel.js*"]) {
    for (const verb of verbs) out.push(`Bash(${spelling} ${verb})`);
  }
  return out;
})();

export const ALLOWED = ["mcp__kodel", "Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];
