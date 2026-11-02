# Common `Session` interface for long-running processes (TASK-KDJS)

## TL;DR

- Discussion first (AGENTS.md: no code before a clear "go"). **One task, as you decided** (a split would fix the
  contract before the PTY and the commands could show it wrong), built as **three decision records, each with its own
  id, tests, refutation and "go"**: **D-A the Session contract** (interface, pipes adapter, our own PTY holder with
  attach, stored records, environment rule, `stop`/`remove`) - the boundary note is the part about D-A above the `---`;
  **D-B the dialog gate**; **D-C the commands and the TUI**. Order: M0 throwaway spike (3 days) -> D-A/M1 (contract,
  pipes) -> D-B -> D-A/M2 (PTY, attach) -> D-C. The record format is frozen when you say so; until then no beta is cut
  from `main` (an agreement, no script). POSIX only. The user-facing noun is **agent**; the commands are `kodel agent
  start|ls|attach|stop|rm|prune|doctor|exec` (no top-level `run` or `ask`); `start --pipeline <name> <prompt>` runs a
  pipeline, `start <prompt>` asks a question; engine launch commands are built in with an override in `config.yaml`.
- **What changed after your answers:** the two TUI scenarios (a task card starts a pipeline, a question line starts an
  agent) reach the engine as the **initial prompt**, so `send` stays out; commands are one group `kodel agent`;
  engine commands are built in and overridden in `config.yaml` (no new file); PTY is option A (npm installs the prebuilt
  binary, pipes works without it); the release-guard script is gone (you cut betas by hand: an agreement); a hidden
  `agent exec` and a per-milestone list of manual checks let you try it before D-C. History of the eleven critique
  rounds is in "Rejected review findings" and goes out of the committed document at sign-off.
- **What the last critique changed (rounds 13-15, no blocker or critical left):** id shape is checked before any path is built; `forget` is human-only with no adapter method; a start that fails before `ready` rolls its name marker back; one `.mcp.json` rule; the D-B behaviour sentence and manual check are fixed; "second Kodel client" is stated as *partly solved*. The remaining majors are written as rules and tests in "Rules added after round 15" in Risks; the cut candidates (config override, guard scripts) stay your call in decisions 3 and 9.
- **Open for you at the gate:** only decision 4 (WKJ4 on POSIX only; the second-Kodel-client problem stays with WKJ4;
  the realistic in-session socket case accepted by name) and the default engine in decision 3; the rest you answered.
- Cost: large. Risks: the PTY dependency, the attach socket (accepted same-user limits), raw replay, a second
  stored-format family, a change in the MCP server (D-B).

## Decisions needed

Answered by you: one task (C), POSIX first, PTY now with an own holder (option A), no split, M0 first, the session probe (i),
the AGENTS.md paragraph, sessions ignore `storage`, keep all process guards, no release-guard script, a debug command in
M1/M2, and the naming. The person writes the three log entries and assigns the ids. What is still open is marked below.

1. **M0 first (recommended).** A throwaway branch, not merged. It must answer four questions, and its note goes in
   the first PR: (1) do `read`/`attach` belong on the same interface as `wait`/`stop`; (2) do the three records and
   the `O_EXCL` handshake hold for a PTY holder, and which fields did it need; (3) does a **WKJ4-shaped engine step on
   the real pipes adapter** (spec, `start`, `wait`, owner killed mid-run, retry gives one result) work without the
   interface learning about pipelines; (4) is the attach protocol workable with real agents, named: Claude Code in the Terminal app, with versions written in the note; (5) can the holder, the boot pipe and the framed stdin be passed through the intermediate process as the plan says (also: does `claude "/kodel-run ..."` expand the skill as a positional prompt, and does a `--bg` session go on when a background `kodel wait` reports). Each answer is a plain yes or no written by whoever did the
   spike and judged by the person; M0 has a 3-day time box and its code is never copied into D-A; it uses its own `KODEL_STATE_DIR`, so its records and unredacted output never enter the real base; each question is answered yes, no or unknown, and a question not reached in the box is "unknown" (the person extends by one question at a time, never silently). Concretely: Q1 yes = `wait`/`stop`/`attach` live on one interface without a second owner
   mechanism; Q2 yes = the three records and the handshake carry a PTY holder with at most two added fields; Q3 yes = the
   WKJ4-shaped step passes with the session SIGKILLed after `start`, the retry gives one result and the step imports nothing
   from the pipeline engine; Q4 yes = attach, detach and re-attach worked with a real agent for ten minutes. "Unknown" on Q1 or
   Q3 blocks D-A/M1; "unknown" on Q2 or Q4 blocks only M2. M0 has no test and its only falsifier is the person's judgement
   (stated). A "no" changes the
   interface in this plan before D-A; if the boundary note changes, the person rewrites the log entry. Skip M0 and the
   risk is rework inside D-A to D-C. Default: M0 first.
2. *(decided: A; before M2)* **PTY source (you chose A: the user installs nothing, npm fetches the prebuilt binary, and pipes mode keeps working where it is absent): `@lydell/node-pty`, pinned exactly, an `optionalDependency` of `packages/cli`**
   (`@kodel-ai/kodel`; `packages/local` is bundled in), external in the bundle, **loaded before the child is spawned**
   and injected into `packages/local` through an adapter option. Absent -> `capabilities.pty` false and
   `SESSION_MODE_UNSUPPORTED` with an install hint. The PTY holder runs only from the built `dist/kodel.js` on a Node
   >= 22.19 that was checked; from source it needs `bun run build`, else the hint. The Node >= 22.19 check applies to the interpreter that will run
   the holder (the interpreter is `process.execPath` when that is Node, else the first `node` on PATH that passes the check, else the
   hint; PTY never runs under Bun; tested with a Bun-run bundle). M2 has a time box of 5 days for
   the packaging work; past it the person decides to continue or drop PTY; if PTY is dropped, D-C (`agent start`, `agent attach`) is dropped with it and the family ships as D-A/M1 and D-B only (pipes). A required CI job (ubuntu, macos)
   installs the packed artifact and runs a PTY smoke test, checks `spawn-helper` is executable and the licences of the
   installed platform packages. On Windows the required job installs without the optional dependency and `check-artifact.mjs` runs `node dist/kodel.js
   agent stop a_x` expecting `PLATFORM_UNSUPPORTED` (the platform check runs before `requireHuman`). Alternatives: official `node-pty` (compiles on part of the platforms); `script(1)`
   or a python helper (no reliable resize). Default: as recommended.
3. *(decided; before D-C)* **How engines are started: built-in profiles, override in `config.yaml`.** The orchestrator has
   **built-in engine profiles** (argv with `{prompt}` and a pipeline template, for Claude Code and the other supported
   engines), so the user never thinks about how to start an engine. The default engine is Claude Code when it is on PATH,
   else the first built-in one (**please confirm or name another**). An override goes into `config.yaml`, in a block named
   like WKJ4's `engines:` (this task defines only the minimum: per engine an `argv` with one `{prompt}` and an optional
   `{pipeline}` template; WKJ4 extends it). No new file. Compatibility: `configSchema` is `.strict()`, so an older kodel
   fails with `CONFIG_INVALID` on a config that has the block; because the defaults are built in, the block appears only
   for people who override (the way `agents` and `tasks` were added). The block is in the AGENTS.md "do not edit" list
   like `decisions` and `storage`; `kodel agent start` prints the argv it runs every time; an override is used in its
   committed version, and a working copy that differs from HEAD (an untracked `config.yaml` and a repository without a
   HEAD count as differing) prints the diff and asks (the working/committed choice `pipeline_start` already offers). An
   agent that can commit can still change an override (stated; `kodel init` writes no deny rules since commit 314282e and
   this plan does not bring them back). **The prompt:** `kodel agent start [--pipeline <name>] <prompt>`; with
   `--pipeline` the engine gets the profile's pipeline template (Claude Code: `/kodel-run <name> <prompt>`, the skill's own
   grammar; an engine without skills: plain text "Run the pipeline <name> for the task: <prompt>"), without it just
   `<prompt>`. The prompt never begins with `-` (a leading dash gets a fixed neutral prefix) and is one argument, no shell.
   **Your two scenarios:** (1) in the TUI a task card calls `agent start --pipeline <name> <task key>`; (2) the TUI question
   line calls `agent start <text>`; the text is typed by the person, never read from a task file. Default: as stated.
4. *(agreed)* **Deviations from the task text, stated:** (a) the task's `kind` (person or engine) is gone from the spec: the `KODEL_ENGINE` mark on every session plus the `humanOnly` marker (and `origin: cli|host` for `prune`) replace it, so a session of an engine refuses `gate`/`ack`/`seal`/`resume` the same way, and no `kind` inside an attached session is refused (test `tA_human_commands_refuse_in_session`); (b) **`send` is on the interface after all (your call after the M0 spike; this replaces the first form of the deviation):** an optional method gated by `capabilities.send`; pipes writes to the child's stdin; PTY follows the recipe of herdr-core: the text is a bracketed paste only while the program has DEC mode 2004 on (the holder tracks `?2004h/l` in the output), a pause of 200 ms, then Enter as its own write; one input queue per session; `send` refuses a session that is not `running`; it returns the bytes written and promises nothing about a program that does not read (stated limit). No screen parser (decided). A status channel (OSC 7501 or a hook of the engine) is not built; an optional status field is left for D-C or WKJ4. Old wording: (the TUI scenarios use the initial prompt; a person answers an agent's prompt by `attach`; other answered open questions of the task: parallel runs are one worktree per run, tmux is not used because of the own holder, OSC 7501 is not used; input travels only as attach frames; adding `send` later is a compatible addition, a
   new optional method gated by `capabilities.send`);
   (c) "how the TUI shows waits for input and stalled" is answered by deferral: only the fact `lastOutputAt` exists;
   (d) POSIX only: Windows answers `PLATFORM_UNSUPPORTED` (TASK-WKJ4 therefore runs on POSIX only until the Windows
   task lands; please confirm that is acceptable; cost estimate: a Windows holder needs its own identity, job-object breakaway and `taskkill` semantics, roughly the size of the POSIX pipes adapter again, and cannot be proven without a Windows runner in the loop); (e) "how to keep a headless child from becoming a second
   Kodel client" is not solved here (the environment rule covers `KODEL_*` only): it belongs to the WKJ4 rebase task.
   **Please accept explicitly:** this interface does not prevent a headless child from running its own MCP server and
   `pipeline_*` tools, so "solve them once" is only partly met until that task; D-B closes the dialog half only inside
   the holder's tree.
   So the task is **partly solved** on this point, and the re-scoped body of TASK-KDJS says so in those words.
   These deviations are carried by the re-scoped body of TASK-KDJS and by the three log entries. Default: as stated.
5. *(D-B owns the dialog gate; D-A owns the attach acceptance in the last sentences, confirmed before M2)*
   **Dialogs.** Choose: **(i, recommended) a session probe:** the MCP server shows no gate, resume, pipeline-change or
   `ack` dialog when `KODEL_ENGINE` is set in its environment (even empty) **or** when one of its ancestors (up to 32
   levels, read from the process table) has a parent that is a `session-holder` (the holder is started with the marker argument `--kodel-session-holder`,
   matched in `ps -ww` output so long command lines are not cut; this works for `node …/dist/kodel.js`, `bun
   …/main.ts` and the bundle alike), i.e. it runs inside a
   session tree. **The probe needs no environment and no state base**, because it recognises the holder process itself,
   so a server that `.mcp.json` gave another `KODEL_STATE_DIR` is still recognised. A chain deeper than 32, or unreadable
   (a sandbox may block `ps`), answers "in a session" (fail closed: no dialog, the person decides by command) unless this base has no `run/<uid>` directory at all, i.e. no session was ever started here (then "no", so users who never use sessions keep their dialogs even in a sandbox; a session started under another base is a stated residual); the
   process table is not read when the server's parent is init. On Windows there are no sessions, so the probe answers "not
   in a session" (tested with an injected platform), and in a sandbox that blocks `ps` it fails closed, which means a
   project with `decisions.dialog: true` shows no dialog there and the person decides by command (stated in Behaviour
   change). The probe matters for headless agents in **pipes** sessions as much as for a PTY, so D-B merges before any
   agent-running consumer uses M1 and before M2. On Linux the probe and the identity reader read `/proc` directly (no `ps`, so busybox images work); `ps -ww` is the macOS path. The probe and the environment are injected into the
   server. **(ii)** the environment mark only (smaller, but it fails open for clients that do not pass the variable on;
   the SDK's stdio client passes a short list). The residual of (i) is a client that starts `kodel mcp` outside the
   session's process tree with no variable (accepted, pinned by a test, in refutation). Either way the same-user limits of
   attach remain, **accepted in D-A before the socket exists**: a process of the same user can type into a session's
   input (tool-permission prompts of the agent) - **in particular the agent inside the session, or any tool it runs, can
   open its own session's socket (a predictable path under `~/.kodel/run/<uid>/`) and approve its own tool-permission
   prompts, which the person's `.claude/settings*.json` choices were meant to decide; accepted by name** - for agents
   started by `kodel agent start` this is **weaker than today's
   terminal-plus-variable guard**, and `requireHuman()`'s comment (`cli.ts:298-301`) is updated. The mark `KODEL_ENGINE`
   has two readers (`requireHuman`, the dialog gate) and two writers (`engineEnv`, `sessionEnv`); a further reader needs
   a decision, and every agent started by `kodel agent start` carries the mark, so its whole tree counts as an engine step for
   both readers. Please
   confirm the acceptance. Default: (i).
6. **Classification and the AGENTS.md paragraph** (in the D-A PR): *"Session records (`<state base>/run/`) are
   machine-local state, not history. Their format follows rules 1-5: a `v` on every record, one codec each
   (`decode`, `encode`, `capabilities`) in `pipeline-core/src/sessions/`, a golden fixture taken from a real holder in
   `fixtures/session-formats/`, a newer `v` refused with 'upgrade kodel'; a `decode` is never removed once a published
   version has written the format, and an `encode` only by an explicit decision after the first release. They differ
   from history in one way: records may be removed (`remove`, `kodel agent rm`). Session errors are
   `SessionError` with `SESSION_ERROR_CODES`, outside the MCP error contract. The `t41_*` tests do not cover this
   family; its own tests do. Unlike the run codecs (an allow-list that refuses an unknown field), the family's `decode` ignores unknown optional fields of a known `v`, because builds of different age write one directory; after the freeze the pinned key tables allow none."* Alternative: hold the family to the history rules unchanged (then nothing may delete).
   Default: amend.
7. **Sessions ignore the `storage` key:** records, sockets and nothing else live under the state base (`KODEL_STATE_DIR`
   else `~/.kodel`; not the integrity folder); unwritable -> `SESSION_STATE_UNWRITABLE`. Default: as stated.
8. *(decided: option D)* **The format freeze, in plain words.** The new record format (v1) becomes public the moment a beta
   contains it, and from then on every later kodel must read it as it is. So until you say "frozen" the format counts as
   changeable, and **no beta is cut from `main`**. There is no release-guard script, no `FROZEN` marker file and no hotfix
   ref: you cut betas by hand, so the agreement is yours to keep (if you release earlier, v1 is supported as it is). Before
   you say "frozen" a real-process engine step must have passed against the pipes adapter (`tNN_real_engine_step_passes`)
   and the D-C manual check must have passed; after you say it, every new field bumps `v`. Be clear about what this evidence is: `tNN_real_engine_step_passes` is written by this task and is only a sketch of the WKJ4 consumer (a real process through the public interface, no WKJ4 code). The real WKJ4 rebase may still find a gap and force v2; that is why the freeze is yours to declare after that rebase's first green run, not on the sketch alone.
9. **Process guards you may cut.** `scripts/check-contract-append-only.mjs`, `scripts/check-test-hygiene.mjs`, the
   placeholder-id and task-list scripts, the CODEOWNERS review check and the optional older-beta job protect only this
   family and the test process, are new tooling, and cost a few days; the contract suite, remote-style adapter, parity
   suite and mutants are the tests of refutations (a)-(c) and stay. Default: keep all; say which to drop.

Deferred, with the task that answers it (created only with the person's text after "go"; **only the first three are
created**, the rest are ideas): **Windows** (ConPTY, job objects, identity, case-folding of `KODEL_*`, a Windows CI
branch) - before WKJ4 ships, and until then refutation (b) excludes Windows; **TASK-WKJ4 rebase** (also owns: a
headless engine child must not become a second Kodel client, e.g. started without the project's MCP servers; stopping a
run's sessions when its worktree is discarded, `worktree.ts:257-264`; `labels`); **notifications and `stalled`**. Open for the server task: a remote runner whose agent connects back over HTTP MCP sees
neither the mark nor the ancestor tree, so principle 6 / D-B need an engine-scoped credential carried by the session there
(a stated open question, not solved here).
Ideas, not tasks: a run <-> session link as a run field (not needed: a consumer finds a session again by a
deterministic `name`), retention (owned by the WKJ4 task, which deletes a run's markers and finished host sessions when it deletes the run; this
task exposes no `forget` on the adapter: only the human `kodel agent forget-name` deletes a marker, and WKJ4's retention may delete the markers of a run only through a person's command; until then growth is one small file per attempt, accepted) and `agent prune --force`, a screen parser for replay (only if
the D-C manual check shows glitches a resize does not cure), foreign machine ids across containers (a shared `<base>`
between host and container is a stated limit). OSC 7501 is not used. Parallel runs: each run has its own worktree.

## Behaviour change

D-A (so you can try it by hand from M1): `kodel agent stop <id>`, `kodel agent rm <id>`, `kodel agent ls` (also `kodel agents`)
and the hidden `kodel agent exec [--pty] -- <command>` appear (Windows: "unsupported"); `stop`, `rm` and `prune` ask for a
confirmation and need a terminal, so they cannot be scripted (an engine uses the adapter, not the CLI). `kodel agent
prune` removes finished CLI-started agents (`--force` also host-started ones); `agent forget-name` is hidden, human-only (it refuses under `KODEL_ENGINE`, with a test) and the only way to free a name; no adapter method does it.
D-B: with `decisions: { dialog: true }`, a kodel MCP server that runs inside a session (a holder in its process tree, or `KODEL_ENGINE` set) shows no dialog and answers the
usual `waiting` with the command to decide; the same holds, for a project with `decisions: { dialog: true }`, in a
sandboxed client that cannot read the process table, where the probe fails closed; this is written into `docs/decisions.md` as well, since only the person changes the
`decisions` block). D-C: `kodel agent start [--pipeline <name>] [--engine <e>] [--name n] [--bg] <prompt>` starts the
chosen engine in a PTY session with the prompt as its initial prompt (without `--bg` it attaches at once); `kodel agent attach [id|--name]` (detach with
Ctrl+\\, also under the kitty keyboard protocol); the TUI gets two entries: a task card starts a pipeline (`agent start --pipeline <name> <task key>`) and a question line
starts an agent with your text (`agent start <text>`), plus a "background" tab; `kodel agent doctor` reports
`capabilities.pty`, the Node found and the directory check. `agent start`, `attach`, `stop`, `rm`, `prune`, `exec` and `tui`
are for a person at a terminal. `kodel agent start` without `--bg` suppresses dialogs too (a UX cost to confirm at the gate: from another terminal the person decides by command). A `--bg` agent is usable before notifications exist (the person sees "idle for N s" and uses `kodel
wait`/`status`); first-run prompts of the agent block an unattended session and `kodel agent start` says so. Two background
agents work in the same main checkout and only their pipeline steps get worktrees, so other edits can collide (a
stated limit; `kodel agent start` from inside a run's worktree still starts the agent in the project root and `--root` selects
another project). `kodel agent start` cannot make a client pass `KODEL_STATE_DIR`/`KODEL_ROOT` to the agent's MCP server (clients
filter the environment): it refuses to start with the existing "not the same here and in the server"
message **only on a provable mismatch**: `KODEL_STATE_DIR`/`KODEL_ROOT` are set in the shell and the profile reads `.mcp.json` whose kodel server does not set the same. With the variables unset, or a profile that does not read `.mcp.json` (Codex, OpenCode), or no `.mcp.json` (user-scope registration), it prints a note and goes on. One rule, four tests (vars set + no file; vars set + mismatch; vars unset; non-Claude profile). A project whose redaction rules include a custom
`replace` function cannot use sessions (they end `killed/rules_unknown`; WKJ4's engine steps included) until that is lifted.
No change to MCP
tools, pipelines, runs, `engineEnv`'s output or `ERROR_CODES`; `config.yaml` gains an optional engine-override block.

**What you can check by hand, per milestone.** M0: run the spike and read its note (attach with a real agent). M1: `kodel agent
exec -- sleep 600` starts a session; `kodel agent ls` shows it; close the terminal, open another: it is still there; `kodel
agent stop` kills it (and its grandchildren); `kodel agent rm` removes it; kill the starter with `kill -9` and see the session
survive. D-B: with `decisions: { dialog: true }`, no dialog appears inside a session (tried with the hidden `kodel agent exec` running `kodel mcp`-using commands; D-C's agent is not needed). M2: `kodel
agent exec --pty -- bash`, then `kodel agent attach`, detach with Ctrl+\\, attach again, resize the window. D-C: `kodel agent
start --bg "hello"`, `ls`, `attach`; `kodel agent start --pipeline dev TASK-KDJS`; both TUI entries; `kodel agent doctor`.

## Risks and invariants

**The interface** (D-A boundary note; fixed in the decision):

- `Session` knows no pipelines, gates, checks, runs or MCP (import scan, below). `SessionId`: an opaque
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (never `.`, `..` or a leading dot); the local adapter makes `a_` + 9 + `_` + 4 base36 and, before it builds any path, requires exactly that shape (`remove`, `stop`, `status` refuse anything else with `SESSION_NOT_FOUND`, and `remove` removes only a direct child folder of that shape; tests `tNN_session_id_dots_refused`, `..._rm_dotdot_deletes_nothing`). The stored folder is `run/`, the TUI tab is
  "background" (the name `Session` is the task's; `sessions.jsonl` is the hook index).
- `start(spec)`: exactly one of `command`/`argv`; `cwd` (optional in the core spec so a remote runner may omit it; the local adapter requires an absolute one,
  POSIX `/…` or Windows `C:\…`/`\\…` by shape); `env` (credentials travel here as ordinary values over the holder's stdin, never stored; a remote runner supplies its own; names `[A-Za-z_][A-Za-z0-9_]*`, not matching a redaction rule; no `KODEL_*` except
  the four run-context keys); `inheritEnv`; `mode: "pipes"|"pty"`; `size` (pty); `timeoutMs` > 0 (optional, but **required for a detached `origin: host` session**, which is refused without one so a headless agent cannot run forever; `kodel agent start` sessions have none; every session a test starts has a short one, so a SIGKILLed test runner cannot leave a holder for long); optional
  `name` (`[A-Za-z0-9._-]{1,32}`, unique among the sessions of one checkout that still have a directory, created
  atomically); `lifetime: "detached"|"with-starter"` (default detached; `with-starter` keeps the holder's stdin pipe open, with no ppid or init assumption, and makes the
  holder stop the child
  when its starter dies, for tests and short-lived hosts, so a killed test runner leaves nothing behind); the starter
  records `origin: "cli"|"host"` and `parent` (the enclosing session, found by the same ancestor walk as the dialog probe) in
  `session.json`; `stop` on a session first stops the sessions that list it as their parent (after their identity
  checks), so a nested engine step does not outlive its agent. **A consumer that must find a session again after its owner died
  passes a deterministic `name`**: `n` + the first 24 base36 characters of sha256(run id, node, attempt) (25
  characters; the tuple is joined with `\0` as `homeHashKey` does), and looks it up by name; no run-state field is needed.
  **A name is claimed at `start` and never forgotten once a child may have run:** if `start` fails before the holder reports it started the child (spawn failure, `HOLDER_BOOT_FAILED` before `ready`, `STATE_UNWRITABLE`), the starter deletes its own marker and directory (nothing ran, tests per failure path); after `ready`, the marker stays. `start` claims it by exclusively creating the marker
  `<state base>/run/<uid>/<checkoutKey>.names/<name>.json` (a sibling of the session folders, outside the id namespace, so `rm`/`prune` and an id like `names` can never reach it) (`v`, name, id, `started`; written once, by the starter, which also makes two
  concurrent starts atomic); `remove` deletes the session directory and leaves the marker; `start` with a name whose
  marker exists answers `NAME_TAKEN` while its directory exists and `NAME_USED` when it does not. A consumer that
  gets `NAME_USED` (or finds the session `lost`) does **not** re-run the attempt: the step fails and a person decides.
  Only the human `kodel agent forget-name <name>` (with a confirmation) deletes a marker. So a retry can always tell
  "never started" (no directory, no marker) from "started" (a directory or a marker).
- `status(id)`: `{ state: "starting"|"running"|"exited"|"killed"|"lost", exitCode?, reason?, childAlive?,
  lastOutputAt?, attachable?, since }`; `childAlive` is reported in every non-running state (a consumer treats
  `childAlive: true` as unfinished); `reason` for `killed`: `stopped`, `timeout`, `start_late`, `rules_unknown`,
  `dir_removed`.
- `wait(id, {signal, timeoutMs})` returns the status with `timedOut: true` at the bound, rejects on abort, and rejects
  `UNKNOWN` if the directory was removed meanwhile (a consumer reads the result **and journals it durably before** it calls `remove` (a crash between the two leaves the session for the retry to read), and treats
  `UNKNOWN` as a failed step); `tail(id)`; `stop(id)` **never deletes**; `remove(id)` deletes a terminal session's
  directory (and refuses a live one); `list(filter: name|state)` is read-only and marks an unreadable entry
  `unreadable` with its own reason (newer format: "upgrade kodel", or cannot read: the field); `capabilities` (`pty`, `attach`, `outlivesStarter`). PTY only: `read(id, {bytes})` (ANSI stripped, then
  redacted) and `attach(id) -> AttachStream`, a minimal interface over `Uint8Array` (no Node types in core). No file API;
  Session does not redact files a child writes; a consumer never takes `exitCode` or `tail` as proof of a step (a
  same-user process can write them; the checks decide).
- Errors: `SESSION_*` live in `SESSION_ERROR_CODES` with a `SessionError`, **outside** `ERROR_CODES` (the MCP contract,
  pinned at 40, `CONTRACT_VERSION` 4); the CLI maps them to user errors with a compile-time exhaustive map. Codes:
  `UNKNOWN`, `CANNOT_READ` (names the field), `NEWER_FORMAT`, `SPEC_INVALID`, `MODE_UNSUPPORTED`,
  `PLATFORM_UNSUPPORTED`, `IDENTITY_UNKNOWN`, `FOREIGN`, `NAME_TAKEN`, `NAME_USED`, `NOT_ATTACHABLE`, `STATE_UNWRITABLE`, `HOLDER_BOOT_FAILED`.
  A consumer turns a session error into a failed step carrying the session code in its message; no MCP code is added
  here, and if WKJ4 needs one it bumps `CONTRACT_VERSION` in its own task.
- A remote runner (Kodel Server) implements `start/status/wait/stop/tail/remove`; `cwd`,
  `attachable` and `lastOutputAt` are optional in the core types, while `name` (lookup) and `childAlive` are **required**
  of every adapter because the consumer's retry rule rests on them; a remote runner implements `lookupByName` (required),
  keeps a name used after `remove` (`NAME_USED`), defines the name's scope itself (a project, not a checkout) and has no
  engine-reachable `forget`: a name is freed only by a person (test: the adapter has no such method); it may refuse `inheritEnv` and `mode: "pty"`; its ids
  need only match the opaque grammar; the remote-style test starts a spec without `cwd`. `deriveStatus` and the records
  are the local family. A consumer that meets `NEWER_FORMAT` refuses the step with "upgrade kodel" and does not touch
  the run (failing a run on an upgrade skew is what T-41's refutation counts).
- `runCommand` stays separate **on purpose**; a parity suite pins that the pipes adapter behaves the same (zero special
  cases, counted by a test); moving command nodes belongs to the consumer task.

**What this removes in TASK-WKJ4's stall:** the process that applies an event runs the effect -> the holder owns the
child; owner-gone takeover re-runs up to 10 times -> owner gone is `lost` (final) with `childAlive`, the consumer
decides; `work_finished` cannot carry the result -> `exitCode` + `tail` + files after `wait`; queue/pump/identity ->
identity inside `status`/`stop`.

**Principle 1-2 (untrusted, fail closed).** `status` never closes a step. `deriveStatus(snapshot, now, grace)` is
pure (details below the line). `lost` is final by an `O_EXCL` handshake on `status.json` (the holder reads its input
first, then creates `starting`, or finds the tombstone and exits without spawning); `list`/`ls`/the TUI are read-only and
show a not-yet-final case as `lost` with `presumed: true`; `status`, `wait`, `stop` may create the tombstone. `stop`
checks identity before it writes `stop.json`. `session.json.started` more than 5 minutes in the future is
`CANNOT_READ` with a reason that says the clock is wrong. A reader that cannot read the machine id does not judge `lost`
and writes no tombstone (it shows `presumed`). Limits, stated in the decision: the grace compares wall clocks (sleep or an NTP step can give
`start_late`); a start-time collision inside 1 s; a recycled pid whose identity cannot be read reads `running`
(`wait` has a bound); a hung-but-alive child reads `running`; a socket under a temp directory removed by system
cleanup makes a live session `attachable: false`; closing a terminal or IDE window whose systemd scope is stopped (and
`KillUserProcesses`, ssh logout) kills the holder too (escaping the scope is an idea); a state base on NFS weakens
`O_EXCL` and rename atomicity (unsupported); a shared `<base>` between host and container is not supported
(pid namespaces differ); the files can be written by a same-user agent, which adds no capability a same-user
process lacks.

**Principle 3 (redact at every write path).** `command`/`argv`, `reason` and `tail` are redacted before they are
written; `env` is stored by names only; `cwd`, the checkout root, the machine id, the socket path and `name` are not
redacted because the family lives under the user's own state base and is never copied into history (output of `ls` run
as a command already passes the existing command-output redaction). **No `holder.log`**; an exception the holder can catch is written into `status.json` as `killed/holder_error` with one
redacted line, and one it cannot reads as `lost`. Env values and the redaction
rules reach a holder only through its stdin; a holder that does not know a rule name, and a project rule with a custom
`replace`, spawn nothing and end `killed/rules_unknown`. **Raw bytes never reach disk**: pipes keep a bounded tail; the
PTY holder a 1 MiB in-memory ring; what leaves the holder for a non-attached caller is ANSI-stripped first, then
redacted (pinned by a test); redaction runs over the whole buffer before the tail is cut, with the margin
`runCommand` already uses (`REDACT_MARGIN_BYTES`, `redactCutPrivateKey`), so a secret at the cut cannot leave a suffix; a
consumer that turns `exitCode`, `tail` or files into step results re-redacts with the run's current rules before
anything is journaled; `status.json` is rewritten at most every 5 s while running and at once on a state change.

**Principle 4-5.** `pipeline-core` gets types, codes, `validateSpec`, `deriveStatus`, the pure frame codec, the rule
form and the record codecs; no clock, file, socket, process or PTY. Traits are in `packages/local`; fakes in
`testkit`. `v75e_core_has_no_io_imports` walks `src/` recursively and covers the new files. **The holder's stdio:**
stdout and stderr are `ignore`, stdin is a pipe closed after the input, and the holder's working directory is `/` (never a run worktree that `discard()` removes), it is dispatched early in `main.ts` like `hook`, loads every module it will need before it spawns the child (a branch switch or a removed worktree cannot break it mid-session), and it starts through an intermediate process that exits at once (a double fork, so it is reparented and a
killer that walks the parent-pid tree misses it) in a new session
(`setsid`), so it can neither corrupt an MCP stream (`kodel mcp` is a likely starter) nor keep a pipe of `runCommand` or
`bun test` open.

**Principle 6 (humans decide trust).** One owner of the environment rule, `packages/local/src/engine-env.ts`:
`sessionEnv(base, specEnv)` strips every inherited `KODEL_*`, forces `KODEL_ENGINE=1` (the holder applies the same rule again to the child's environment, so a starter that bypasses `sessionEnv` still gets a marked child; mutant and test `tNN_holder_forces_engine_mark`) (cannot be set, emptied or
removed, also with `inheritEnv: false`), allows only the four run-context keys in `specEnv`; for `kodel agent start` it also
strips an **exact list** of variables that identify a running agent session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`; checked against what `executor.ts:38,175-183` reads) while agent
configuration variables (`CODEX_HOME`, `CLAUDE_CODE_OAUTH_TOKEN`, ...) survive; a pinned list of variables bound to
the starting window is also stripped (`VSCODE_*`, `GIT_ASKPASS`, `TMUX`, `TMUX_PANE`, `KITTY_WINDOW_ID`), while
`SSH_AUTH_SOCK` and `DISPLAY` are kept and die with the window (stated). `engineEnv(step, base)` of the host =
`sessionEnv` + the step's context, **byte-identical output on every platform**. `KODEL_STATE_DIR` and `KODEL_ROOT` are
not in `spec.env`: `kodel agent start` does not pass them at all: it only compares them with
`.mcp.json`'s kodel server env and refuses only on a provable mismatch (the variables are set in the shell and differ from the file); with no `.mcp.json` or for a profile that does not read it (Codex, OpenCode) it prints a note and goes on (see Behaviour change), so the agent's `bun test`,
whose test setup honours an inherited `KODEL_STATE_DIR`, never writes test sessions into the person's real base. A
host-started session takes its base and checkout key from the run's own storage place (passed by the host; in `storage: home` mode `homePlace`
has them, in `project` mode `projectPlace` does not and the base is `resolveBase(env)`: a residual that the WKJ4 consumer
closes by recording the base it used and failing the step on a mismatch, with `sessionBase()` exposed for it), not from the
process environment, so a retry looks where the first attempt looked; the checkout root is normalised with
`realpathSync.native` before it is keyed.
`requireHuman()` is unchanged. Every human-only command named in AGENTS.md plus `agent stop`, `agent rm`, `agent prune`, `agent forget-name`, `agent start`, `agent attach`, `agent exec`, `tui`
refuses under `KODEL_ENGINE` (also with a terminal and with an empty value); the set is derived from a `humanOnly`
marker on the command registry and compared with the "Do not run" list in AGENTS.md (the PRs update that list and its
wording). Nothing a person decides becomes agent-callable; no MCP tool is added; the attach socket carries input, not
decisions. D-B changes only whether a dialog is shown, never what a dialog decides.

**Principle 7-8 and stored data.** Adapters sit behind the interface. Four record kinds, each with `v`: `session.json`
(the starter, once), `status.json` (the holder, or the one-time `lost` tombstone created exclusively by a reader),
`stop.json` (`stop`), the name marker `<checkoutKey>.names/<name>.json` (`start`, once: the name claim; role `starter`, same `v` as its session; a delete of a marker of a newer `v` is refused). `session.json` is written in a temporary directory that
is renamed into place, so `<id>/` exists with a readable `session.json` or not at all; an orphan directory without one is
deleted by `remove` (nothing runs there) and never holds a name. The codec takes a `role` (`starter`, `holder`, `reader-tombstone`, `stop`) and refuses to encode
for a role that does not own the kind; `encode` is an allow-list that refuses an unknown field of its own model;
**`decode` ignores unknown *optional* fields of the same `v`** (so a newer `stop` or tombstone adding a compatible field
does not make an older holder or reader fail: tested both ways); an unknown field next to a missing required field is
still refused; before the freeze a field may be added to v1 only if rule 5's two-way test holds, and after you say "frozen" every addition
bumps `v` (the tolerant decode then serves a v2 reader of v1, not new fields in v1) (an engine that ignores it decides the
same, and an older writer that drops it leaves the newer deciding the same): the key tables pin the field set, so a
change needs the rule-5 note in its PR; no role ever decodes and re-encodes a record it did not write (`remove` and `stop`
add or delete files, never rewrite one: tested), and deleting counts as writing: `remove`, `agent rm` and
`--finished` skip or refuse a session of a newer `v` and an unreadable entry; a record is written in the `v` of its session by any
kodel that knows it, else `NEWER_FORMAT` and nothing is written. Own `SESSION_RECORD_VERSION`, own codec registry,
fixtures `fixtures/session-formats/v1/` taken from the real holders (pipes at D-A/M1, pty at M2; one with odd valid
content), `hashes.json`; the script masks pids, times, paths, the machine id, user names and home directories and the masked file is the fixture that round-trips (a test scans the committed fixtures for generic patterns - UUIDs, absolute home paths, user-name-like segments - plus the values read from the generating environment at generation time; a scan cannot prove absence, stated).
Rule 4 / the freeze: **v1, the interface and the contract cases may change freely until you say the format is frozen** (changing or
removing an existing case needs an approving review by a login in `.github/CODEOWNERS`, which the guard script reads with `gh`; a line in the PR
description would be agent-writable, so none is used); records written before the freeze carry the holder's build id and a reader that finds another build for
a live session treats its identity as `IDENTITY_UNKNOWN` (fail closed) instead of misdecoding; from source under Bun the
build is `unknown` and the stale-build check is skipped (a limit). You say "frozen" only after a real-process engine step (not the fake) has passed against the pipes adapter (`tNN_real_engine_step_passes`) and the D-C manual check has passed, so a WKJ4 rebase that still needs a change happens before any published beta. The attach protocol (`HELLO`/`DATA`/`RESIZE`/`DETACH`/`BYE` and its version) is frozen
with v1 and a later client keeps speaking it; the holder's stdin input carries a version too, refused with a clear message
on a mismatch; a live session across builds is stopped by `kodel agent stop` only when the builds agree (otherwise
`IDENTITY_UNKNOWN`, and the person kills it by hand: stated). There is no release-guard script and no `FROZEN` marker: betas are cut by hand (`workflow_dispatch`), so no beta from
`main` until you say the format is frozen is an agreement, not a mechanism; the frozen set is then what is on `main`, and
any later change to v1 bumps `v`. Errors: newer `v` = "written by a newer kodel, upgrade kodel", a record that does not fit = "cannot read"
naming the field; no hashes, so "was modified" is never used. D-A PR also carries a new `docs/session-formats.md` with its own refutation sentence (not `docs/run-formats.md`, whose
rules are T-41's): a separate
family; an older kodel ignores `<base>/run/`; a holder started before an upgrade keeps old code; the build of the
holder is in `status.json`), `docs/history.md`, and the paragraph of decision 6. `config.yaml` gains only the optional engine-override block of decision 3 (D-C).

**Layout (decision 7).** `<state base>/run/<uid>/<checkoutKey>/<id>/` for records (`checkoutKey(root)` of the project
root, `storage-paths.ts:158`); sockets (M2) at `<state base>/run/<uid>/<id>.sock`, falling back, if that path exceeds
100 bytes, to a short hashed name under `$TMPDIR/kodel-<uid>/` and then `/tmp/kodel-<uid>/`. Nothing is written into the
repository. Every directory used is `lstat`ed: a real directory, owned by the uid, mode 0700, else `start` refuses;
sockets are 0600. A session of another checkout or another machine id (`/etc/machine-id` on Linux, `IOPlatformUUID` from `ioreg -rd1 -c IOPlatformExpertDevice` on macOS, not `kern.uuid`
which is the kernel build's;
unreadable -> neither foreign nor judged: shown as `presumed`, no tombstone) is foreign: listed, never stopped,
attached or judged `lost`. Only the final `run/<uid>` directory and the sockets directory are `lstat`-checked; their
parents are resolved with `realpath` first (macOS `/var` is a symlink). `name` is unique per
checkout; `attach --name` and `agent start --name` look in the current checkout first and in others only with `--all`; `ls`
outside a checkout lists all non-foreign sessions of the user with a checkout column.

### Rules added after round 15 (each with its test; the placeholder `tA_`/`tB_`/`tC_` marks D-A, D-B, D-C)

- **Checkout key:** one normalisation shared by the host and the CLI: `checkoutKey` stays as it is (`resolve()`; the stored `proposalsRoot` must not move) and the session family keys on `checkoutKey(realpath(root))` through one helper used by both; `tA_checkout_key_symlinked_root_same_folder`. Names are folded to lower case before they become a marker (`tA_name_case_folded`).
- **Boot plumbing (M0 question 5, then written):** the starter spawns the intermediate with the boot pipe and the framed stdin pipe; the intermediate spawns the holder detached, passes both pipe ends and exits only after `ready` or `HOLDER_BOOT_FAILED` (10 s bound); `with-starter` keeps the stdin pipe open in the starter. Tests `tA_boot_bound_10s`, `tA_boot_failed_rolls_back_marker`, `tA_state_unwritable_rolls_back_marker`, `tA_marker_stays_after_ready`, `tA_input_explicit_end_vs_starter_died`.
- **`parent`:** recorded only when the parent session is in the same base, else dropped with a note (never `SPEC_INVALID`); the existence check lives in the adapter, not in pure core; a holder pid maps to its id through a lookup by pid in the holder's `status.json`; `tA_parent_other_base_dropped`, `tA_real_suite_under_holder`.
- **Stop:** after the group signal, `stop` walks the process table for descendants by identity and signals them; escapees already reparented to init are a stated limit; `stop` waits past the kill grace so the escalation timer runs; `tA_stop_kills_setsid_grandchild`, `tA_stop_waits_for_escalation`.
- **Build skew:** a consumer that meets `IDENTITY_UNKNOWN` from a build mismatch keeps waiting to its bound and then fails the step as "unknown, a person decides" (never as finished); a source run has build id `dev` (`build-info.ts`) and the check is skipped only when both sides are `dev`; `tA_build_mismatch_unknown`, `tA_build_dev_skips`, `tA_input_version_mismatch_refused`.
- **Fault fields:** the test-only fields are `graceMs`, `statusMinIntervalMs`, `failWrite`; they are accepted only by a separate test holder entry that is never bundled and not reachable from `main.ts`; `tA_fault_fields_rejected_on_built_dist`, `tA_fault_fields_rejected_from_source`.
- **Human commands:** the test walks the whole command registry: every command is `humanOnly` or on an explicit agent-safe allow-list; a mutant that drops a marker is caught; `agent forget-name`, `rm`, `prune` need a terminal and a confirmation (a test per command); `tA_session_interface_has_no_forget`, `tA_holder_forces_engine_mark`, `tA_engine_env_two_readers_two_writers`.
- **Freeze:** one definition: you say "frozen" after `tA_real_engine_step_passes` (written in M1, pipes), the D-C manual check **and** the first green run of the WKJ4 rebase. Cost: no beta from `main` until then, so a format fix that users need can ship only from a release branch cut by hand before D-A/M1 merges, or by making v1 supported as it is (your fallback). Refutations for decisions 6, 7, 8: 6 is wrong if a v1 reader must change to read a later compatible addition; 7 is wrong if a `storage: home` run needs its sessions in its own place; 8 is wrong if a beta with an unfrozen format is published.
- **Built in D-A/M1 beyond the text above:** `send` on the pipes adapter works for a session started with `input: true` (a FIFO in the folder, the holder feeds the child's stdin; without `input` the child's stdin is closed as before); the holder listens for the child's `exit` at once (a child that ended before the holder had recorded it as running was missed); `killTree` is exported from `command.ts` unchanged and `stop` also walks the process table for descendants by identity.
- **After the review of D-A/M1 (built):** `stop` signals nothing without a recorded and matching identity (`IDENTITY_UNKNOWN`); a start that gets no answer in time first writes the `lost` tombstone exclusively, and if the holder was first the session and its name stay; `session.json` redacts `command` too; project rules (patterns) reach the holder, a rule with a function ends `killed/rules_unknown` with no child; the tail is cut after redaction with a margin; liveness checks the recorded identity (a recycled pid is not the session); `decode` is tolerant at every depth and drops an identity method it does not know; the holder validates its input (zod, version, a start time not ahead of its clock by more than 5 minutes) and forces `KODEL_ENGINE=1` itself; the machine id is recorded and a session of another machine is never judged or signalled; `lifetime: "with-starter"` and `parent` answer `UNSUPPORTED` (not built); `ls` shows an unreadable entry with its problem. The code set differs from the plan's list (`NOT_FOUND`, `UNSUPPORTED`, `NOT_RUNNING`, `STILL_RUNNING` added; `MODE_UNSUPPORTED`, `FOREIGN`, `NOT_ATTACHABLE` not yet) and the name grammar is `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.
- **After the second review:** `rm`, `wait` and `stop` refuse a session of another machine (`IDENTITY_UNKNOWN`); `rm` removes an unreadable folder only when no holder of it is alive and refuses a newer one; `ls` shows a session whose status or stop record is unreadable or newer; the input FIFO is made before the child is spawned; `tail.txt` is replaced atomically; `timeoutMs` is capped at 2^31-1 ms; `stop` waits for a `starting` session to record its child, gives descendants a grace and ends the group with SIGKILL; `send` retries a full pipe and never leaves a cut line; a concurrent same-name start is told apart from a used name by a second look at the folder.
- **After the third review:** `stop` decides on the status read after it waited for a `starting` session (it signals once the child is recorded, else answers `NOT_RUNNING`, try again); `status` and `ls` do not judge a session of another machine (`ls` marks it `FOREIGN`); `rm` of an unreadable folder also checks the child and refuses a newer status; the holder kills the child outright on its early exits; a boot-timeout tombstone that cannot be written is treated as a failed start and rolled back. A `send` that finds the pipe full for 5 s may leave part of a line in it (the error says how many bytes were taken); nothing is promised beyond that.
- **Not built in D-A/M1, carried to the next PRs:** the `parent` cascade and `with-starter`; the build-skew check (`IDENTITY_UNKNOWN` for a record of another build); the `runCommand` parity suite and the mutant suite beyond the pure `deriveStatus` table (a mutant for each identity, `O_EXCL` and codec rule); `withSessions()`; the Windows platform job, `check-artifact.mjs` line and the required CI job with `KODEL_REQUIRE_PROCTABLE`; the spec's four run-context `KODEL_*` keys; `docs/history.md`.
- **Lookup:** `lookupByName` is `list({name})` plus a `NAME_USED` answer from `start`; it and `childAlive` are in the portable set and the consumer-shaped test runs on the remote-style adapter too (minus the real SIGKILL). The M1 mutants are only those of M1 code; each later mutant lands with its PR. `KODEL_REQUIRE_PROCTABLE` and a required job land in M1; real-process tests use a generous grace except the `lost` race.
- **`agent start`:** checks that the `kodel-run` skill exists for the profile and tells the person to run `kodel init` if not; passes the task as `/kodel-run <pipeline> <TASK-KEY>` with a line telling the agent to read the task with `task_get`; the key and pipeline name must match their grammars (`tC_prompt_args_grammar`); resolves `claude` to an absolute path and `doctor` says when it is only an alias; a prompt starting with `/` reaches the engine as a slash command (stated limit; a leading dash is refused); the prompt is visible in `ps` (stated limit); `capabilities.pty` is false when the native load fails (musl); Windows installs the optional dependency unused (an `os` filter if the packages allow, else stated).
- **D-B:** inside a session the server's instructions drop the "a dialog may come" rule, pinned by a test; D-B closes sessions only, not a client started outside the tree; the in-session socket acceptance reads "any session's socket"; where a sandbox blocks the state directory or `ioreg`, `wait` ends at its bound with `presumed` and a consumer fails the step as unknown.
- **Smaller items taken as wording or tests:** `SESSION_NOT_FOUND` joins the code list and `holder_error` the reason list; the probe matches the `--kodel-session-holder` argument and has a negative case; zod validates the holder input and the decoded records; the Conventions line is amended with the decision 6 paragraph (tolerance only before the freeze); `sessions.jsonl` and `run/` are named apart in `docs/session-formats.md`; `ls` and `list` skip `*.names` folders and `*.sock`; `ls`/`doctor` print the pid when a session is `IDENTITY_UNKNOWN`; the cgroup machine-id fallback is used only when the path is not `/` and never a user scope (else `unknown`); a default base on NFS is a stated limit that `doctor` reports; project rules reach the holder by name and the built-ins carry their `replace` functions in the holder; `sessionEnv` also strips `TERM_PROGRAM*`; the PTY module loads by dynamic import and the import scan covers `packages/cli`; every test-started session has a short `timeoutMs` (enforced in `withSessions()`); probe tests inject the probe and run from a clean ancestry.

## Acceptance criteria and tests

Each decision record has its own id; names carry `tNN_` with that record's number (the placeholders are renamed at
step 1, once the ids exist; the M2 PTY tests carry D-A's id); `..._x` expands to the row's
prefix. POSIX-only tests use `skipIf(platform)` (a skip shows as a skip); `tNN_*_windows_unsupported` run everywhere
with an injected platform (no Windows CI job is made required for them). **Flake policy:** no sleeps in assertions;
waits use `eventually(fn, {timeoutMs, intervalMs})`; time comes from an injected clock where the unit has one;
real-process tests wait for a readiness file the child writes before they signal anything, and take a small
`graceMs` passed to the holder in its input (no injected clock crosses a process boundary); each (real) test has a
timeout; no retry (`scripts/check-test-hygiene.mjs` fails on a sleep in an assertion, a retry, and a real test without a
timeout); tests that need the process table detect an unreadable one and skip visibly with the reason "process table
not readable (sandbox)", a denied socket bind or `/tmp` write skips the same way with the reason "socket not allowed (sandbox)", so the AGENTS.md test command stays green in a sandbox while the required CI jobs run
unsandboxed; a registry outage reports the older-kodel job as "not run", which blocks the freeze PR only; a flaky
required job is fixed or quarantined only with the person's go; the PTY job has a 15-minute
budget (exceeding it fails the job; CI prints a flake count per job). Evidence that is not a test is signed off on a checklist in the PR description that the person ticks.

**D-A / M1: contract, pipes, records, environment**

| Criterion | Test (mechanism) |
|---|---|
| one table-driven contract suite, one case id per behaviour (start, every `deriveStatus` row, wait: exit / abort / `timedOut` / removed meanwhile, stop idempotency and never-deletes, remove, unknown id, list by name/state, unreadable entry, `childAlive`, refusals), run on the fake, a **remote-style in-memory adapter** (the only test of criterion (c): `start/status/wait/stop/tail/remove`, no pids or files; the subset is the cases tagged `portable` in the case table, tagged by capability flags in `contract-adapters.ts` and reviewed by the person; (c) is stated to be a weak check: an in-memory adapter has no latency or partial failure) and the pipes adapter; real-process cases only on real adapters; adapters are registered in `contract-adapters.ts`; `scripts/check-contract-append-only.mjs` compares case ids with the base branch in later PRs: adding cases and adapters is allowed, removing or changing an existing case needs the person's go | `tNN_session_contract:<case>`, `tNN_remote_style_passes_contract_subset`, `tNN_contract_append_only_guard` (the script has its own test) |
| **criterion (b), consumer-shaped:** a fake engine step in `testkit` on the public interface only (profile builds a spec with the deterministic name, `start`, `wait`, reads `exitCode`/`tail`/a file the child wrote; **the step runs in a real child process that is SIGKILLed mid-run and the retry runs in a new process that finds the session by the same name**: one result and no second run, `remove` after the read) imports nothing from the pipeline engine; `session.ts` and `sessions/*` import nothing about pipelines, gates, checks, runs or MCP (scan with a short allow-list) | `tNN_engine_step_consumer_on_public_interface` with named cases `..._reads_before_remove`, `..._unknown_is_failed_step`, `..._newer_format_refuses_step`, `..._re_redacts_results`, `..._retry_after_remove_does_not_rerun`, `..._holder_dies_step_fails_childalive` (a real holder is killed and the step fails with `childAlive` set), `..._crash_between_remove_and_journal`, `..._killed_during_start_retry_fails_or_starts_once` (the `used.json` marker survives `remove`; `NAME_USED` and a `lost` session fail the step), `tNN_session_name_used_marker_survives_remove`, `tNN_session_module_imports_nothing_pipeline` |
| the suite can fail: `deriveStatus` and the identity compare are injectable (a test seam, accepted); a mutant per `deriveStatus` row is injected into the fake **and the pipes adapter** (and the PTY adapter at M2); mutants for abort and unreadable entries; **an identity compare that always returns true** must turn `stop_checks_identity` and `forged_record` red; **a plain write instead of the `O_EXCL` create** must turn `lost_is_final_race` and `status_create_is_exclusive` red; mutants for `remove` accepting a live session, `stop` deleting a directory, `remove` not writing `used.json` and a missing name-uniqueness check must turn their tests red; one mutant each for the dialog probe (always "no"), the frame codec (length unchecked), the ring bound, the pipes adapter's exit mapping and the append-only guard (always passes) must turn their tests red (each mutant reaches the real holder through a test-only input
field honoured only in a test build and rejected otherwise: `tNN_holder_fault_fields_rejected_outside_test_build`); `sessionEnv` mutants (does not force the mark, passes an unlisted key) and codec mutants (drops a field, accepts a newer `v`) | `tNN_contract_suite_catches_mutants`, `tNN_identity_mutants_are_caught`, `tNN_env_mutants_are_caught`, `tNN_codec_mutants_are_caught` |
| `deriveStatus` over snapshots incl. `grace-1 ms`, `grace`, `grace+1 ms`, the `presumed` case, a future `started` (and its 5-minute threshold at 5:00 minus 1 ms, 5:00 and 5:00 plus 1 ms), an injected clock jumping back and forward; `read`'s `bytes` bound | `tNN_session_status_precedence`, `tNN_session_grace_clock_jump`, `tNN_session_status_fields_and_reasons` (every `reason` value incl. `holder_error`, `since`, and `exitCode` on `killed`) |
| `lost` is final, deterministically: the real holder reads its input before it creates anything; the test starts it with `graceMs` small, **withholds stdin**, waits past the grace, lets a reader create the tombstone, then writes the input; the holder exits without spawning. The reverse order lets the holder win. Both creates cannot succeed; the holder never replaces a tombstone; `ls` writes nothing; `status`/`wait`/`stop` write the tombstone | `tNN_session_lost_is_final_race` (real), `tNN_session_status_create_is_exclusive`, `tNN_holder_never_replaces_tombstone`, `tNN_ls_read_only` |
| `validateSpec` table: one of command/argv; empty argv; relative cwd (POSIX and Windows shapes); `timeoutMs` 0/negative/NaN; non-string env; bad env name; env name a rule matches; unlisted `KODEL_*`; `KODEL_ENGINE`, `KODEL_STATE_DIR`, `KODEL_ROOT` in env; bad `name`; unknown mode; `size` with bad rows or columns, `size` with pipes, pty without `size`; a detached `origin: host` spec without `timeoutMs`; an unknown `lifetime`; `parent` naming an unknown id; `name` of 32 and 33 characters; bad id grammar | `tNN_session_validate_spec` |
| names: the concurrent-start race between two real processes (one wins); a name never frees on `remove` (`NAME_USED`; only `agent forget-name` frees it); the marker lives outside `<id>/`, in the sibling folder `<checkoutKey>.names/`, so uniqueness, `list`, `NAME_TAKEN` (a live directory) and `NAME_USED` (a marker) are never ambiguous; a finished session still holds its name; per-checkout uniqueness; id generation and collision | `tNN_session_name_race`, `..._name_never_frees_on_remove`, `..._used_marker_outside_session_dir`, `..._name_held_until_removed`, `..._name_per_checkout`, `..._id_grammar`, `..._rm_and_prune_never_touch_name_markers` (ids `names` and `x.names` are refused by the grammar; `prune` and `rm` leave the sibling folder intact) |
| `sessionEnv`: strips all `KODEL_*`; forces the mark when the spec sets 0, empty or nothing and with `inheritEnv:false`; only four context keys pass; the exact agent-session list is stripped for `kodel agent start` and `CODEX_HOME`/`CLAUDE_CODE_OAUTH_TOKEN` survive; `engineEnv` output is byte-identical (golden env on every platform) and `hardening.test.ts` passes; an engine-side adapter cannot pass `KODEL_STATE_DIR`/`KODEL_ROOT` while the CLI composition root can | `tNN_session_env_strips`, `..._forces_engine`, `..._inherit_false`, `..._empty_value`, `..._allow_list`, `..._agent_session_vars_stripped`, `..._config_vars_survive`, `..._window_vars_stripped`, `..._mark_reaches_grandchildren` (a shell tool, a subagent and `kodel mcp` started by the child all carry the mark; a child that clears it with `env -i` falls under the same-user limit), `tNN_engine_env_unchanged` (the golden also feeds a mixed-case `kodel_*` and `Path` environment, run on the Windows job), `tNN_state_dir_only_via_cli_option` |
| every human-only command (the AGENTS.md set plus `agent stop`, `agent rm`, `agent exec`; `agent start`, `agent attach`, `agent prune` and `tui` at D-C) refuses under `KODEL_ENGINE`, also with `interactive: true` and an empty value; the set is derived from the `humanOnly` marker and compared with the AGENTS.md "Do not run" list, which the D-A PR wraps in `<!-- humanonly:start -->` / `<!-- humanonly:end -->` anchors that the test parses; the marker is extended as commands are added | `tNN_every_human_command_refuses_in_session` |
| `SESSION_*` codes are a separate set: `errors.test.ts` still pins 40, `CONTRACT_VERSION` and the tools fingerprint are unchanged; the CLI's code map is exhaustive (a type test); every code has a case that raises it (`read` on pipes -> `MODE_UNSUPPORTED`, `attach` on a non-attachable session -> `NOT_ATTACHABLE`, an unreadable identity -> `IDENTITY_UNKNOWN`, ...) and `capabilities` has the expected values per adapter | `tNN_session_codes_outside_mcp_contract`, `tNN_session_error_map_exhaustive`, `tNN_session_each_code_is_raised`, `tNN_session_capabilities_per_adapter` |
| redaction: tail bounded; a secret split across two chunks (the fake streams scripted chunks) redacted in tail, reason and command; env values and rules never reach a file: the real directories are scanned for a secret planted in env, argv, output and a project rule; the holder's redactor equals `redactText`; an unknown rule name and a custom `replace` end `rules_unknown`; ANSI codes between the characters of a secret are stripped before redaction | `tNN_session_tail_bounded`, `..._redaction_across_chunks`, `..._no_secret_on_disk`, `..._rules_roundtrip_equal`, `..._rules_unknown_fails_closed`, `..._ansi_strip_before_redact`, `..._secret_straddles_tail_cut`, `..._multiline_private_key_cut` (a mutant that removes the margin must turn them red) |
| codec: each kind round-trips; fixtures open and come from the real holder; dirs match codecs; key tables complete per kind; newer `v`; "cannot read" names the field; a malformed table gives a mixed `list` with `unreadable` entries; `encode` refuses an unknown field and a wrong role; **`decode` ignores an unknown optional field of the same `v`** and an older holder/reader decodes a record a newer `stop`/tombstone wrote with an added field; `status.json` is replaced atomically; the family is absent from `fixtures/formats/` and the `t41_*` registries | `tNN_session_registry_roundtrip`, `..._fixtures_from_real_holder`, `..._matches_fixture_directories`, `..._key_tables_complete`, `..._newer_format`, `..._cannot_read_names_field`, `tNN_session_list_mixed_malformed`, `tNN_session_encode_allow_list`, `tNN_session_decode_ignores_added_field`, `tNN_session_status_atomic_replace`, `tNN_session_family_outside_formats_and_t41` |
| one writer per kind and role: the codec refuses to encode a record for a role that does not own it; no role decodes and re-encodes a record it did not write (`remove` and `stop` add or delete files, never rewrite one); deleting counts as writing, so `remove`, `agent rm` and `--finished` skip or refuse a session of a newer `v` and an unreadable entry; an unknown optional field of a known `v` is ignored by an older reader (rule 5, both halves, with a synthetic field because there is no older build) | `tNN_session_one_writer_per_record`, `tNN_session_never_reencodes_foreign_record`, `tNN_session_delete_skips_newer_and_unreadable`, `tNN_session_compatible_addition`, `tNN_session_old_writer_drops_field_newer_still_decides` |
| the freeze is an agreement, not a script: `docs/session-formats.md` says "unfrozen until the person says so; no beta from `main`"; the evidence the person asks for before saying "frozen" is `tNN_real_engine_step_passes` and the D-C manual check | review only (no test can enforce a promise not to release) |
| `status`, `doctor` and config loading are unchanged by a tree with `<base>/run/` (golden against a baseline); an optional non-gating CI job installs the last published beta and runs `status`/`doctor` against such a tree | `tNN_unknown_state_ignored_golden`, `tNN_last_beta_ignores_session_state` (optional job) |
| parity with `runCommand`, one case per code: success 0, plain failure, timeout, cannot start (127), killed by signal (128+n), early stdout close, output over the bound (tail bounded), a non-UTF-8 stream; the table has **zero** declared differences (counted) | `tNN_session_parity:<case>`, `tNN_parity_has_no_special_cases`, `tNN_parity_exit_mapping_mutant` (the table covers every `runCommand` code path, enforced mechanically: the `runCommand` suite and the parity table run under coverage and the test fails when a `runCommand` branch is not hit by a parity case) |
| a real holder under a real SIGKILLed starter (after the child's readiness file appears): the child survives, status `running`, `wait` from another process returns the code; the holder entry is **injected**; a holder started from a process whose stdout is a pipe does not hold that pipe (the reader gets EOF) | `tNN_session_outlives_starter` (real), `..._wait_from_other_process` (real), `tNN_holder_does_not_hold_starter_pipes` (real), `tNN_session_outlives_starter_sighup` (real), `tNN_session_outlives_tty_close` (real, a PTY on the starter side; a holder that skips `setsid` must turn both red), `tNN_session_outlives_ppid_tree_kill` (real: a killer that walks the parent-pid tree of the starter leaves the double-forked holder alive) |
| tree kill: the child spawns a grandchild and writes its pid and identity to a file; after `stop` the identity (not just the pid) says gone; idempotent; no-op on an exited session | `tNN_session_stop_kills_tree`, `..._stop_escalates_when_sigterm_is_ignored`, `..._stop_stopped_child`, `..._stop_returns_after_gone`, `..._timeout_kills_tree_by_identity` (the grandchild dies and the reason is `timeout`), `tNN_session_stop_reaches_nested_sessions` (real: `stop` on an outer session also stops a session that lists it as `parent`), `..._stop_twice`, `tNN_kill_tree_reparented_grandchild` |
| identity: the real table reads this process's identity, stable and equal to an independent reading under another `TZ` and locale; a gone pid; a zombie counts as gone; `list` is one batched call with a timeout; method mismatch and unreadable identity refuse and `stop` leaves no `stop.json`; a forged record cannot point `stop` at another process; a foreign machine id is refused, an unreadable one is not called foreign | `tNN_process_table_own_identity`, `..._pid_gone`, `..._zombie_is_gone`, `..._stat_comm_with_parens` (field 22 is parsed after the last `)`), `..._zombie_holder_in_container_is_lost` (a real zombie left by a parent that does not reap), `..._machine_id_fallback`, `..._start_refused_without_any_id`, `..._lstart_ambiguous_dst_hour`, `..._list_batched_with_timeout`, `tNN_session_stop_checks_identity`, `tNN_identity_seam_unreachable_from_input` (the injectable compare cannot be reached from config, env or record content), `..._identity_unreadable_writes_nothing`, `..._forged_record`, `tNN_session_foreign` |
| races and `lost`: the fault point `beforeStatusWrite` (injected-only, accepted as green by construction on the fake); and against a **real** holder: crash between spawn and first status (killed while it blocks reading stdin), `stop` vs a dying holder, `timeoutMs` vs `stop`, the directory removed under a live holder (child stopped, `dir_removed`), `remove` of a live session refused | `tNN_session_lost_*`, `tNN_session_crash_between_spawn_and_record(_real)`, `tNN_session_stop_vs_holder_race(_real)`, `tNN_session_timeout_vs_stop(_real)`, `tNN_session_dir_removed_stops_child`, `tNN_session_remove_live_refused` |
| start: spawn fails (directory removed); a late holder refuses with `start_late`; missing stdin input does the same; `timeoutMs` by the holder after the starter is gone; `lastOutputAt` throttled (at most one rewrite per 5 s, at once on a state change) for both modes (real: the holder takes `statusMinIntervalMs` in its input, 200 ms in the test, and the test counts rewrites; a variant through `runHolder(deps)` cannot catch a wiring error); a failed `status.json` write (ENOSPC/EACCES by fault injection `failWrite`) stops the child and ends the holder | `tNN_session_start_spawn_fails`, `..._start_late`, `..._start_input_missing`, `..._timeout_by_holder`, `..._status_write_throttled`, `..._status_write_failure_fails_closed` |
| `kodel agent stop` on a `lost` session with a live child signals it after the identity check; `agent rm` removes a terminal session; `agent prune` removes finished CLI-started sessions and skips host-started ones (those need `--force`); `ls` and `stop` answer unsupported on Windows | `tNN_session_stop_lost_child`, `..._stop_remove`, `..._stop_refuses_without_terminal`, `..._stop_declined_confirmation_changes_nothing`, `..._stop_refuses_under_engine_mark`, `tNN_m1_windows_unsupported` (the `ls`, `--finished`, `--force`, `--forget` parts and their tests - `tNN_ls_read_only`, `..._stop_finished_skips_host_sessions`, `..._stop_force_removes_host_session`, `..._stop_forget_name` - land in the D-C PR) |
| location: under the state base, follows `KODEL_STATE_DIR`; independent of `storage`; unwritable -> `STATE_UNWRITABLE`; from a worktree the project root's key; nothing written into the repository; every directory refused unless real, owned by the uid, mode 0700; `status`, hash adoption and `seal` do not see it | `tNN_session_paths_follow_state_base`, `..._socket_path_boundary_100_101`, `..._socket_fallback_order`, `..._hashed_socket_names_do_not_collide`, `..._parent_dirs_realpath`, `..._paths_ignore_storage`, `..._state_unwritable`, `..._from_worktree`, `..._base_dir_squatted_refuses`, `tNN_session_writes_nothing_in_repo` |
| the hidden holder: hostile or malformed stdin fails closed; absent from `--help`; runs under the Node artifact and under Bun from source; the built file starts, outlives a killed starter and stops a session on plain Node (on Windows `check-artifact.mjs` expects `PLATFORM_UNSUPPORTED`); a holder with `lifetime: "with-starter"` stops its child when a SIGKILLed starter dies, so a killed test runner leaves nothing behind | `tNN_holder_hostile_input`, `tNN_holder_not_in_help`, `tNN_holder_runs_under_bun`, `tNN_session_lifetime_with_starter`, `check-artifact.mjs` |
| hygiene: `withSessions()` in `testkit` records ids and stops them in `afterEach`, failing on a live process left | `tNN_testkit_with_sessions_cleans_up` |

**D-A / M2: PTY holder and attach** (the required job sets `KODEL_REQUIRE_PTY=1`: a PTY test that would skip then fails; the required jobs also set `KODEL_REQUIRE_PROCTABLE=1` so a runner that blocks `ps` cannot go green silently; it runs on ubuntu and macos and first runs `npm ls @lydell/node-pty`, so a failed install is told apart from an absent dependency)

| Criterion | Test (mechanism) |
|---|---|
| packaging: the packed `@kodel-ai/kodel` installed in a temp dir has the dependency and runs a PTY session; `spawn-helper` is executable; the licences of the installed platform packages pass `check-licenses` | `tNN_pty_optional_dependency_packed`, `..._spawn_helper_executable`, `tNN_ci_workflow_declares_required_jobs` (parses `ci.yml` for the job names and the `KODEL_REQUIRE_*` variables; the required-status list itself is branch protection, a checklist item for the person) |
| injected loader: `packages/local` imports no PTY module (typecheck + import scan); the module is loaded **before** the child spawns; absent -> `capabilities.pty` false and the hint; from source without `dist` the same hint; a Node below 22.19 gets its own refusal naming the version; no Node on PATH likewise | `tNN_pty_loader_injected`, `..._loaded_before_spawn`, `..._optional_dependency_absent`, `..._from_source_needs_build`, `..._node_version_checked`, `..._holder_interpreter_checked`, `..._stale_dist_detected`, `..._pm_install_smoke` (a bun or pnpm global install on ubuntu in the same required job) |
| the PTY adapter passes the same contract table (mutants include it) | `tNN_pty_passes_session_contract` |
| frame codec: round trip, partial frame, oversize length, unknown type fail closed; `HELLO` with another protocol version gets `BYE(version)` | `tNN_attach_frames_roundtrip`, `..._frames_hostile`, `..._version_mismatch` |
| attach on a real PTY: bytes come back; the `HELLO` size reaches the child (`stty size`); `RESIZE` changes it; detach keeps the child; re-attach replays the ring; two clients see the same output, the latest size wins; a client that stops reading (a paused socket) past 4 MiB is dropped and may re-attach (real) | `tNN_pty_attach_echo`, `..._resize_reaches_child`, `..._detach_keeps_child`, `..._reattach_replay`, `..._two_clients`, `..._slow_client_dropped` |
| terminal modes: the holder tracks the agent's mode switches (kitty keyboard push/pop, bracketed paste, mouse, alt screen, cursor, focus) and sends the state on `HELLO` before the ring; with no client the holder answers the probes (DA1, OSC 10/11) with fixed values; the ring is cut mid-escape and mid-UTF-8 and the replay stays decodable; `TERM` is inherited at start (a stated limit when attaching from another terminal app) | `tNN_pty_mode_state_replayed`, `..._probe_without_client`, `..._ring_cut_mid_sequence`, `..._ring_bounded` (the ring never exceeds 1 MiB) |
| the attach client: the chord is recognised in three encodings (byte 0x1c, `CSI 92;5u`, `CSI 27;5;92~`); on detach and on a dropped socket it restores termios **and** emits the resets, proven with a real PTY on the client side; `SIGWINCH` sends `RESIZE` | `tNN_attach_client_chord_encodings`, `..._client_restores_modes`, `..._client_resize` |
| attach privacy: there is no attach key (the socket's 0600 mode in a 0700 directory is the only guard, stated); `send` is not on the interface (an API-surface assertion); a second same-uid client is accepted (pins the accepted limit); socket 0600, removed at the end and by `stop`; a missing socket reads `attachable: false`; the temp-directory fallback is `lstat`-checked | `tNN_session_interface_has_no_send`, `tNN_attach_second_client_accepted`, `tNN_pty_second_client_input_gate_refused` (a second client types `kodel gate` into the PTY and the child's shell tool still refuses), `tNN_pty_socket_modes`, `..._socket_removed`, `..._socket_missing_not_attachable`, `..._tmp_dir_squatted_refuses` |
| principle 6 with a **real PTY**: inside the session every human-only command refuses although a terminal is present; no raw bytes on disk; `read` and `status.json` ANSI-stripped and redacted | `tNN_pty_session_refuses_human_commands`, `tNN_pty_session_dialog_gate_end_to_end` (the PTY variant of D-B's test, with its negative control), `tNN_pty_no_raw_bytes_on_disk`, `..._read_strips_and_redacts` |

**D-B: the dialog gate** (own PR and "go"; it merges after M1 and before M2: needed by headless agents in pipes mode as much as by a PTY)

| Criterion | Test (mechanism) |
|---|---|
| the probe answers "in a session" for `KODEL_ENGINE` set (also empty); for a server whose environment lacks it and whose ancestors include a process whose parent is `kodel session-holder` (a server of **any** checkout and any state base); a chain deeper than 32 levels and an unreadable chain (`ps` blocked, simulated) fail closed (no dialog); the process table is **not read** when the server's parent is init (a spy); an ancestor that is no longer a holder's child (a stale or recycled pid) does not count; a session ending between the probe and the dialog | `tNN_dialog_probe_env`, `..._holder_in_ancestors`, `..._other_checkout_and_base`, `..._depth_cap`, `..._fails_closed`, `..._no_read_under_init`, `..._stale_ancestor`, `..._session_ends_midway`, `..._windows_not_in_session` (injected platform), `..._no_run_dir_unreadable_ps_answers_no`, `..._run_dir_exists_unreadable_ps_fails_closed`, `..._linux_reads_proc_not_ps`, `..._matches_source_and_bundle_spawn` (the marker argument, found in `ps -ww` output for `node …/dist/kodel.js` and `bun …/main.ts` alike) |
| **end to end with a negative control:** the SDK's stdio client with its default environment, inside a pipes-mode session (the PTY variant repeats in M2 under D-A's id; D-B's own PR runs only the pipes variant), with `decisions.dialog: true`: no `elicitation/create` is sent for a gate, a pause, a pipeline change or an `ack`; the same run with the probe injected as "no" **does** send one (the test can fail); a client reparented to init (outside the tree) gets a dialog - pinned as the accepted residual | `tNN_session_dialog_gate_end_to_end`, `..._probe_disabled_control`, `tNN_dialog_probe_orphaned_client_accepted` |
| existing dialog tests pass under an engine step (the probe and the environment are injected); the `waiting` answer shape is unchanged when the dialog is suppressed; `decisions.agent` behaves in a session as outside; the tools fingerprint is unchanged; `kodel gate` typed inside a session is refused with a message that says to decide from another terminal | `tNN_dialog_on_outside_session`, `tNN_dialog_suppressed_answer_shape`, `tNN_decisions_agent_unchanged_in_session`, `tNN_mcp_tool_list_fingerprint_unchanged`, `tNN_gate_refusal_in_session_hint` |

**D-C: commands, engine profiles, TUI** (own PR and "go"; tests first; the format stays unfrozen until you say so)

| Criterion | Test (mechanism) |
|---|---|
| engine profiles: built-in profiles exist for the supported engines and `agent start` works with an empty `config.yaml`; the default engine is Claude Code when it is on PATH, else the first built-in one; an override block in `config.yaml` (argv with one `{prompt}` and an optional `{pipeline}` template, no shell) replaces a profile; a bad override or an unknown key in the block is refused with a message naming the key; an older kodel refuses a `config.yaml` with the block (`CONFIG_INVALID`, stated, pinned by a golden); the AGENTS.md "do not edit" list includes the block; `--pipeline <name>` gives `/kodel-run <name> <prompt>` for Claude Code and the plain-text template for an engine without skills, and without it the prompt is passed as it is; the prompt never begins with `-` (a leading dash gets a fixed neutral prefix) and hostile text stays one argument (no shell); the TUI prompt is typed, never read from a task file; an override is used in its committed version, an untracked `config.yaml` or a repository without HEAD asks, a changed one prints the diff and asks; `agent start` refuses without a terminal when it must ask, then prints the argv | `tNN_engine_profiles_builtin`, `..._default_engine`, `..._override_replaces`, `..._override_invalid`, `..._block_refused_by_older_kodel`, `..._pipeline_prompt_claude`, `..._pipeline_prompt_plain`, `..._prompt_never_starts_with_dash`, `..._tui_prompt_is_typed`, `..._override_committed_vs_working`, `..._override_untracked_asks`, `..._override_no_head_asks`, `..._refuses_without_terminal`, `..._argv_no_shell` |
| `kodel agent start`: starts a `pty` session with `cwd` = the project root (the starter's `KODEL_STATE_DIR`/`KODEL_ROOT` are not assumed to reach the agent's MCP server: `agent start` refuses on a provable mismatch with `.mcp.json` (see Behaviour change); with matching `.mcp.json` env a run is visible to `kodel status` even through the SDK client's default environment; `--root X` lands the agent's runs in X); `--bg` prints the id; without it attaches; a taken `--name` is `NAME_TAKEN`; the unattended-prompt hint is printed; the agent-session variables are stripped | `tNN_agent_start_state_dir_mismatch_refused`, `..._no_mcp_json_refused`, `..._visible_with_mcp_env`, `..._root_option`, `..._bg_and_name`, `..._cwd_is_project_root`, `..._hint` |
| `attach [id\|--name]` resolves the only live session, ambiguity names the choices, `--all` crosses checkouts; `ls` table; `doctor` loads the PTY module and reports present, absent or present-but-broken (a failed load, a missing exec bit on `spawn-helper` with the `chmod` hint; unsupported on Windows regardless), the Node found and the directory check; `kodel tui`, `agent start`, `agent attach` refuse under `KODEL_ENGINE` | `tNN_attach_resolves`, `tNN_ls_table`, `tNN_doctor_session_checks`, `tNN_doctor_pty_broken`, `tNN_tui_refuses_in_session` |
| TUI: the entry hands the tty to the attach client (reader paused, alt screen left, both restored after, also after leaked modes; the harness has a **real PTY on the client side**) and returns to the list; the "background" tab shows state and the age of the last output (no "stalled" wording; `presumed` marked) | `tNN_tui_run_pipeline_entry` (scenario 1: a task card calls `agent start --pipeline <name> <task key>`), `tNN_tui_question_line` (scenario 2: the question line calls `agent start <text>`), `tNN_tui_background_tab` |
| **before you say "frozen" (an acceptance, not a gate):** a synthetic v2 reader reads v1 and a v1 reader shows v2 as `unreadable`; mixed versions in one directory; a real-process engine step on the pipes adapter passes; the older-kodel job (install the last published beta, run `status` against a tree with session records) passes | `tNN_session_skew_new_reads_old`, `..._old_shows_new`, `..._mixed_versions_in_directory`, `..._never_rewrites`, `tNN_real_engine_step_passes` (a real-process engine step on the pipes adapter, not the fake), `tNN_last_beta_ignores_session_state` (a synthetic v2 proves only the codec's own skew logic, not a real v2: stated) |
| Windows: `agent start`/`attach` answer unsupported | `tNN_dc_windows_unsupported` |

**Evidence that is not a test** (a checklist in the PR description, ticked by the person): (1) the M0 note answering the
four questions; (2) the D-C manual check (also the evidence for D-A's refutation (d): D-A counts as implemented when it passes; the freeze PR carries D-C's id and its own go) on this repository with a real agent and terminal - after detach `stty -a`
equals the value before and bracketed paste is off; the chord works under the terminal's keyboard protocol; a resize
redraws the agent; a late attach after the ring wrapped types correctly (five claims; the agent and terminal names and versions are written in the checklist); pass = all five hold; **if it fails, D-C is
not merged and the person decides between revising the protocol and the separate screen-parser idea**; (3) the task
list before and after the task creation (a script prints it; the diff must show three new keys, a TASK-KDJS body that carries deviations (a)-(e), and a notification task whose body records the "waits for input" deferral); (4) the `docs/` and AGENTS.md notes; (5) that an older
kodel ignores `<base>/run/` (an optional job; an older kodel refuses a `config.yaml` with the new block, stated and pinned by a golden); (6) that the updated `requireHuman()`
comment and the 'weaker than today' statement are accurate (read by the person in D-B's PR); (7) each PR's CI run link with the list of skipped tests, ticked before the next go: a
sandboxed local run does not prove the real-process tests.

**Refutation criteria**, per record. **D-A:** (a) a real adapter (pipes or PTY) does not pass the unchanged contract
suite, or the parity table needs a special case; (b) the consumer-shaped test or the M0 WKJ4-shaped step cannot be
written without the interface learning about pipelines, gates, checks or MCP, or TASK-WKJ4 later needs a second
process-owner mechanism (Windows excepted until its own task lands; judged by the person at WKJ4 planning on the
written sketch, not a test); (c) the remote-style adapter cannot pass the
contract subset; (d) a PTY adapter cannot keep the trust mark without changing the interface, or raw replay with the
mode state still needs a screen parser (the manual check); (e) the attach socket lets a same-user process decide
something `requireHuman()` guards, beyond the accepted limits of decision 5. **D-B:** a decision dialog can be answered from a session
other than through the pinned residual (a client outside the process tree with no variable) or the same-user limits.
**D-C:** the manual check fails, or `agent start` executes an uncommitted argv without the person's accept (the committed argv is accepted by commit review; an agent that can commit can change it, a stated limit). If one fails
before the beta that publishes the family, v1 is changed. What no test can show: a real recycled pid, a start-time
collision inside 1 s, "thinking" vs "crashed", a same-user process clearing `KODEL_ENGINE` or connecting to the socket,
a holder surviving logout where the system kills the user's processes, Windows behaviour, the prebuilt on platforms
outside the CI matrix, the kitty chord on terminals outside CI, real agent behaviour under replay, socket modes on
file systems that ignore them, a hung-but-alive child, two kodel builds racing on one folder, a slow CI disk making
the real tests hit `start_late`, `ps` under a changing locale or clock, whether the mode tracker covers every sequence
a real agent uses (only its fixed set), a sandbox that blocks `ps` (the probe then fails closed for every dialog).

Verification commands: `bun run typecheck`, `bun run lint`, `bun test`,
`bun run build && node scripts/check-artifact.mjs`; the CI matrix; the required PTY job.

---

## Steps

1. Plan gate: the person confirms or changes the defaults, writes the three log entries and ids; explicit "go" (first
   for M0, then per PR). A script (enabled only after the ids exist, so M0 and the plan's own PR stay green) fails the build if any `tNN_` placeholder remains in the tests (`tNN_no_placeholder_ids_remain`, run in CI and tested with a fixture that contains a placeholder).
2. With the person's text after "go": create the three tasks (Windows; WKJ4 rebase; notifications and `stalled`), re-scope
   TASK-KDJS's body, comment on TASK-WKJ4 (Windows before it ships; the second-client check is its own; D-B before any agent-running consumer; session codes reach agents only as message text until a contract bump; a `NAME_USED` or `lost` session fails the step, which changes the current meaning of `MAX_TAKEOVERS`; the freeze needs a real WKJ4-shaped step; the journal change for "journal before remove" needs a rule-5 version bump and fixtures); a script
   prints the task list before and after.
3. **M0** (branch, not merged): a pipes holder, a PTY holder, `attach`, `agent start` and a WKJ4-shaped engine step on a draft
   interface; no tests; the note answers the four questions of decision 1; the person reads it before D-A.
4. **D-A / M1** (PR 1), tests first: contract suite and mutants, the consumer-shaped test and import scan, remote-style
   adapter, `validateSpec`, `deriveStatus`, codec, env, human-command table. Then `pipeline-core`
   (`session.ts`, `sessions/`), `packages/local` (`engine-env.ts`, `killTree` extracted from `command.ts`, process
   table, `runHolder(deps)` reading input first, the pipes adapter, paths), `packages/cli` (hidden `session-holder`,
   `stop` with `--remove`, the `humanOnly` marker for the commands that exist; `ls` (read-only, with its test) stays in M1; `agent prune`/`--force`/`--forget`
   and their tests land in the D-C PR), `testkit` (fake, remote-style adapter, fake engine step, `withSessions()`),
   fixtures from the real holder, the hidden debug command `agent exec`, notes, the AGENTS.md paragraph.
5. **D-B** (PR 2, after "go"; merges before any PTY): tests first; the injected probe and the dialog gate in
   `mcp-server.ts`, the `requireHuman` comment.
6. **D-A / M2** (PR 3, after "go"), tests first: packaging, loader, frame, attach, client tests; then the
   optionalDependency, the build's external, the PTY holder on Node (`node` is `process.execPath` when the starter is
   the bundled file, which always runs on Node; a stale `dist` is detected by the build id against `__KODEL_COMMIT__`),
   the socket server, the mode tracker, the attach client, the required CI job (npm packed install required; a bun or
   pnpm global install smoke where available), `check-licenses` over the installed tree, the pty fixture, `agent exec --pty` and `agent attach` for hand checks.
7. **D-C** (PR 4, after "go"): tests first; engine profiles (built-in defaults plus the `config.yaml` override), `kodel agent start`, `attach`, `agent doctor`, the TUI entry and
   tab, the "do not edit" rule, the AGENTS.md list, the manual check by the person and the skew tests with a synthetic v2; then you say whether the format is frozen.

### Design details (read only in doubt)

- **`deriveStatus(snapshot, now, grace)`**, in order: no directory -> `UNKNOWN`; no readable `session.json` ->
  `CANNOT_READ`; newer `v` -> `NEWER_FORMAT`; no `status.json` and `< grace` -> `starting`; `status.json` `starting`
  with the holder alive -> `starting`; `starting` with the holder gone -> `lost`; terminal -> that state; `running` with
  the holder alive -> `running` (also while the child has exited and the holder has not yet written); `running`, holder
  gone: `stop.json` readable -> `killed/stopped`, unparsable -> `CANNOT_READ`, absent -> `lost` with `childAlive`;
  unparsable `status.json` -> `CANNOT_READ`. `grace` is an adapter option (default 30 s); `started` is the starter's wall
  clock and the holder reads the same clock.
- **Boot report (as built in D-A/M1: a file, not a pipe):** the holder writes `boot.txt` in the session folder (a temporary file and a rename) and `start` polls it, bounded at 10 s; an extra stdio pipe was flaky under Bun ("Failed to connect") and has no Windows equivalent. The intermediate passes only stdin and exits at once. Text of the original design follows: the intermediate process of the double fork reports the holder's boot to `start` over a pipe (`ready`, or
  an error text, redacted); `start` waits for it (bounded, 10 s) and returns `HOLDER_BOOT_FAILED` with that text instead of
  leaving the session `starting`. The input to the holder is a framed message with an explicit end (not EOF), so "input
  complete" differs from "starter died".
- **Handshake:** the holder reads its stdin input first (env values, rules, `graceMs`), then checks `now - started <
  grace`; if late it creates nothing and exits; else it creates `status.json` exclusively (`starting`). A reader that
  finds no `status.json` at `>= grace` creates it exclusively as terminal `lost` (`by: reader`), after which the
  holder's create fails and it exits without spawning; the holder replaces `status.json` (temp + `rename`) only after
  checking `by: holder`. A `starting` holder that is alive and whose input does not arrive within the grace ends
  `killed/start_late`. For `pty` a dead holder closes the master and the child gets SIGHUP.
- **Records:** `session.json` (id, name, mode, redacted spec, `started`, checkout root, machine id, socket path, `v`),
  `status.json` (holder and child identity, state, exit, reason, redacted tail, `lastOutputAt`, holder build),
  `stop.json` (by, time, the identity that was checked).
- **Identity:** `{ method: "proc-ticks" | "ps-lstart", value, boot? }`: Linux `/proc/<pid>/stat` field 22 with
  `boot_id`; macOS (and Linux without `/proc`) `ps -o lstart=` with `LC_ALL=C TZ=UTC0` (so the repeated hour of a DST change is not ambiguous), `boot` =
  `kern.bootsessionuuid`, parsed to an epoch, 1 s tolerance;
  compared only within one method, else `IDENTITY_UNKNOWN` (fail closed); a Windows method added later is a compatible
  addition under rule 5. `list` reads all sessions in one batched call
  (`/proc` on Linux; one `ps -p a,b,c` with a 2 s timeout on macOS). A zombie counts as gone: the session `isAlive` is **not** `processIsAlive` of `store.ts:141` (which says a zombie is
  alive) but a new `liveProcess` that reads the process state (`Z` in `/proc/<pid>/stat` field 3, `ps -o stat=` on macOS)
  and treats `Z` as gone; the double-forked holder can become a zombie when PID 1 does not reap (a container without an
  init), and the test creates one. **Machine id fallback:** where `/etc/machine-id` is missing (many container images) the
  id is `boot_id` plus the cgroup path (`/proc/self/cgroup`), which separates containers on one kernel; if even that is
  unreadable, `start` refuses with `IDENTITY_UNKNOWN` rather than create a session no reader could ever judge. On macOS an `ioreg` that is
  blocked (a Seatbelt sandbox) gives the id `unknown`, cached per process, which never marks a session foreign and never
  lets a reader write a tombstone (it shows `presumed`); `wait` polls every 500 ms and the machine id and `ps` results are
  cached for the poll interval. The pipes holder runs under the Node artifact and under Bun from source (both
  tested).
- **Attach protocol:** frames `[type u8][len u32][payload]` (pure codec in core): `HELLO` (client size, protocol
  version), `DATA`, `RESIZE`, `DETACH`, `BYE`. On `HELLO` the holder sends the mode state, then the 1 MiB raw ring, then
  live bytes, and applies the resize (which makes a full-screen agent redraw). A client lagging past 4 MiB is dropped.
  The client puts the terminal in raw mode, detaches on Ctrl+\\ (three encodings) and always restores termios and emits
  the resets.
- **Stop:** checks the holder's and the child's identity, then writes `stop.json`, signals the child's group with
  `killTree` (extracted from `command.ts`, unchanged), never the holder's; the holder writes `killed/stopped`. A holder
  whose directory has disappeared stops its child and exits (`dir_removed`).

## Affected files

- New: `packages/pipeline-core/src/session.ts`, `session-frames.ts`, `sessions/*`; `fixtures/session-formats/v1/*`;
  `scripts/take-session-fixtures.mjs`; in `packages/local/src` `engine-env.ts`,
  `session-paths.ts`, `session-pipes.ts`, `session-pty.ts`, `session-holder.ts`, `attach-server.ts`,
  `process-table.ts`, `session-probe.ts`, `engine-profiles.ts` (built-in profiles and the override reader); in `packages/cli/src` the session commands and the
  attach client, `tui/` additions; `packages/testkit/src/session-fake.ts`, `session-remote-style.ts`,
  `engine-step-sketch.ts`, `contract-adapters.ts`; tests in each package; a CI job for the packed artifact.
- Changed: `packages/local/src/config.ts` (the optional engine-override block, D-C), `packages/local/src/host.ts`, `command.ts` (extract `killTree`), `packages/pipeline-core/src/index.ts`,
  `packages/cli/src/cli.ts` (`humanOnly` marker, commands), `main.ts`, `mcp-server.ts` (the injected probe, D-B),
  `packages/cli/package.json` (optionalDependency), `scripts/build-cli.mjs` (external), `scripts/check-artifact.mjs`,
  `scripts/check-licenses.mjs`, `.github/workflows/ci.yml`, 
  `scripts/check-contract-append-only.mjs`, `scripts/check-test-hygiene.mjs`, the `eventually` helper in `testkit`, the
  placeholder and task-list scripts (all new, and costed in the M1 PR; the append-only and hygiene guards protect this
  family only and may be cut by the person), `.github/CODEOWNERS` (new), `docs/decisions.md` (the dialog behaviour in a session), `docs/run-formats.md` (one sentence: what a run in flight does after D-B and the new refusals), `docs/history.md`,
  `AGENTS.md`.
- Not changed: `.mcp.json`, `.claude/settings*.json`, `.kodel/pipelines/`, `.kodel/config.yaml` except the optional engine-override block (D-C) and its schema entry, the
  `decisions`, `storage`, `project_id` keys, run codecs and `fixtures/formats/`, `requireHuman()` itself,
  `ERROR_CODES`, `CONTRACT_VERSION`, run state, `.gitignore`, `engineEnv`'s output.

## Rejected review findings

- *Split into three tasks* (rounds 4-7, scope): rejected by the person's decision (a split fixes the contract before the
  PTY and the commands can show it wrong; the spec would be reworked afterwards). What the critics wanted is met inside
  one task: three decision records with their own ids, tests, refutation and "go" (D-A, D-B, D-C), an M0 spike with a
  question list, the format frozen only after D-C with a release guard.
- *Ship PTY with the env mark only and drop the probe* (scope): kept as option (ii) of decision 5, not the
  recommendation; the person chooses in D-B's own record.
- *Keep the argv confirmation store* (earlier): dropped (scope, round 7): `run` prints the argv every time.
- *Pid-namespace / foreign-container handling* (earlier gaps vs scope): dropped; a shared `<base>` between host and
  container is a stated limit; the machine-id check stays (cheap).
- *Make a Windows CI job required* (earlier tests): not needed; the unsupported answer is tested on every OS with an
  injected platform.
- *Move `runCommand` onto `Session`*, *rename `Session`*, *make `ls` write the tombstone*, *widen
  `v75e_core_has_no_io_imports`*: rejected as before (consumer task; the task's name; `ls` is read-only; an existing
  decision's test is not changed).
- *A test that the last released CLI ignores the new files*: an optional non-gating CI job and a golden check of our
  side; the rest is argued from `configSchema` and `StoragePlace`.
- *Round 13 (this revision, answering your rejection at the plan gate).* **Taken:** the initial prompt at start instead of
  `send` (the two TUI scenarios), PTY option A, engine profiles built in with an override in `config.yaml` (no new file, aligned
  with WKJ4's `engines:`), the group `kodel agent` with `--pipeline` and `--bg`, ids `a_`, `rm`/`prune`/`forget-name`, the
  hidden `agent exec` for M1/M2, per-milestone manual checks, decision 8 as an agreement without a script, and `kodel agent
  doctor` instead of the non-existent `kodel doctor`. **Dropped because you decided so:** `.kodel/background.yaml`, top-level
  `run` and `ask`, the release-guard script, `FROZEN` and the hotfix ref. **Not changed:** `send` stays off the interface (it
  would be a compatible addition if an engine cannot take a prompt as an argument).
- *Round 12 (answering the eleventh critique).* **Taken:** after `FROZEN` every new field bumps `v`; the
  frozen set needs the person's CODEOWNERS review; the name claim (`start`, exclusive marker, one writer); atomic session
  directory; boot report and framed input; attach protocol frozen with v1; the in-session socket case named; project-mode
  base residual and `sessionBase()`; remote `lookupByName` and name scope; retention owned by WKJ4; one interpreter rule for
  PTY; Windows job install and `check-artifact` command; macOS `unknown` machine id; `kodel agent start` refuses only on a provable mismatch;
  untracked `background.yaml` and no-HEAD asks; M0 observables and which unknowns block; the test rows named in the tables;
  deviations (b) and (e) made explicit; decisions 8 (freeze timing) and 9 (cuttable guards) added. **Not taken:** moving
  `kodel agent stop` out of M1 (it is the interface's human face and M1's `stop` tests use it); a build flag instead of the release
  guard (option C of decision 8, offered); making the older-beta job required before the
  freeze (it is required in the freeze PR, optional before); duplicate test names across PRs (assigned at the id renaming in
  step 1); the server-side engine credential (an open question for the server task).
- *Rounds 10-11.* **Criticals:** the `kodel init` deny rules do not exist (commit 314282e) - the plan
  drops them and states the file is protected by the "do not edit" rule and the committed-version rule only; the zombie
  holder in a container without init - a new `liveProcess` treats `Z` as gone (not `processIsAlive`), and the machine id
  falls back to `boot_id` plus the cgroup or `start` is refused. **Taken (majors/minors):** base and checkout key come from
  the run's own storage place, durable journaling before `remove`, the name marker outside `<id>/`, the tolerant `decode`
  named in the AGENTS.md text, a cheap probe test for users who never started a session, an approving CODEOWNERS review
  instead of a PR-description line, the machine id and user names masked in fixtures, M0 on its own base with yes/no/
  unknown, `timeoutMs` required for host sessions, `parent` for nested sessions, credentials over stdin, a visible skip for a
  denied socket, a Linux probe without `ps`, the foreground `run` UX cost, the Windows holder cost estimate, PTY dropped
  means D-C dropped, `FROZEN` only after a real engine step, holder `cwd` `/` and early dispatch, a prompt that never starts
  with `-`, and the test rows named above. **Not taken:** a build flag instead of the release guard (a flag in the artifact
  would let the unfrozen family into a published beta by mistake; the guard fails the release instead); dropping the
  append-only and hygiene guards (kept, flagged as the person's option); removing the history from the TL;DR (it is
  removed from the committed document with the log entries at sign-off).
- *Round 9: the critical (a retry after `remove` cannot tell "never started" from "started and
  removed") is closed by the name marker that `remove` keeps and `NAME_USED`; the scope critic's
  trimming of M1 is taken for `agent prune`, `agent prune --force` and `agent forget-name` and `origin` use (they move to D-C), the
  `FROZEN` marker is its own final PR, and one identity method per OS stays; not taken: dropping the remote-style
  adapter and the parity suite (they are the only tests of (c) and (a)), a build flag instead of the release
  guard (a flag would hide the family from the tests that need it), and the `humanOnly` marker (kept, extended as
  commands are added). Open majors for the person at the gate: whether WKJ4 on POSIX only is acceptable until the
  Windows task, and whether to escape the systemd scope (an idea, not built).
- *Drop the remote-style adapter, the parity suite, `name`, the foreign machine-id check, the chord encodings, `read`
  with ANSI stripping, the clock-jump tests as "cheap to defer"* (scope, round 8): kept, each with its reason: the
  remote-style adapter is the only test of refutation (c), the parity suite the only test of (a), `name` carries the
  deterministic lookup of criterion (b), the machine-id check is the fail-safe against another host's pids, the chord
  encodings and the mode tracker are what makes detach work in modern terminals (D-A/M2, not the contract), `read` is
  how a non-attached caller sees a PTY, the clock tests pin `lost` finality. Only the confirmation store, the pid
  namespace check and the Windows CI job were dropped (earlier rounds).
- *Make `ls` or the TUI write the tombstone*, *a `humanOnly` stop that cannot be scripted is a defect* (gaps): kept as
  designed and stated in Behaviour change: an engine uses the adapter, a person confirms at a terminal.
- *A state-base-independent session index for the probe* (gaps): replaced by recognising the holder process itself
  among the server's ancestors; no index exists to disagree with the server's base.
- *Round 8, all other findings* are answered above or in the tables: the env and base independence of the probe, the
  deterministic session name and the real-process retry, `lifetime: with-starter`, `origin` and `--force`, the hotfix
  ref and the pinned frozen set, optional `cwd`/`name`/`childAlive` in the core types, the Windows branch of
  `check-artifact`, agents sharing one checkout, `doctor` on a broken PTY module, `.mcp.json`/`KODEL_STATE_DIR`
  mismatch handling, working-vs-committed for `background.yaml`, tolerant `decode` with the rule-5 gate, `FROZEN`
  holding the fixtures' hash, unknown machine id = presumed only, attach acceptance moved to D-A, the consumer's
  re-redaction and tail-cut redaction, a clock-skew reason, `NEWER_FORMAT` in a consumer, the standalone-file pattern in
  AGENTS.md, confirmation for `agent rm`/`--finished`, a fourth reader of `KODEL_ENGINE` needing a decision,
  `docs/session-formats.md` as its own file, D-B before M2, the M0 yes/no and time box, deviations recorded in the
  re-scoped task body and log entries, test renaming at step 1, an append-only contract guard, a real throttle test,
  probe bounds, the five-claim manual check with versions, the required older-kodel job at the freeze, `validateSpec`
  boundaries, per-code and per-adapter tests, a real-process name race, a failed status write, the ring bound.
- Every other finding of round 7 is answered above: the probe over every live session, the release guard, tolerant
  `decode`, `stop` never deletes and `remove`, `childAlive` in every state, a future `started`, the error-class
  deviation and its exhaustive map, the standalone `background.yaml` version, the AGENTS.md wording, the exact
  agent-session variable list, the holder's stdio, instructions vs suppressed dialogs, temp-directory fallback order,
  `AttachStream`, name scope, `doctor` and old deny rules, the 5-second status rewrite, module loaded before spawn,
  the M0 question list and WKJ4-shaped step, the identity mutant, grandchild identity, the deterministic race, the
  readiness-file rule, the negative control and orphan pin, the stale-record case, names of Windows tests, parity extras,
  the zero-exceptions count, checklist sign-off.

- *Round 16 (critique 14, no blocker or critical):* every point is taken into "Rules added after round 15" or into the body, except these, which are not taken: cutting the config override and the guard scripts (decisions 3 and 9 are yours; the skew for an older kodel is stated, and the shape of the block is frozen when WKJ4's `engines:` lands); a hash of the key tables as a freeze guard (the agreement stays, no script, as you chose in decision 8); the CODEOWNERS check stays a decision-9 item to cut together with its test.
- *Round 15:* the id grammar and the local shape check (`.`/`..`), `forget` human-only with no adapter method, the D-B manual check through `agent exec`, the restored D-B behaviour sentence, and "partly solved" for the second-client point are taken. Not taken now: cutting the config override or guard scripts (decisions 3 and 9 are yours); the rest of the majors are listed in the next attempt's text fixes.
- *Round 14 (criticals of round 13):* `ls` (read-only) is back in M1 so the M1 manual check holds; name markers moved to a sibling
  folder `<checkoutKey>.names/` outside the id namespace, with a test that `rm`/`prune` leave it alone; the freeze evidence is stated
  to be a sketch of the WKJ4 consumer, and the freeze is yours to declare after the WKJ4 rebase. Majors taken as text fixes:
  `agent forget-name` in the `humanOnly` list and test; the holder forces `KODEL_ENGINE=1` itself; stale `stop s_x` text.
  Not taken now: cutting guard scripts/mutants (decision 9 is yours).

## Findings in the code

- `packages/local/src/command.ts`: `runCommand` spawns detached (POSIX) with stdio `["ignore","pipe","pipe"]`, merges
  stdout/stderr into a bounded redacted tail; `killTree` signals the group or runs `taskkill /t /f`; no owner apart from
  the caller, no identity, no persistent status.
- `packages/local/src/host.ts:241-258`: `engineEnv` strips `KODEL_*` and sets `KODEL_ENGINE`, `KODEL_RUN_ID`,
  `KODEL_NODE`, `KODEL_ATTEMPT`, `KODEL_WORKDIR`; callers `:2199`, `:3256` pass `inheritEnv: false`;
  `packages/local/test/hardening.test.ts:9,753` test it. `packages/local/src/executor.ts:38,175-183` reads
  `CLAUDE_CODE_SESSION_ID` as `observed-env`.
- `packages/cli/src/cli.ts:300-316`: `requireHuman()` checks `KODEL_ENGINE !== undefined`, then the terminal; commands
  are registered in one `program` (`:372-1605`, `tui` at `:713`). `packages/cli/src/mcp-server.ts:50,73-120`: the dialog
  flag is fixed when the server is built (`dialog = humans !== undefined && options.dialog === true`), `dialogTimeoutFrom`
  takes an environment; `elicit.ts:1-10`: an `accept` is applied as the person's `gate`/`resume`/`pipeline
  changes`/`ack`. The CLI tests strip `KODEL_ENGINE` (`cli.test.ts:166,1133,1415`) because
  `.kodel/pipelines/dev.yaml:169-170` runs `bun test` as an engine step. `packages/pipeline-core/src/mcp/tools.ts:29,79`:
  instruction rule 10 is the dialog rule.
- `packages/pipeline-core/src/errors.ts:1-5,63-64`, `test/errors.test.ts:14`: `ERROR_CODES` is the tool contract, pinned
  at 40; `KodelError.code` is typed `ErrorCode`.
- `packages/cli/package.json`: the published `@kodel-ai/kodel`; `@kodel-ai/local` and `@kodel-ai/pipeline-core` are
  devDependencies bundled by `scripts/build-cli.mjs`; `.mcp.json` runs `bun packages/cli/src/main.ts mcp`;
  `@kodel-ai/local` exports `./src/index.ts` (not loadable by Node). `.github/workflows/release.yml` publishes a beta by
  manual `workflow_dispatch` from `main`.
- `packages/local/src/config.ts:213-266`: `configSchema` is `.strict()`. `storage-paths.ts:158` `checkoutKey(root)`,
  `:190-217` `StoragePlace`; `integrity.ts:39`, `storage-paths.ts:134` use `KODEL_STATE_DIR`; the integrity base
  without it is `$XDG_STATE_HOME/kodel` or `~/.local/state/kodel`; `project-locate.ts:81` uses `KODEL_ROOT`.
- `packages/pipeline-core/test/served.test.ts:124` `v75e_core_has_no_io_imports` walks `src/` recursively;
  `format-codecs.test.ts:649` and `src/formats/registry.ts:15-25` are run codecs only (`CODECS = {1, 2}`).
- `packages/pipeline-core/src/redact.ts:7-12`: `RedactRule` has a `RegExp` and a `replace` function.
- `packages/local/src/store.ts:130-141,186-193,1245`: name guards, `processIsAlive`, the Windows rename retry, stale-lock
  logic. `packages/local/src/worktree.ts:257-264`: `discard()` removes the worktree under a live child.
- `scripts/test.mjs:72` sets a deep per-worker `TMPDIR`; `scripts/test-setup.ts` and `check-artifact.mjs` rely on
  `KODEL_STATE_DIR`; `scripts/check-licenses.mjs` walks `node_modules/.bun` on Linux; CI runs on ubuntu, macos and windows.
- Outside the repository (web, 2026-11): `@lydell/node-pty` 1.1.0 (fork of node-pty 1.1.0-beta14) ships prebuilt
  binaries for macOS and Linux (x64, arm64) and Windows, never compiles at install and fails when no binary matches;
  `Bun.spawn({terminal})` (Bun 1.3.5+) is POSIX-only; the MCP TypeScript SDK's stdio client passes a short default list
  of environment variables to the server it starts.
- `.kodel/tasks/TASK-WKJ4.yaml`: engine profiles; wants Windows and the tree kill of `command.ts`; the first engine-side
  consumer. `notes/research-background-sessions.md` (worktree `notes-background-sessions`): herdr-core's
  holder/core/CLI split and framed attach protocol (HELLO, DATA, RESIZE, a 4 MiB lag limit, Ctrl+\\ detach).
