# Web UI

`kodel web` serves the runs of a project to a browser: what waits for you, what the agent wrote, the
code it changed, the steps and their checks, and the logs. You can approve, reject (with a reason),
resume a paused step and comment on a step, a file or a line, from a laptop or a phone. It is the same
view and the same decisions as `kodel tui`, and the decisions go through the same checks as
`kodel gate` and `kodel resume`.

## Starting it

```bash
kodel web
```

The server listens on `127.0.0.1:4317`. Open the address it prints. The first time, it also prints a QR
code: scan it (or open the link) to pair the browser. Options:

| Option | What it does |
| --- | --- |
| `--port <n>` | the port (default 4317) |
| `--host <address>` | the address to listen on; `0.0.0.0` for every network interface |
| `--url <address>` | the address the UI is opened at from outside (a TLS proxy, Tailscale Serve); it goes into the QR code, and its host is accepted as the page's origin |
| `--demo` | sample runs instead of this project's; nothing is written |

Ctrl-C stops the server. If your decisions started engine work (a command after a gate, say), it waits
for that work first; a second Ctrl-C stops it.

## Pairing a device

A device (a phone, a browser) is paired once and stays paired until you revoke it.

```bash
kodel web pair
```

prints a one-time code as a QR code and a link. The code works once, for five minutes. Opening it asks
for a name for the device and pairs it: the browser keeps a long random token in a cookie (`HttpOnly`,
`SameSite=Strict`, `Secure` when the address is `https:`). There are no passwords.

```bash
kodel web devices
```

lists the paired devices; `kodel web revoke <id>` unpairs one at once: its next request is refused, and a
page it has open stops getting updates within a few seconds. "Unpair" in the UI does the same for the
device you are on.

`kodel web pair` and `kodel web revoke` need a person at a terminal, like `kodel gate`. `kodel web`
itself can run without one (under a service manager), but then it never prints a pairing code.

## Opening it from another device

The server speaks plain HTTP. Whoever can watch the traffic between your phone and the server can read
your code and take the device's token, so do not open it over the internet without encryption.

### Tailscale (recommended)

[Tailscale](https://tailscale.com) puts your computer and your phone in one private network, with the
traffic encrypted. Nothing is exposed to the internet.

```bash
kodel web --host 0.0.0.0
```

The QR code then points at the computer's Tailscale address (`100.x.y.z`). Install Tailscale on the
phone, sign in to the same account, scan the code.

For an `https://` address and a name instead of an IP, put Tailscale Serve in front instead:

```bash
tailscale serve --bg 4317
```

```bash
kodel web --url https://<machine>.<tailnet>.ts.net
```

### A server with a public IP

Put a TLS proxy in front of Kodel and leave Kodel on `127.0.0.1`. With
[Caddy](https://caddyserver.com), which gets and renews the certificate itself:

```bash
caddy reverse-proxy --from kodel.example.com --to 127.0.0.1:4317
```

```bash
kodel web --url https://kodel.example.com
```

A certificate needs a domain name. Without one, a name like `203-0-113-7.sslip.io` resolves to the
IP `203.0.113.7` and works for Let's Encrypt.

## Starting a task and stopping an agent

Two buttons act on the machine the server runs on, through the same functions as `s` in `kodel tui` and the manager's
tools (`docs/mcp-roles.md`):

- **Start** on a task's card (with a choice of pipeline when there are several) starts the task's run and a background
  agent, as `s` does. It needs no `kodel task approve`, which only holds back what `kodel serve` starts on its own
  (`docs/tasks.md`). The page asks to confirm first; the confirmation is kept by the server, and only a second call that
  names it starts anything. The confirmation lists the warnings that apply (the limits `serve.max_runs` and
  `serve.max_workers`, a task it waits for, a task it conflicts with); a start you confirm goes ahead of exactly those
  and the journal records them (`run_started.origin`, `docs/run-formats.md`). A task that already has a run, a closed
  task and an environment that cannot start it are refused with the reason, with no second step.
- **Stop agent** in the head of a run stops the run's background agent, after a confirmation, also kept by the server.
  The run is not cancelled: it stays open with its task. The agent of a run you are attached to in a terminal
  (`kodel agent attach`) is stopped with its terminal.

Neither button needs a key of `decisions.agent`: those keys (`start_task`, `stop_agent`, `docs/decisions.md`) are for an
agent, and a paired person is not one. The buttons work with the keys off, and the keys do not change them. They are
absent on Windows, where no agents run, and in `--demo`. Every start and stop is printed and appended to the audit log
with the device (`device <id> started <key> (run <run>)`, `device <id> stopped the agent of <run>`, and a line for a
refusal), and the request obeys the rules below (`Origin`, JSON, a paired device).

## Asking the agent about a run

Off by default. Started with

```bash
kodel web --ask
```

a run's screen has an agent button at the top right: a paired device can ask why
the agent did something or what a change does. In Review, tapping lines of a diff picks them; **Ask** adds
them with a note to the next question (several places can wait and go in one question), **Comment** makes
them a comment of the gate. Claude Code only. The question goes to a fork of the Claude Code session
the run was last worked in (`claude -p --resume <session> --fork-session`), started in the directory that
session ran in, so the answer knows the run from the inside; a follow-up continues the same fork. The run's
own session is never touched.

The fork may only read: its tools are `Read`, `Grep` and `Glob` (`--tools`, `--permission-mode dontAsk`),
it has no MCP server (`--strict-mcp-config` with none) and no project settings (`--setting-sources user`,
so no kodel hook), and no `KODEL_*` variable is passed to it. A question cannot change the run or the
files. The question goes to `claude` on stdin, never in its arguments. An answer takes at most five
minutes; one question at a time per run. Every answer is redacted before it leaves the machine. The
threads are kept in `<state base>/web/asks/` and are not part of the run's history.

Each question is a call to the model on the account `claude` is signed in with, and costs tokens. It needs
`claude` on the machine the server runs on, and the run's session log under `~/.claude/projects`. The flag
lets a paired device start a process on this machine, so turn it on knowingly. It is a flag of the server,
not a key of the project config: the config is read by every engine, and an older one refuses a key it
does not know.

## The manager's tools over HTTP (`--mcp`)

`kodel web --mcp` also serves MCP at `/mcp` (Streamable HTTP), so that an agent on another machine can look
after the runs of this one: what waits for you, the history, a gate's changes, the tasks. It serves the
**manager** role only (`docs/mcp-roles.md`): an agent elsewhere works no run, since the files of a run are
here. The decision tools and the two acting tools (`manager_start_task`, `manager_stop_agent`) are served only as far as
`decisions.agent` in the project config allows, as for any manager; a `--read-only` token gets none of them. The keys
`start_task` and `stop_agent` are **the same keys** that gate a manager an agent starts on this machine over stdio: one
setting covers both, so turning one on lets a token holder on another machine start a task without `task approve` (and,
with `force`, past the limits) and stop an agent here. There are no separate keys for the two paths, and none for
`force`. The tools answer `not_ready` where there is no start lock to hold, and on Windows. The audit log names the tool
called, never its arguments.

A client carries a token. A person makes one at a terminal; it is shown once and only its hash is kept:

```bash
kodel web token add --name laptop             # the manager's tools
kodel web token add --name phone --read-only  # only the ones that write nothing
kodel web token ls
kodel web token revoke <id>
```

`token add` prints the line that connects Claude Code on the other machine:

```bash
claude mcp add --transport http kodel https://<address>/mcp --header "Authorization: Bearer <token>"
```

There is no OAuth: a client that can send a header connects (Claude Code, Cursor and the like); a connector
of claude.ai, which needs OAuth, does not yet. The address is the same as the web UI's, so the same advice
holds: Tailscale, or a TLS proxy in front with `--url https://...`. A token sent over plain HTTP on the open
internet can be read on the way.

What protects the endpoint:

- a call without a valid token is refused (`401`); ten wrong tokens from one address in a minute and it is told to
  wait (`429`);
- a session belongs to the token that opened it: another token that names it is told there is no such session;
  a revoked token is refused at its next call, and its open sessions are closed within a minute;
- a request from a page of another site (an `Origin` that is not this server's) is refused;
- at most 32 sessions are open at once, and one left alone for 30 minutes is closed;
- every session opened and every tool called (its name, never its arguments) goes to the audit log.

`--mcp` is refused under `KODEL_ENGINE` and with `--demo`.

## What protects it

- Nothing but the page itself, its script and styles, and `/healthz` answers without a paired device;
  the page shows the pairing screen.
- A device can be added only with a code that `kodel web pair` shows to a person at a terminal; the web
  UI has no way to add one. The codes and tokens are random (128 and 256 bits) and only their hashes
  are kept, in `~/.kodel/web/devices.json` (or under `KODEL_STATE_DIR`), readable by you alone.
- Wrong pairing codes are limited to 10 a minute from one address and 30 a minute in all. Behind a proxy
  on this machine (Caddy, Tailscale Serve) the address is the one the proxy forwards (`X-Forwarded-For`),
  so one client's wrong tries do not lock the others out; that header is believed only from the loopback.
- A write (a decision, a comment, pairing) must come from a page of this server (`Origin`) as JSON, so
  another site cannot make your browser send one.
- The page loads only what this server serves (a strict Content-Security-Policy) and cannot be framed.
  Text from the agent is shown as text, never as markup.
- A decision writes only what was checked for it: the server keeps the checked decision and the device
  that asked, and a device cannot complete another one's.
- The diff, the tasks and the agent's answers are passed through the same redaction as the run history,
  the project's own rules included, before they leave the machine.
- `kodel web` and a person's `kodel web pair|revoke|token` change `devices.json` and `tokens.json` one at a
  time (a lock file beside each), so neither undoes the other's change.
- Each pairing, decision and comment is printed and appended to `~/.kodel/web/audit.log` with the
  device that made it.

Anyone who has your unlocked, paired phone can decide on your runs: revoke a lost device with
`kodel web revoke`.
