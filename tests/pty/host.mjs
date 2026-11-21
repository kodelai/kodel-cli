// Hosts real terminals for the tests: Bun (the test runner) cannot host a PTY, plain Node can.
// The PTY module is resolved the way the built kodel's loader resolves it: from the artifact's own place.
//
//   node tests/pty/host.mjs <path to kodel.js>              JSON lines on stdin (commands) and stdout (events)
//   node tests/pty/host.mjs <path to kodel.js> --selftest   opens one terminal, exits 0 when it works
//
// Commands: {op:"ping",n} {op:"spawn",id,file,args,cols,rows,cwd,env} {op:"write",id,data} {op:"resize",id,cols,rows}
//           {op:"kill",id,signal} {op:"pause",id} {op:"resume",id}       (data is base64)
// Events:   {ev:"pong",n} {ev:"spawned",id,pid} {ev:"data",id,data} {ev:"exit",id,exitCode,signal} {ev:"error",id,message}
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PTY_MODULE = "@lydell/node-pty";

/** The module as a kodel at `from` (a file of the installed or built package) would find it. */
export function loadPtyFrom(from) {
  const found = createRequire(resolve(from)).resolve(PTY_MODULE);
  return createRequire(import.meta.url)(found);
}

/**
 * One terminal with a program in it. `onData` gets Buffers. `pause` stops reading the terminal: what the program
 * writes then stays unread, as with a terminal window that does not draw.
 */
export function openTerminal(pty, { file, args = [], cols = 80, rows = 24, cwd, env }) {
  const term = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
    encoding: null,
  });
  return {
    pid: term.pid,
    onData: (listener) => term.onData((d) => listener(Buffer.isBuffer(d) ? d : Buffer.from(d))),
    onExit: (listener) => term.onExit(listener),
    write: (data) => term.write(data),
    resize: (c, r) => term.resize(c, r),
    kill: (signal) => term.kill(signal),
    pause: () => term.pause(),
    resume: () => term.resume(),
  };
}

async function selftest(pty) {
  const term = openTerminal(pty, { file: "/bin/sh", args: ["-c", "echo host-ok; exit 7"] });
  let seen = "";
  term.onData((d) => {
    seen += d.toString("latin1");
  });
  const exit = await new Promise((done) => {
    const timer = setTimeout(() => done(undefined), 10_000);
    term.onExit((e) => {
      clearTimeout(timer);
      done(e);
    });
  });
  if (exit?.exitCode !== 7 || !seen.includes("host-ok")) {
    throw new Error(`the terminal answered exit ${exit?.exitCode} and ${JSON.stringify(seen)}`);
  }
}

function serve(pty) {
  const terms = new Map();
  const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      return say({ ev: "error", message: "not JSON" });
    }
    const { op, id } = command;
    try {
      if (op === "ping") return say({ ev: "pong", n: command.n });
      if (op === "spawn") {
        const term = openTerminal(pty, command);
        terms.set(id, term);
        term.onData((d) => say({ ev: "data", id, data: d.toString("base64") }));
        term.onExit(({ exitCode, signal }) => {
          terms.delete(id);
          say({ ev: "exit", id, exitCode, signal });
        });
        return say({ ev: "spawned", id, pid: term.pid });
      }
      const term = terms.get(id);
      if (!term) return say({ ev: "error", id, message: `no terminal ${id}` });
      if (op === "write") term.write(Buffer.from(command.data, "base64"));
      else if (op === "resize") term.resize(command.cols, command.rows);
      else if (op === "kill") term.kill(command.signal ?? "SIGHUP");
      else if (op === "pause") term.pause();
      else if (op === "resume") term.resume();
      else say({ ev: "error", id, message: `unknown op ${op}` });
    } catch (error) {
      say({ ev: "error", id, message: error instanceof Error ? error.message : String(error) });
    }
  });
  lines.on("close", () => {
    for (const term of terms.values()) {
      try {
        term.kill("SIGKILL");
      } catch {
        // gone already
      }
    }
    process.exit(0);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv[2];
  if (!from) {
    console.error("usage: node tests/pty/host.mjs <path to kodel.js> [--selftest]");
    process.exit(2);
  }
  let pty;
  try {
    pty = loadPtyFrom(from);
    if (process.argv.includes("--selftest")) {
      await selftest(pty);
      process.exit(0);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  serve(pty);
}
