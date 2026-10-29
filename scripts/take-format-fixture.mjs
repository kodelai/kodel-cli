// Copy a finished run into fixtures/formats/v<N>/ for the golden-format tests.
//
//   node scripts/take-format-fixture.mjs <format> <run-dir> [<run-dir> ...]
//
// The only changes: the run's absolute workdir becomes a placeholder in every file of the run
// (meta.json, state.json, the journal, and the served answers, which name the step's workdir), and
// seal.json is left out (it holds hashes of state.json and journal.jsonl, which the edit changes; a
// fixture reads as unsealed). Then hashes.json is rewritten for the whole format directory.
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [format, ...runDirs] = process.argv.slice(2);
if (!format || runDirs.length === 0) {
  console.error("usage: take-format-fixture.mjs <format, e.g. v1> <run-dir> [<run-dir> ...]");
  process.exit(2);
}

const target = join(root, "fixtures", "formats", format);

async function files(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await files(join(dir, entry.name), rel)));
    else if (entry.name !== "hashes.json" && entry.name !== ".gitkeep") found.push(rel);
  }
  return found.sort();
}

for (const source of runDirs) {
  const runId = basename(resolve(source));
  const meta = JSON.parse(await readFile(join(source, "meta.json"), "utf8"));
  if (typeof meta.workdir !== "string") throw new Error(`${runId}: meta.json has no workdir`);
  const placeholder = `/kodel-fixture/workdir/${runId}`;
  const out = join(target, runId);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(source, out, {
    recursive: true,
    filter: (path) => basename(path) !== "seal.json" && basename(path) !== "lock",
  });
  for (const name of await files(out)) {
    const path = join(out, name);
    // A Windows path is written with doubled backslashes inside JSON, so both spellings are replaced.
    const escaped = JSON.stringify(meta.workdir).slice(1, -1);
    let text = (await readFile(path, "utf8"))
      .split(meta.workdir)
      .join(placeholder)
      .split(escaped)
      .join(placeholder);
    if (name === "journal.jsonl") text = placeholderInJournal(text, placeholder);
    if (/\/Users\/|\/home\/|[A-Za-z]:\\{1,2}Users/.test(text)) {
      throw new Error(`${runId}/${name}: a path of this machine is left after the replacement`);
    }
    await writeFile(path, text);
  }
}

/**
 * The journal is redacted when it is written, and the random name of a temporary directory can read
 * as a secret to the redaction (`[REDACTED:high-entropy]...`): then the record's `workdir` is not the
 * text of `meta.json` and the replacement above misses it. Such a record gets the placeholder too, so
 * the three files agree, as the README says.
 */
function placeholderInJournal(text, placeholder) {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes('"workdir":')) return line;
      const record = JSON.parse(line);
      if (typeof record.workdir !== "string" || record.workdir === placeholder) return line;
      return JSON.stringify({ ...record, workdir: placeholder });
    })
    .join("\n");
}

const hashes = {};
for (const rel of await files(target)) {
  hashes[rel] = createHash("sha256")
    .update(await readFile(join(target, rel)))
    .digest("hex");
}
await rm(join(target, ".gitkeep"), { force: true });
await writeFile(join(target, "hashes.json"), `${JSON.stringify(hashes, null, 2)}\n`);
console.log(`${Object.keys(hashes).length} files in ${target}`);
