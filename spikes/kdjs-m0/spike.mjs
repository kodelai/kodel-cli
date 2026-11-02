// THROWAWAY spike for TASK-KDJS M0. Never copied into D-A. Own state dir only.
// Commands: start | status | wait | stop | tail | attach | ls | holder | intermediate
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const BASE = process.env.KODEL_SPIKE_DIR;
if (!BASE) {
  console.error("set KODEL_SPIKE_DIR (own base, never the real one)");
  process.exit(2);
}
const dirOf = (name) => path.join(BASE, "run", name);
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const frame = (obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length);
  return Buffer.concat([h, b]);
};

// ---- starter ---------------------------------------------------------------
async function start(name, mode, argv) {
  const dir = dirOf(name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir); // the name claim: exclusive
  } catch {
    return { error: "NAME_TAKEN", dir };
  }
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ v: 1, name, mode, argv }));
  // boot pipe (fd 3 of the intermediate) and framed stdin (fd 0)
  const mid = spawn(process.execPath, [new URL(import.meta.url).pathname, "intermediate", name], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore", "pipe"],
  });
  mid.stdin.write(frame({ name, mode, argv, cwd: process.cwd(), graceMs: 500 }));
  mid.stdin.end(); // spike: explicit end after the input (not with-starter)
  const boot = await new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve("HOLDER_BOOT_FAILED:timeout"), 10000);
    mid.stdio[3].on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        clearTimeout(timer);
        resolve(buf.trim());
      }
    });
    mid.stdio[3].on("end", () => {
      clearTimeout(timer);
      resolve(buf.trim() || "HOLDER_BOOT_FAILED:eof");
    });
  });
  mid.stdio[3].destroy(); // Q5 finding: the starter must close its end, or the holder's copy keeps it alive
  mid.unref();
  return { boot, midPid: mid.pid };
}

// ---- intermediate: spawns the holder with the SAME pipe ends and exits at once
if (process.argv[2] === "intermediate") {
  // fd 0 = framed input pipe, fd 3 = boot pipe, both inherited from the starter
  const h = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, "holder", process.argv[3]],
    {
      detached: true,
      stdio: [0, "ignore", "ignore", 3],
    },
  );
  h.unref();
  process.exit(0);
}

// ---- holder -------------------------------------------------------------------
if (process.argv[2] === "holder") {
  const name = process.argv[3];
  const dir = dirOf(name);
  process.chdir("/");
  const input = await new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const all = Buffer.concat(chunks);
      resolve(JSON.parse(all.subarray(4, 4 + all.readUInt32BE(0)).toString()));
    });
  });
  const boot = (s) => fs.writeSync(3, `${s}\n`);
  let fd;
  try {
    fd = fs.openSync(path.join(dir, "status.json"), "wx"); // handshake: a tombstone makes us exit
  } catch {
    boot("HOLDER_BOOT_FAILED:tombstone");
    process.exit(1);
  }
  const write = (st) => {
    fs.writeFileSync(path.join(dir, "status.json.tmp"), JSON.stringify(st));
    fs.renameSync(path.join(dir, "status.json.tmp"), path.join(dir, "status.json"));
  };
  fs.closeSync(fd);
  const log = fs.openSync(path.join(dir, "out.log"), "a");
  let child;
  let sock;
  if (input.mode === "pty") {
    // spike-only PTY: python3's pty module as the PTY owner; the holder relays over a unix socket
    const py = `import pty,sys,os,select,socket,fcntl,termios,struct
s=socket.socket(socket.AF_UNIX);p=${JSON.stringify(path.join(dir, "s.sock"))}
s.bind(p);s.listen(1)
pid,fd=pty.fork()
if pid==0:
  os.chdir(${JSON.stringify(input.cwd)});os.execvp(sys.argv[1],sys.argv[1:])
def sz(c,r): fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',r,c,0,0))
sz(80,24)
o=open(${JSON.stringify(path.join(dir, "out.log"))},'ab',buffering=0);cs={};ring=b''
while True:
  x,_,_=select.select([fd,s]+list(cs),[],[])
  if fd in x:
    try: d=os.read(fd,4096)
    except OSError: break
    if not d: break
    o.write(d);ring=(ring+d)[-1048576:]
    for k in list(cs):
      try:k.sendall(d)
      except OSError:del cs[k]
  if s in x:
    k,_=s.accept();cs[k]=b'';k.sendall(ring)
  for k in [k for k in x if k in cs]:
    d=k.recv(4096)
    if not d:
      del cs[k];continue
    buf=cs[k]+d
    while len(buf)>=3:
      t=buf[0];n=struct.unpack('>H',buf[1:3])[0]
      if len(buf)<3+n:break
      q=buf[3:3+n];buf=buf[3+n:]
      if t==0:os.write(fd,q)
      else:
        cc,rr=struct.unpack('>HH',q);sz(cc,rr)
    cs[k]=buf
_,st=os.waitpid(pid,0);sys.exit(os.waitstatus_to_exitcode(st))`;
    child = spawn("python3", ["-c", py, ...input.argv], {
      cwd: input.cwd,
      stdio: ["ignore", log, log],
    });
    sock = path.join(dir, "s.sock");
  } else {
    child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      stdio: ["ignore", log, log],
    });
  }
  write({ v: 1, state: "running", holder: process.pid, child: child.pid, sock });
  boot("ready");
  child.on("exit", (code, signal) => {
    write({ v: 1, state: signal ? "killed" : "exited", exitCode: code, signal });
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    child.kill("SIGKILL");
  });
  setInterval(() => {}, 1 << 30);
} else {
  // ---- readers --------------------------------------------------------------
  const status = (name) => {
    const dir = dirOf(name);
    if (!fs.existsSync(dir)) return { state: "unknown" };
    const f = path.join(dir, "status.json");
    if (!fs.existsSync(f)) {
      return { state: "starting" };
    }
    const st = rd(f);
    if (st.state === "running" && !alive(st.holder)) return { ...st, state: "lost" };
    return st;
  };
  const cmd = process.argv[2];
  const name = process.argv[3];
  if (cmd === "start") {
    const mode = process.argv[4];
    const argv = process.argv.slice(6);
    console.log(JSON.stringify(await start(name, mode, argv)));
  } else if (cmd === "status") {
    console.log(JSON.stringify(status(name)));
  } else if (cmd === "wait") {
    for (;;) {
      const st = status(name);
      if (st.state !== "running" && st.state !== "starting") {
        console.log(JSON.stringify(st));
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } else if (cmd === "stop") {
    const st = status(name);
    if (st.holder && alive(st.holder)) process.kill(st.holder, "SIGTERM");
  } else if (cmd === "tail") {
    process.stdout.write(fs.readFileSync(path.join(dirOf(name), "out.log")));
  } else if (cmd === "attach") {
    // Modes the child switched on in the person's terminal; switched off again on every way out.
    const RESET = [
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l", // mouse tracking
      "\x1b[?1004l", // focus events
      "\x1b[?2004l", // bracketed paste
      "\x1b[?1l\x1b>", // application cursor keys and keypad
      "\x1b[<99u\x1b[>4;0m", // kitty keyboard (pop all) and modifyOtherKeys off
      "\x1b[?1049l\x1b[?47l", // alternate screen
      "\x1b[0m\x1b[?25h", // attributes, cursor visible
    ].join("");
    const exitRaw = (code, why = "session ended") => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`${RESET}\r\n\x1b[7m [${why}: ${name}] \x1b[0m\r\n`);
      process.exit(code);
    };
    const s = net.connect(status(name).sock);
    const send = (t, payload) => {
      const h = Buffer.alloc(3);
      h[0] = t;
      h.writeUInt16BE(payload.length, 1);
      s.write(Buffer.concat([h, payload]));
    };
    const size = () => {
      const p = Buffer.alloc(4);
      p.writeUInt16BE(process.stdout.columns || 80, 0);
      p.writeUInt16BE(process.stdout.rows || 24, 2);
      send(1, p);
    };
    for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => exitRaw(1, "killed"));
    s.on("connect", size);
    process.stdout.on("resize", size);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    s.on("close", () => exitRaw(0));
    s.on("data", (d) => process.stdout.write(d));
    // Ctrl+\ in three encodings: raw byte, kitty CSI-u, xterm modifyOtherKeys
    const chords = [Buffer.from([0x1c]), Buffer.from("\x1b[92;5u"), Buffer.from("\x1b[27;5;92~")];
    chords.push(Buffer.from([0x1d]), Buffer.from("\x1b[93;5u")); // Ctrl+] as a second way out
    // the session may end while an orphan still holds the PTY: leave when the holder says so
    setInterval(() => {
      if (status(name).state !== "running") exitRaw(0);
    }, 500);
    process.stdin.on("data", (d) => {
      if (process.env.KODEL_SPIKE_KEYLOG) {
        fs.appendFileSync(
          process.env.KODEL_SPIKE_KEYLOG,
          `${JSON.stringify(d.toString("latin1"))}\n`,
        );
      }
      if (chords.some((c) => d.includes(c))) {
        s.destroy(); // detach
        exitRaw(0, "detached");
      }
      for (let i = 0; i < d.length; i += 4000) send(0, d.subarray(i, i + 4000));
    });
  } else if (cmd === "send") {
    // no UI: one data frame with the text as a bracketed paste, then Enter as its own frame
    const text = process.argv.slice(4).join(" ");
    const s = net.connect(status(name).sock);
    const send = (t, payload) => {
      const h = Buffer.alloc(3);
      h[0] = t;
      h.writeUInt16BE(payload.length, 1);
      s.write(Buffer.concat([h, payload]));
    };
    s.on("data", () => {}); // replay of the ring, ignored
    s.on("connect", () => {
      send(0, Buffer.from(`\x1b[200~${text}\x1b[201~`));
      setTimeout(() => send(0, Buffer.from("\r")), 400);
      setTimeout(() => process.exit(0), 800);
    });
  } else if (cmd === "text") {
    // a crude reader: drop escape sequences and carriage returns; good enough to see the last lines
    const raw = fs.readFileSync(path.join(dirOf(name), "out.log"), "utf8");
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const csi = new RegExp(`${ESC}\\[[0-9;?<>]*[ -/]*[@-~]`, "g");
    const osc = new RegExp(`${ESC}\\][^${BEL}]*(${BEL}|${ESC}\\\\)`, "g");
    const fwd = new RegExp(`${ESC}\\[([0-9]*)C`, "g"); // cursor forward is how a TUI draws spaces
    const clean = raw
      .replace(fwd, (_, n) => " ".repeat(Number(n || 1)))
      .replace(csi, "")
      .replace(osc, "")
      .replace(/\r/g, "");
    process.stdout.write(
      `${clean
        .split("\n")
        .slice(-Number(process.argv[4] || 30))
        .join("\n")}\n`,
    );
  } else if (cmd === "ls") {
    for (const n of fs.readdirSync(path.join(BASE, "run"))) console.log(n, status(n).state);
  }
}
