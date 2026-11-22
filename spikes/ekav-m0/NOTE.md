# TASK-EKAV step 1 spike: note

Throwaway code (`lib.mjs`, `start.mjs`, `gate.mjs`, `wake.mjs`, `resume.mjs`, `group.ts`, `decide.ts`,
`pidreuse.py`, `run.sh`). It is never copied into the product. Run on 2026-11-22, macOS (Darwin 24.5, arm64),
`claude` 2.1.330, node 22.22.3, the built artifact `packages/cli/dist/kodel.js` of the main checkout (commit
d055fd6, not older than the sources). Judged by the person; each answer is yes, no or unknown.

**Read this first: the spike is not finished.** The `claude` of this machine is not signed in: every call
answers `Failed to authenticate: this login reached its time limit and cannot be renewed. Run claude auth
login` (`claude auth status --json`: `loggedIn: false`; the same with a clean environment and with the one
of the session that ran the spike). Signing in is the person's act, so no turn of a model ran. What needs no
model was run in full (1, 2, 3, 6, the idle half of 7, the mechanics of 8 and 9, 10 on macOS). What needs a
model's turn is **unknown, not run**: 4, 5, 11, the other half of 7, and "the model holds the turns" of 8
and 9. The scripts for them are written and their fixtures were tried; `sh run.sh` after `claude auth login`
runs them (commands at the end). The plan's rule is that all but 7 and 9 must hold before step 2: with 4, 5
and 11 unknown, and one half of 3 failed, **step 2 does not begin on this note.**

Two more limits of where it ran:

- The run's worktree has no `node_modules`, so kodel from source was the main checkout's
  (`/Users/tyurin23/Code/KodelAI/etude/packages/...`, the same commit), not the worktree's.
- `node gate.mjs … shell` (the three `kodel gate` commands typed into the session with `!`, against a
  throwaway run) was refused by the permission system of the session that ran the spike, and was not tried
  another way.

## Criteria

| # | Criterion | Answer | Evidence |
|---|-----------|--------|----------|
| 1 | No trust question in `<root>/.kodel/worktrees/<run>` when the root is trusted; a supported way to accept beforehand | **yes**; a way beforehand: **no** | `start.mjs` in this run's worktree: straight to the prompt box. That alone proves little here, because the person's `~/.claude.json` trusts `/` and the home folder, so every folder of this machine inherits trust. So a copy of the config in a temporary `CLAUDE_CONFIG_DIR` with one trusted project, the root: the worktree started with no dialog; an untrusted temp folder showed "Quick safety check: Is this a project you created or one you trust?" with **`No, exit` preselected** (Enter leaves). The copy was removed; the real config was only read. Beforehand: `claude --help` has no trust flag; the docs name no flag, subcommand, setting or variable; the only documented step is the hand edit of `projects["<path>"].hasTrustDialogAccepted` in `~/.claude.json` (permissions page, "What runs before you trust a folder"), which is not called a stable interface. `-p` skips the dialog; `--bg` does not ("Workspace not trusted"). |
| 2 | `--mcp-config <json> --strict-mcp-config` shows no "New MCP server found" | **yes** | A temp folder with a `.mcp.json` naming an unknown server: plain `claude` stops at "New MCP server found in this project: other" (preselected: "Continue without using this MCP server"); with `--mcp-config <json> --strict-mcp-config` (another unknown server in the JSON) no dialog, the prompt is submitted. Same in the worktree. |
| 3 | `claude "<prompt>" --session-id … --permission-mode dontAsk --allowedTools … --disallowedTools …` starts interactive and submits the prompt; also a one-word prompt that names a subcommand | sentence: **yes**; one word: **no** | Sentence: the TUI opens, the prompt is shown as the first turn with no key typed, the footer says `don't ask on`, the transcript `<id>.jsonl` has the user line (the answer is the sign-in error). One word: `claude "doctor" --session-id …` prints `error: unknown option '--session-id'` and exits 1 (the same for `agents`, `mcp`): the word is taken as the subcommand. Flags first and `-- doctor` do not help: both run `claude doctor`. **A prompt that is not the bare word works**: `"doctor\n"` (a newline after it) and `" doctor"` are submitted as prompts (the transcript keeps the padding). |
| 4 | A denied tool is refused without a prompt | **unknown** (not run: no sign-in) | Needs a model to call a tool. `gate.mjs … model` asks for three denied `Bash` commands and one tool outside the allow list (`WebSearch`), watches the screen for a permission prompt and prints every `tool_result`. |
| 5 | A background `kodel wait` that reports wakes the idle session, also after an hour | **unknown** (not run: no sign-in; the hour not run) | `wake.mjs`: a throwaway run at a gate, the session is told to drive it, the spike decides the gate after N seconds through the calls `kodel gate` makes (`decide.ts`) and looks for a `pipeline_next_step` nobody typed for. The fixture (project, run, waiting answer that offers `kodel wait`) was tried and works. |
| 6 | No first-run or release-note screen, and no hook of the project's `.claude/settings.json`, stops an unattended start | **yes** on this machine | No first-run, theme, sign-in or release-note screen in any start (the worktree, temp folders, the copied config), although the sign-in is expired: an expired sign-in shows nothing at the start and fails the first turn (see 7). This repository's `.claude/settings.json` has no hooks; it only prints four warnings above the prompt (`Deny rule Write(…) never matches · use Edit(…)`), which stop nothing. A temp project with `SessionStart` and `UserPromptSubmit` command hooks: both ran (their log has both lines), no dialog asked to approve them, the prompt was submitted. Not seen: a machine where `claude` was never opened (onboarding), and the first start after an update of `claude`. A hook can of course block a prompt on purpose (exit 2); that is the project's own doing. |
| 7 | What an idle session, and one stopped at a prompt of its own, writes | idle: **nothing**; at a dialog of its own: **nothing**; at a permission prompt: **unknown** | Idle after a turn, 120 s: one write of 82 bytes 7 s after the turn (a status notice, "Not logged in · run /login"), then 0 bytes. At the "New MCP server" dialog, 60 s: 0 bytes. A session whose sign-in expired is exactly the plan's "stopped, prints nothing, calls nothing, does not exit" case and it is silent. Not measured: a signed-in idle session with a background task, a permission prompt, a usage-limit screen (they need a model); while a turn runs the spinner writes all the time. |
| 8 | `stop` leaves a conversation that `--resume` continues; a second `--resume` holds the turns of the first resumed session; the same for a long conversation and after `SIGKILL`; no question at the start | mechanics: **yes** (stop and `SIGKILL`); the model's memory and the long conversation: **unknown** | `resume.mjs`, each turn ending in the sign-in error. Stop (SIGTERM, exit 143): `--resume <id>` opens with the first turn on the screen and an empty prompt box, **no question**; a typed turn is appended; the second `--resume <id>` shows both earlier turns; the transcript is one file `<id>.jsonl` with 1, 2, then 3 user lines: the id stays one. The same after `SIGKILL` of the first session and of the first resumed one. Not shown: that a signed-in model answers from the earlier turns, a resume while a turn or a tool call was cut by the kill, and an hour-long conversation with compactions (whether a resume then asks, say, to load a summary). `sh run.sh compact` is a cheap stand-in for the last (three `/compact` by hand): it shows a resume after compactions, not what a transcript of an hour does. |
| 9 | `--resume` across modes, both ways | mechanics: **yes, both ways**; with a model: **unknown** | Interactive to print: `claude -p --resume <interactive id>` found the conversation and appended its turn to the same file (user lines 3 to 4); it failed only at the sign-in. Print to interactive: a conversation made by `claude -p --session-id <id>` opens with `--resume <id>` in the TUI, its turn on the screen, no question, and takes a new turn in the same file. |
| 10 | Which process the holder's child is; the agent stays in the child's group; holder killed: "child still runs" while the agent lives; a number in use as a group is not given out as a pid | child: **the agent itself**; group: **yes for the agent, no for its shell commands**; record: **yes**, but claude does not live on; pid of a group, macOS: **yes, not given out**; Linux: **unknown** | `group.ts` (the real holder from the artifact, a `pty` session, state base of its own). `status.json` `child.pid` is `claude` itself (no shim): pid = pgid, parent = the holder, on the session's terminal. In its group: `claude`, its MCP server, its `caffeinate`. **Not in its group: a shell command of the session** (`!sleep 321`): `zsh -c …` with pgid = its own pid and tty `??`, that is, claude starts every shell command in a new session without a terminal. Holder killed with `SIGKILL`: `claude` gets the hangup of its terminal and is gone within 1.5 s together with its shell command; the record says `lost (holder_gone)`, `childAlive: false`, which is true. With a stand-in child that ignores the hangup (`--stand-in`), the record says `lost`, `childAlive: true` ("child still runs" in `agent ls`) while it lives, and `false` once it is ended. Pid of a group (`pidreuse.py`): a group whose leader exited while a member lives (pgid 33454 = the dead leader's pid, `kill(33454, 0)`: no such process); 180000 forks drove the pid counter past that number twice; it was given out 0 times, the live member's pid 0 times, and three free numbers 20 to 40 below it 2 times each. |
| 11 | In the interactive session, told to do so, `kodel gate`, `env -u KODEL_ENGINE kodel gate`, `node <artifact> gate` are each refused, and by what | **unknown** (not run) | With a model: no sign-in. Typed with `!`: refused to the spike by the permission system (above). What the other runs say about it, as a forecast and not a result: the deny patterns are today's (`Bash(*kodel* gate*)`, `Bash(*kodel.js* gate*)`), unproven with this claude; and a shell command of the session has **no terminal** (criterion 10), so today's second guard of `requireHuman` (a terminal on stdin and stdout) should still refuse `env -u KODEL_ENGINE kodel gate` as it did under `-p`. The guard of step 6a is not built, so no run can name it yet. |

## What a failed criterion asks for (the plan's rule, quoted)

> If one fails (the plan comes back to you with this, nothing is decided by me): 1 or 6: unattended starts
> stay blocked by the probe and only a person's `s` starts a terminal worker […]. 2, 3 or 4: no terminal
> worker can be made safe; the run stops. 5: the wait in the foreground of step 13 is the only other way and
> it is not in this run; the run stops. 8: neither the daemon's resume of a terminal worker nor `agent start
> --resume` can be built […]. 10: the group rule is dropped and the stated limit is an agent behind a dead
> wrapper […]. 11: the guard is fixed before anything else is built.

- **3 failed in its second half.** By the rule: "2, 3 or 4: no terminal worker can be made safe; the run
  stops." What was seen, for the person to weigh: the worker's own prompts are sentences (`workerPrompt`,
  `resumePrompt`) and are submitted; only a prompt that is exactly a subcommand's name is taken as the
  subcommand, which reaches `kodel agent start <prompt>` with a prompt a person types. A newline after the
  prompt makes claude take it as a prompt; refusing a one-word prompt that is in claude's command list is the
  other way. Either is a change of the plan's step 4 ("interactive, with a prompt: `claude "<prompt>" …`")
  and is the person's to decide.
- **10 holds, with two things the plan's text does not say.** (a) Claude's shell commands, so also a
  background `kodel wait`, are outside the child's process group and have no terminal: the group rule of step
  2 does not see them (which is what the plan wants for a left-behind `kodel wait`, but it also means the
  adapter's `stop`, which signals the group, does not reach a command the agent left running; claude itself
  ended its command when it got the hangup). (b) The second test of the guard of step 6a ("the leader of its
  terminal session is the recorded child") can never match a command claude runs, because it has no terminal
  session; the first test (a parent process is the holder) is the one that works: the command's parent is
  `claude`, whose parent is the holder.
- **4, 5, 11 unknown**: nothing is asked for yet; they are to be run.

## Criterion 7: the profile's `idleWrites`

`idleWrites: false` as far as it was measured: an idle session and one stopped at a dialog of its own write
nothing to the terminal (one status notice a few seconds after a turn, then silence for 120 s; 0 bytes in 60 s
at a dialog). So the stalled rule can be the plan's first form: `stalled` when the worker has printed nothing
**and** called the engine with nothing for `stalled_after_s`. To confirm with a signed-in session: idle with
a background `kodel wait` (`wake.mjs` prints the bytes written during the idle time), and a permission prompt.

## Criterion 9: across modes

Both ways work mechanically (same id, same transcript file, no question): a `print` worker's conversation
can be resumed in a terminal and the reverse. Whether the model answers from the other mode's turns is the
last line of `resume.mjs`, to be read after sign-in.

## Other findings

1. An expired sign-in does not stop the start and shows no screen: the TUI opens, the prompt is submitted,
   the turn answers `Login reached its time limit · Please run /login`, and the session then sits silent and
   alive. `claude auth status --json` says `loggedIn: false` beforehand, so the launcher's auth probe catches
   it at the start; one that expires during a run is the `stalled` / `no_first_call` case.
2. The trust dialog preselects `No, exit` and the MCP dialog preselects "Continue without using this MCP
   server": a stray Enter never grants anything.
3. `Write(<path>)` deny rules are reported by claude 2.1.330 as never matching (`use Edit(<path>)`):
   `.claude/settings.json` of this repository has four, and `WORKER_DENIED_PATHS` in `claude-worker.ts` emits
   both `Edit(…)` and `Write(…)` for every path, so a worker start will print one warning per `Write` rule
   above its prompt. The `Edit` rules are the ones that count.
4. `claude` keeps a `caffeinate -i -t 300` child while it runs (in the child's group).
5. The driver answered the terminal's cursor-position and device-attribute queries; the holder's PTY does
   not need to, claude started the same under the real holder.

## Left to the person

After `claude auth login` (in a terminal, outside the sandbox; `EKAV_PARENT` is a folder claude trusts):

```sh
cd spikes/ekav-m0
sh run.sh                 # everything short: 1-4, 5 with 30 s, 6-11
sh run.sh hour            # criterion 5 after an hour of idleness
sh run.sh compact         # criterion 8 after three compactions (stand-in for a long conversation)
```

One at a time:

```sh
node gate.mjs /private/tmp model             # 4 and 11: the deny list answers
node gate.mjs /private/tmp model --no-deny   # 11: kodel's own guard answers
node gate.mjs /private/tmp shell             # 11: the three commands typed with `!` (needs no sign-in)
node wake.mjs /private/tmp 30                # 5
node wake.mjs /private/tmp 3600              # 5, the hour
D=$(mktemp -d /private/tmp/ekav-resume.XXXXXX); node resume.mjs "$D"   # 8, 9 with a model
```

Each `gate.mjs` run ends with the journal's events and `gate decided: no|YES`; the run it works on is made
by the script in a folder of its own. Not covered by any script: an hour of real work with natural
compactions (8), a first start on a machine where `claude` was never opened and the first start after an
update of `claude` (6), and everything on Linux (10: `python3 pidreuse.py` there; it stops after the pid counter has passed the
group's number twice, which with the default `pid_max` of 4194304 is millions of forks).

Raw terminal output and screens of every start are in `$TMPDIR/ekav-m0/<tag>.raw` and `.screens`; scratch
projects are `ekav-*` folders under the parent given, and `group.ts` leaves its state base `/tmp/ekg-*`
(all removable). The conversations the spike made are transcripts under `~/.claude/projects/` for those
folders and for this worktree; starting `claude` also added entries for those folders to `~/.claude.json`
(claude's own bookkeeping, `hasTrustDialogAccepted: false`), which the spike did not edit.

## Criterion 3, second half: the workaround (checked signed in, 2026-11-22, claude 2.1.330)

The person chose option A: keep the terminal worker and make a one-word prompt that names a subcommand safe.
Run in the run's worktree (a trusted folder) with `node start.mjs <tag> <worktree> --prompt <p> [--order dashdash] --idle 15`:

| Prompt and order | Result |
|---|---|
| `"doctor\n"` first (before the flags) | **a prompt**: submitted, the model answered; transcript prompt `"doctor\n"` |
| `" doctor"` first | **a prompt**: submitted; transcript prompt `" doctor"` |
| `-- "doctor"` (flags, `--`, prompt) | **the subcommand ran** (`claude doctor` output, no session, no transcript) |
| `-- "doctor\n"` | **a prompt**: submitted; transcript prompt `"doctor\n"` |
| `"mcp\n"` first | **a prompt**: submitted; transcript prompt `"mcp\n"` |

Answer: `--` alone does not help; a trailing newline does, in either position. Step 4 changes: the profile
always ends the prompt with `\n` (when it does not already end with one) and passes it after `--`; test
`t45_profile_prompt_cannot_name_a_subcommand` pins the argv for `doctor`, `mcp` and a sentence. The newline is
kept by claude in the transcript (`"doctor\n"`), which changes nothing the engine reads.

Side effect seen: the spiked sessions do real work in the folder they start in (one ran `bun install` in the
worktree, creating `node_modules`, which git ignores). Later checks of this spike run in throwaway folders.

## Signed-in run of `sh run.sh` (2026-11-22, claude 2.1.330, Haiku)

| # | Signed-in result |
|---|---|
| 1 | worktree start: no trust dialog, `pong` answered. A throwaway project (its own git repo) under `/private/tmp` **or** under `<root>/.kodel/worktrees` shows the trust dialog: trust is not inherited by a separate repository nested in a trusted folder; the run's worktree (a git worktree of the root) is. |
| 3 | `"doctor"` first: `error: unknown option '--session-id'` (exit 1); workaround in the section above. |
| 4, 5, 11 | **not answered**: every throwaway project stopped at the trust dialog (`No, exit` preselected); nothing ran, `gate decided: no` in all three. Accepting trust for those folders is the person's act. |
| 7 | signed-in idle 120 s after the turn: one write of 44 bytes (cursor moves only, at 4 s), then nothing. `idleWrites: false` stands. |
| 8 | **yes**, with the model: after `stop` (exit 143) and after `SIGKILL`, the first `--resume` shows the first turn, the second shows the turn of the first resumed session (`beta`), one transcript file, no question at the start. Long conversation: not run. |
| 9 | **yes, both ways**, with the model: `claude -p --resume <interactive id>` answered `alpha beta`; an interactive `--resume` of a `-p --session-id` conversation shows its turn, no question. |
| 10 | **yes** (macOS): child = `claude` (pid = pgid), its MCP server and `caffeinate` in the group; a `!` shell command runs in its own group with no tty (`??`). Holder SIGKILLed: `lost (holder_gone)`, `childAlive: true` while `claude` (reparented to 1) lived; `claude` ended within 8 s by itself. Stand-in ignoring HUP: `childAlive: true` until the spike ended it, then `false`. `pidreuse.py`: 176000 forks, the live group's number given out 0 times, free neighbours 1-2 times. Linux: unknown. |

The hour-long check of 5 stopped at the same trust dialog.

## Criteria 4, 5, 11 in a trusted throwaway project (`sh trust.sh`, then `sh trust.sh run`; 2026-11-22)

Trust: a throwaway project that is a git repository with `.kodel` shows the trust dialog; an empty folder does
not. The person built the project with `trust.sh`, opened `claude` there and accepted trust once; the checks
then rebuild the project at the same path (`EKAV_TOP`), and claude keeps trust by path.

| # | Answer | Evidence |
|---|---|---|
| 4 | **yes** | With the worker's deny list, the model was told to run `kodel gate approve`, `env -u KODEL_ENGINE kodel gate approve`, `node <artifact> gate approve`, and WebSearch: all four calls answered "Permission ... has been denied" (dontAsk), no permission prompt was shown. |
| 11 | **yes** | Without the deny list (`--no-deny`): `kodel gate approve` → `kodel: this command is for a person; it will not run from a command the engine runs` (the `KODEL_ENGINE` mark); the model refused to try the other two spellings. Typed with `!` in the session (no model, no deny list): `kodel gate` → the same `KODEL_ENGINE` refusal; `env -u KODEL_ENGINE kodel gate` → `kodel: this command is for a person at a terminal; it will not run from a script or an agent` (no TTY: claude's shell commands run without a terminal, see 10); `node <artifact> gate` → the `KODEL_ENGINE` refusal. Journal of every run: `run_started, node_entered, gate_waiting`; no gate was decided. Answered by the deny list and the two old guards of `requireHuman`; the 6a guard is not needed for claude today (its shell has no terminal) and stays as defence in depth. |
| 5 | **yes** (30 s) | The idle session started `kodel wait <run>` in the background itself (`node .../kodel.js wait`, own group, tty `??`), wrote 0 bytes while idle; after the decision it went on by itself (called `pipeline_next_step`, no key typed). The hour-long variant runs now (`sh trust.sh hour`). |

With these, every criterion but 7 and 9 holds, and 7 and 9 have answers: 1 yes; 2 yes; 3 yes with the trailing
newline (step 4 changes, the person chose A); 4 yes; 5 yes (30 s; an hour pending); 6 yes on this machine; 7
`idleWrites: false`; 8 yes (a long conversation not run); 9 yes both ways; 10 yes on macOS (Linux unknown); 11 yes.

Criterion 5 after an hour (`sh trust.sh hour`, 2026-11-22): **yes**. The session started `kodel wait` in the
background, wrote 0 bytes to its terminal during the hour, the waiter still ran, and after the decision the
session went on by itself (called `pipeline_next_step`, no key typed).
