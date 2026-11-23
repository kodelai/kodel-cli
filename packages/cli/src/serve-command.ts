/**
 * `kodel serve` and `kodel serve --status` (TASK-G8KM, T-44). The loop itself is `createServeDaemon` in
 * `@kodel-ai/local`; this is the command around it: the record that keeps it to one per checkout, the
 * signals that end it (the action in hand is finished, the workers go on), the exit codes a service
 * manager reads, and the read-only report of `--status`.
 */
import { stat } from "node:fs/promises";
import {
  acquireServeRecord,
  createServeDaemon,
  openTaskService,
  readServeStatus,
  SERVE_EXIT_REFUSED,
  type ServeHostPort,
  type ServePlace,
  type ServeRecordHandle,
  ServeRecordRefused,
  type ServeTasksPort,
  serveTasksOf,
} from "@kodel-ai/local";
import type { ServeStartRule } from "@kodel-ai/pipeline-core/serve";
import { plain } from "./plain";
import { serveLauncherOf } from "./worker-factory";
import type { WorkerLauncher } from "./worker-launcher";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

const iso = (ms: number) => new Date(ms).toISOString();

async function openTasks(dataDir: string): Promise<{ tasks?: ServeTasksPort; problem?: string }> {
  try {
    const opened = await openTaskService({ storeRoot: dataDir });
    return opened === undefined ? {} : { tasks: serveTasksOf(opened.service) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The size and time of the program file: a new build on disk ends the daemon with 75. */
async function buildStamp(): Promise<string | undefined> {
  const file = process.argv[1];
  if (file === undefined) return undefined;
  const info = await stat(file);
  return `${info.size}:${info.mtimeMs}`;
}

export interface RunServeInput {
  root: string;
  dataDir: string;
  host: ServeHostPort;
  openLauncher: () => Promise<WorkerLauncher>;
  place: ServePlace;
  version: string;
  build: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Ends the daemon when aborted; without one, `SIGTERM`, `SIGINT` and `SIGHUP` do. */
  signal?: AbortSignal;
}

/** Runs the daemon until a signal (0), a change of the config or the build (75) or a refusal (78). */
export async function runServe(input: RunServeInput): Promise<number> {
  let record: ServeRecordHandle;
  try {
    record = await acquireServeRecord(input.place, { now: Date.now(), build: input.build });
  } catch (error) {
    if (error instanceof ServeRecordRefused) {
      input.err(`kodel: ${plain(error.message)}\n`);
      return SERVE_EXIT_REFUSED;
    }
    // A record that cannot be written (no permission, a full disk, a state base that is a file) is not
    // fixed by a restart: a service manager is told so with 78 instead of being invited to retry.
    const why = error instanceof Error ? error.message : String(error);
    input.err(
      `kodel: the record of kodel serve cannot be written at ${plain(input.place.file)} (${plain(why)}); check the state base (KODEL_STATE_DIR)\n`,
    );
    return SERVE_EXIT_REFUSED;
  }
  const log = (line: string) => input.out(`${iso(Date.now())} ${line}\n`);
  const controller = new AbortController();
  const stop = (why: string) => {
    if (controller.signal.aborted) return;
    log(`stopping (${why}): the action in hand is finished; the workers go on`);
    controller.abort();
  };
  // A second signal does not wait for the action in hand: the person wants it gone now.
  const handlers = SIGNALS.map((name) => ({
    name,
    handler: () => {
      if (!controller.signal.aborted) {
        stop(name);
        return;
      }
      log(`stopped at once (${name} again); the workers go on`);
      process.exit(name === "SIGINT" ? 130 : 143);
    },
  }));
  if (input.signal === undefined) {
    for (const { name, handler } of handlers) process.on(name, handler);
  } else if (input.signal.aborted) {
    controller.abort();
  } else {
    input.signal.addEventListener("abort", () => stop("asked to stop"), { once: true });
  }
  try {
    input.out(
      `kodel serve\nroot:       ${plain(input.root)}\nstate base: ${plain(input.place.base)}\nbuild:      ${plain(input.build)}\n`,
    );
    const opened = await openTasks(input.dataDir);
    if (opened.problem !== undefined) {
      log(`the tracker cannot be opened (${plain(opened.problem)}); no task is started`);
    }
    const daemon = createServeDaemon({
      root: input.root,
      storeRoot: input.dataDir,
      host: input.host,
      launcher: serveLauncherOf(await input.openLauncher()),
      ...(opened.tasks === undefined ? {} : { tasks: opened.tasks }),
      record,
      log: (line) => log(plain(line)),
      version: input.version,
      buildStamp,
    });
    const result = await daemon.run(controller.signal);
    if (result.exit !== 0) log(`exit ${result.exit}: ${plain(result.reason ?? "")}`);
    return result.exit;
  } finally {
    for (const { name, handler } of handlers) process.off(name, handler);
    await record.release();
  }
}

export interface ServeStatusInput {
  root: string;
  dataDir: string;
  host: ServeHostPort;
  launcher: WorkerLauncher;
  place: ServePlace;
  version: string;
  out: (text: string) => void;
  platform?: string;
  now?: number;
}

function ruleLine(rule: ServeStartRule): string {
  const { status, priority, parent, approval } = rule.match;
  return [
    `pipeline ${plain(rule.pipeline)}`,
    ...(status === undefined ? [] : [`status ${status.map(plain).join(",")}`]),
    ...(priority === undefined ? [] : [`priority ${priority.map(plain).join(",")}`]),
    ...(parent === undefined ? [] : [`parent ${plain(parent)}`]),
    `approval ${approval}`,
  ].join(", ");
}

/** What `kodel serve --status` prints. It reads the record, the runs, the worker records and the tasks; it writes nothing. */
export async function printServeStatus(input: ServeStatusInput): Promise<void> {
  const { out } = input;
  const now = input.now ?? Date.now();
  const status = await readServeStatus(input.place, now, {
    ...(input.platform === undefined ? {} : { platform: input.platform as NodeJS.Platform }),
  });
  switch (status.kind) {
    case "off":
    case "unknown":
      out(`kodel serve: ${status.kind} (${plain(status.why)})\n`);
      break;
    default: {
      const r = status.record;
      const why =
        status.kind === "silent"
          ? `; no cycle finished since ${iso(r.cycle_at ?? r.started)}`
          : status.kind === "idle" && r.reason !== undefined
            ? `: ${plain(r.reason)}`
            : "";
      out(`kodel serve: ${status.kind} (pid ${r.pid}, since ${iso(r.started)})${why}\n`);
    }
  }
  out(`state base:  ${plain(input.place.base)}\n`);
  if (
    input.platform === "win32" ||
    (input.platform === undefined && process.platform === "win32")
  ) {
    out("kodel serve does not run on Windows yet: it starts no workers\n");
    return;
  }
  const opened = await openTasks(input.dataDir);
  if (opened.problem !== undefined) {
    out(`tracker:     cannot be opened (${plain(opened.problem)}); no task would start\n`);
  }
  const daemon = createServeDaemon({
    root: input.root,
    storeRoot: input.dataDir,
    host: input.host,
    launcher: serveLauncherOf(input.launcher),
    ...(opened.tasks === undefined ? {} : { tasks: opened.tasks }),
    log: () => undefined,
    version: input.version,
    now: () => now,
  });
  let answer: Awaited<ReturnType<typeof daemon.plan>>;
  try {
    answer = await daemon.plan();
  } catch (error) {
    out(
      `plan:        cannot be worked out (${plain(error instanceof Error ? error.message : String(error))})\n`,
    );
    return;
  }
  if (answer.config === "error") {
    out(`config:      ${plain(answer.reason)}; a daemon would be idle\n`);
    return;
  }
  const { rules, plan } = answer;
  if (!rules.enabled) out("config:      serve.enabled is not true; a daemon would be idle\n");
  // Disabled, a daemon acts on nothing: what waits is what it would take up once enabled.
  const waitLabel = rules.enabled ? "waits:      " : "if enabled: ";
  out(
    `limits:      workers ${plan.counts.workers} of ${plan.counts.max_workers}, runs with a worker ${plan.counts.runs.length} of ${plan.counts.max_runs}\n`,
  );
  if (rules.start.length === 0) out("start rules: none; a daemon only resumes and notes\n");
  rules.start.forEach((rule, i) => {
    out(`${`rule ${i + 1}:`.padEnd(13)}${ruleLine(rule)}\n`);
  });
  if (plan.blocked !== undefined) out(`starts:      blocked: ${plain(plan.blocked)}\n`);
  for (const runId of plan.waiting.resumes) out(`${waitLabel} resume of ${plain(runId)}\n`);
  for (const key of plan.waiting.starts) out(`${waitLabel} start of ${plain(key)}\n`);
  // Both queues in their order with the reason of each place, then what the links hold back (T-45, T-46).
  plan.queues.workers.forEach((entry, i) => {
    out(`worker queue: ${i + 1}. ${plain(entry.runId)}: ${plain(entry.reason)}\n`);
  });
  plan.queues.starts.forEach((entry, i) => {
    out(`start queue: ${i + 1}. ${plain(entry.key)}: ${plain(entry.reason)}\n`);
  });
  for (const held of plan.blocked_tasks) out(`blocked:     ${plain(held.reason)}\n`);
  for (const runId of plan.orphans) {
    out(
      `no agent:    ${plain(runId)}: open run with a task and no agent; any agent continues it with pipeline_next_step\n`,
    );
  }
}
