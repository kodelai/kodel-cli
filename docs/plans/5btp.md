# TASK-5BTP: executor and engine version in the run history

## Goal

Know which agent client, session and model ran a step, and which engine version a run used, so runs can be
compared by who ran them. Every recorded value carries its source; no value without a source. Nothing is
taken from the agent's own word: client from the MCP handshake, session from the hook or the environment,
model from the session transcript. Switch:
`history.executor` (already in the config, CXSE). With it off nothing of this is recorded.

## Facts found in the repository

- `history.executor.enabled` exists (`packages/pipeline-core/src/history-config.ts`, `packages/local/src/config.ts`)
  and is journalled in `run_started.history` (`run.ts` `start`, ~line 862).
- `PipelineService` (`pipeline-core/src/service.ts:225`) has `engineVersion` only for `pipeline_docs`; it knows
  nothing about the caller. `createServer` (`cli/src/mcp-server.ts:75`) builds one `McpServer` + one service per
  connection, so `server.server.getClientVersion()` is available there, after the handshake.
- `CONTRACT_VERSION = 1` (`pipeline-core/src/mcp/tools.ts:13`), `RECORD_VERSION = 1` (`version.ts`),
  `META_VERSION = 2` (`local/src/store.ts:42`). Tool-surface test: `pipeline-core/test/service.test.ts` ("the tool
  surface", `expect(CONTRACT_VERSION).toBe(1)`) and `docs.test.ts`.
- `packages/cli/package.json` version is `0.0.0`; `scripts/check-artifact.mjs` compares `--version` with it only.
- `agent_completed` is journalled in `run.ts` (~line 747) from the `agent_completed` event; the service calls
  `RunHandle.completeStep(node, attempt, summary, outcome)`.
- **`step_served` does not exist.** The task text says it is built in TASK-V75E, but V75E is order 15 and starts
  after this task (it "depends on TASK-5BTP (executor)"). So this task records the executor on `run_started` and
  `agent_completed` only, and exposes the executor stamp through `RunHandle` so V75E adds it to `step_served`
  with no new plumbing. Stated in the PR description.
- A hook gives `session_id` (`local/src/hooks/session-registrar.ts`); `CLAUDE_CODE_SESSION_ID` as seen by the MCP
  server process is unverified (task says check) — first step of the work is to confirm it empirically.

## Design

Types (pure, `pipeline-core/src/executor.ts`, exported from the index):

```ts
type Source = "observed" | "observed-env" | "observed-hook" | "declared" | "derived";
interface Sourced<T> { value: T; source: Source }
interface ExecutorRecord {            // what one call/step knows about who is acting
  client?: Sourced<{ name: string; version: string }>;   // observed (handshake)
  session?: Sourced<string>;                              // observed-hook | observed-env
  model?: Sourced<string>;                                // derived (transcript of the session)
}
```

- `Caller` = opaque `{ name: string; version: string }`; `PipelineService` takes
  `ServiceOptions.caller?: () => Caller | undefined` (lazy: the handshake happens after construction). The core
  never imports MCP. `mcp-server.ts` passes `() => server.server.getClientVersion()`; `register.ts` stays
  transport-neutral (the optional `caller` is plumbed through `createServer` only).
- Host (`@kodel-ai/local`) adds the session (hook `session_id` when the hook registrar saw one for this
  project/cwd, else `process.env.CLAUDE_CODE_SESSION_ID` → `observed-env`) and the engine record.
- Model: the host finds the session transcript (`transcript_path` from the hook of this session, else the
  session id in the history collector's scope) and takes the model of the last `usage` event
  (`derived`). No transcript or no usage yet: no `model`, never a guess. The agent cannot supply it.
- Sanitising of every string that comes from outside the engine (client name/version from the handshake, session
  id, model from the transcript): strip control characters, cap at 200 chars, run through `redact`; a value
  changed by this is still stored (sanitised), never rejected. `Sourced<T>` is built only by this function.
- `run_started.engine = { version, commit, RECORD_VERSION, META_VERSION, CONTRACT_VERSION, instructions_hash,
  tools_hash }` — all `observed`/derived by the engine itself; `tools_hash` = sha256 of the canonical JSON of
  `TOOLS` (name, description, input schema), `instructions_hash` = sha256 of `SERVER_INSTRUCTIONS` variant
  actually served. Computed in the host, passed in the `start` event as optional fields (additive, stored format
  stays v1-readable; golden fixtures have no `engine` and must still open).
- `run_started.executor` and `agent_completed.executor`: the `ExecutorRecord` of the call. If the executor of a
  call equals the previous one of the run it is still written (cheap, and "two clients in one run give two
  records" must be visible). A resume from another client or an upgraded engine mid-run: `agent_completed`
  carries its own `executor`, and when the engine version differs from `run_started.engine.version` it also
  carries `engine_version` (record both).
- **No new tool arguments.** The agent is not asked for an executor, so `pipeline_start` and
  `pipeline_complete_step` do not change and `CONTRACT_VERSION` is not bumped by this task (the epic's single
  bump, if any, belongs to a task that really changes an argument). The tool-surface snapshot test stays as it is.
- Build stamp: `bun build --define` in `packages/cli/package.json` build (version from `package.json`, commit from
  `git rev-parse --short HEAD`, both read in a small `scripts/build-cli.mjs` so the same file also serves the
  `kodel-hook` bundle). Real version: set `packages/cli/package.json` `version` to a real one agreed with the
  person (risk below). `scripts/check-artifact.mjs` fails when `--version` is `0.0.0`, when the embedded
  commit is empty, or when `kodel --version` ≠ package version.
- `history.executor.enabled: false` → no `executor`, no `engine.executor`-related fields; `run_started.engine`
  is still written? **Decision: also off** — the task says "with history.executor false nothing is recorded".
  The `history` object itself stays in `run_started`.

## Affected files

New: `pipeline-core/src/executor.ts` (types, sanitiser, hash helper over canonical JSON — `canonical.ts` exists),
`pipeline-core/test/executor.test.ts`, `scripts/build-cli.mjs`.

Changed: `pipeline-core/src/run.ts` (events `start`, `agent_completed`; journal fields), `service.ts` (caller,
pass executor to `host.start` and `run.completeStep`, `RunHandle.completeStep` signature takes `executor`),
`mcp/tools.ts` and `mcp/register.ts` (no change expected), `cli/src/mcp-server.ts`
(caller), `local/src/pipeline-host.ts` and `host.ts` (session, engine record, stamp events, honour the switch),
`testkit/src/memory-engine.ts` (fake host accepts the new optional input), `cli/package.json`, `scripts/check-artifact.mjs`,
and the report
(`report.ts`) only to *not* break on the new fields.

## Steps

1. Verify empirically that `CLAUDE_CODE_SESSION_ID` reaches the MCP server process (print env in a scratch
   server); record the answer in the PR. If it does not, the env source is dropped and only the hook source stays.
2. Add `executor.ts` + unit tests (sources, sanitiser, hash stable/changes).
3. Plumb `caller` and `executor` argument through service → host → run events → journal; honour the switch.
4. Compute `engine` block (hashes of tools and instructions) in the host; build stamp; `check-artifact`.
5. Check that the tool-surface snapshot test did not change (`tools_hash` is computed from the same tools).
6. Short note in `docs/history.md` on executor records and sources.

## Tests (names carry the decision id when one applies)

- unit (`executor.test.ts`): caller plumbing; each source label; sanitiser (control chars, 1 MB client name
  capped, secret-looking string redacted); model from a transcript fixture (`derived`), absent when there is no
  transcript or no usage; hashes change when a
  tool description or the instructions change.
- integration (`cli/test/mcp.test.ts` or the existing in-memory client tests): handshake with and without
  `clientInfo`; two clients in one run give two executor records; resume from another client.
- scenario (testkit adversarial agent): extra `executor`/`model` fields in a tool call are ignored, never
  recorded (agent input is untrusted); hostile client name in the handshake (control characters, 1 MB, secret-like).
- host (`local`): env present/absent; hook session preferred over env; `history.executor: false` → nothing in
  `run_started` and `agent_completed`; engine upgraded between steps (fake version change) records both.
- e2e: built artifact `--version` is real; `check-artifact` fails on `0.0.0` (run the script against a temp copy).
- golden fixtures in `fixtures/formats/v1` still open (`status`, `report`): new fields are additive.
- real agent (`tests/agents`): a Claude Code run records client name, version and session in `run_started` and in
  `agent_completed`, each with a source.

## Risks / open points

- **Real version number**: today `0.0.0`; which version to stamp is the person's call. Plan assumes `0.1.0`
  unless told otherwise.
- `step_served` is not there (see above): "executor on `step_served`" moves to TASK-V75E, where it is a one-liner.
- Contract: no bump here (no new arguments).
- `CLAUDE_CODE_SESSION_ID` may not reach the server; the hook source then carries the session, and a run with
  neither has no `session` (never a made-up value).
- Hash of tools depends on zod → JSON-schema rendering; use our own canonical dump of names/descriptions/shape
  keys, not a library's output, so a dependency bump does not change the hash.
- Everything recorded is observed or derived by the engine, never claimed by the agent; it is sanitised and
  capped, and never used for any decision by the engine.
- The transcript may not have the model yet at `run_started` (first call of a session): the model is then
  filled in on the later `agent_completed` records.
- Whether the hook payload itself carries the model is unverified; if it does, it is a better `observed-hook` source
  than the transcript (checked in step 1).

## Notes from the implementation

- The session is taken from `CLAUDE_CODE_SESSION_ID` first (checked: it reaches the MCP server process; the agent
  starts one server per session, so it is exact) and from the hook index only when the environment has none. The
  index lists every session of the project, so with several open it can only say which one started last.
- `step_served` is still not there, as planned; `LocalRun.executorNow()` is what TASK-V75E calls for its record.
- `RunState` gained two optional fields (`history`, `engineVersion`) so `completeStep` knows the switch and the
  version the run began on; old states read as before.
- Not done: the real-agent test in `tests/agents` (needs a Claude Code run on the person's machine). The
  handshake, session, model, switch, two-clients and upgraded-engine cases are covered with the real local host.
- The version is now `0.1.0` in `packages/cli/package.json` (and `bun.lock`); `scripts/build-cli.mjs` stamps the
  commit, and `check-artifact` fails on `0.0.0` and on an artifact with no commit stamped.
