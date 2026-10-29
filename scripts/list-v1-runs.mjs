// List the runs of an older run-state format that are still open (running or paused) in a project.
//
//   node scripts/list-v1-runs.mjs [<project root>] [--format <N>]
//
// The current kodel refuses to read a run written in run-state format 1; such a run is finished or
// cancelled with the kodel that started it. This prints one line per open run of that format
// (`<run id>  <status>  <pipeline>  <task>`), so they can be found before a merge. Exit code 0 when
// there are none, 1 when there are some, 2 for a usage error. Runs that cannot be read at all are
// listed as `unreadable`.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function listOpenRuns(root, format = 1) {
  const runs = join(root, ".kodel", "runs");
  let names;
  try {
    names = (await readdir(runs, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("r_"))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const id of names) {
    let state;
    try {
      state = JSON.parse(await readFile(join(runs, id, "state.json"), "utf8"));
    } catch {
      found.push({ runId: id, status: "unreadable", pipeline: "?", task: "?" });
      continue;
    }
    if (state.v !== format) continue;
    if (state.status !== "running" && state.status !== "paused") continue;
    let pipeline = "?";
    try {
      pipeline = JSON.parse(await readFile(join(runs, id, "meta.json"), "utf8")).pipeline ?? "?";
    } catch {
      // the state is enough to name the run
    }
    found.push({ runId: id, status: state.status, pipeline, task: String(state.task ?? "") });
  }
  return found;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let format = 1;
  const at = args.indexOf("--format");
  if (at >= 0) {
    format = Number(args[at + 1]);
    if (!Number.isInteger(format) || format < 1) {
      console.error("usage: list-v1-runs.mjs [<project root>] [--format <N>]");
      process.exit(2);
    }
    args.splice(at, 2);
  }
  const root = resolve(args[0] ?? ".");
  const open = await listOpenRuns(root, format);
  for (const run of open) {
    console.log(
      `${run.runId}  ${run.status}  ${run.pipeline}  ${run.task.replace(/\s+/g, " ").slice(0, 80)}`,
    );
  }
  if (open.length === 0) console.log(`no open runs of run-state format ${format} in ${root}`);
  process.exit(open.length === 0 ? 0 : 1);
}
