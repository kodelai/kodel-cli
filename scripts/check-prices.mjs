// Checks the price table (packages/pipeline-core/src/price-table.json) on plain Node: it reads the JSON
// file only, never dist/ or a .ts file.
//
//   node scripts/check-prices.mjs                    each sourceUrl is fetched and the prices on the page are compared
//   node scripts/check-prices.mjs --pages <dir>      the same on saved pages (<dir>/<encodeURIComponent(url)>.html), no network
//   node scripts/check-prices.mjs --local [--root d] the table is compared with the cost-state entries of Claude Code
//                                                    sessions of this Kodel project (a directory with .kodel/config.yaml)
//
// Options: --table <file> (another table), --timeout-ms <n> (default 15000), --config-dir <dir> (Claude Code's store).
// Exit codes: 0 nothing differs, 1 a price on a page or in a cost-state differs, 2 a page is unreachable or
// does not hold the table's models, or the arguments are wrong.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TABLE = join(here, "..", "packages", "pipeline-core", "src", "price-table.json");
const PRICE_KEYS = ["input", "output", "cache_read", "cache_write", "cache_write_1h"];
const DRIFT = 0.1;
/** How far after a model's name the prices are looked for. */
const REGION_CHARS = 900;
/** Claude Code cuts a folder name at this length and adds a hash after it. */
const NAME_LIMIT = 200;

function parseArgs(argv) {
  const opts = { local: false, timeoutMs: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--local") opts.local = true;
    else if (arg === "--pages") opts.pages = next();
    else if (arg === "--table") opts.table = next();
    else if (arg === "--root") opts.root = next();
    else if (arg === "--config-dir") opts.configDir = next();
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(next());
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)
    throw new Error("--timeout-ms must be positive");
  return opts;
}

function loadTable(path) {
  const table = JSON.parse(readFileSync(path, "utf8"));
  if (table === null || typeof table !== "object" || typeof table.models !== "object")
    throw new Error(`${path} is not a price table`);
  return table;
}

/** The entries as {model, entry} in table order; a model has a list of dated entries. */
function entriesOf(table) {
  const out = [];
  for (const [model, list] of Object.entries(table.models)) {
    for (const entry of Array.isArray(list) ? list : [list]) out.push({ model, entry });
  }
  return out;
}

/** `claude-opus-4-5` -> a pattern for "Claude Opus 4.5" (also 4-5, and spaces or dashes between the words). */
function modelNamePattern(model) {
  const parts = model.split("-");
  const words = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (/^\d$/.test(part ?? "") && /^\d$/.test(nextPart ?? "")) {
      words.push(`${part}[.\\-]${nextPart}`);
      i++;
    } else if (part !== undefined) words.push(part);
  }
  // No more version after the name: "Claude Opus 5" is not a prefix of "Claude Opus 5.5".
  return new RegExp(`${words.join("[\\s\\-]+")}(?![.\\-]?\\d)`, "i");
}

function pageText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const sameNumber = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * Compares one entry with a page: `missing` when the page never names the model, `changed` when a price of the
 * entry is not among the dollar amounts that follow the name, else `ok`.
 */
export function checkEntryAgainstPage(model, entry, text) {
  const match = modelNamePattern(model).exec(text);
  if (match === null) return { status: "missing" };
  const after = text.slice(match.index + match[0].length, match.index + REGION_CHARS);
  // The row of the next model is not this model's prices.
  const next = after.search(/\bclaude\b/i);
  const region = next === -1 ? after : after.slice(0, next);
  const amounts = [...region.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const absent = PRICE_KEYS.filter(
    (key) => typeof entry[key] === "number" && !amounts.some((a) => sameNumber(a, entry[key])),
  );
  return absent.length === 0 ? { status: "ok" } : { status: "changed", absent };
}

async function fetchPage(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function checkPages(table, opts) {
  const pages = new Map();
  let unreachable = 0;
  let missing = 0;
  let changed = 0;
  const unchecked = [];
  for (const { model, entry } of entriesOf(table)) {
    if (entry.checkedAt === null || entry.checkedAt === undefined) unchecked.push(model);
    const url = entry.sourceUrl;
    if (typeof url !== "string") {
      console.log(`${model}: no sourceUrl`);
      missing++;
      continue;
    }
    if (!pages.has(url)) {
      try {
        const html = opts.pages
          ? readFileSync(join(opts.pages, `${encodeURIComponent(url)}.html`), "utf8")
          : await fetchPage(url, opts.timeoutMs);
        pages.set(url, pageText(html));
      } catch (error) {
        pages.set(url, null);
        console.log(
          `unreachable ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
        unreachable++;
      }
    }
    const text = pages.get(url);
    if (text === null || text === undefined) continue;
    const result = checkEntryAgainstPage(model, entry, text);
    if (result.status === "missing") {
      console.log(`${model}: not found on ${url} (the page format may have changed)`);
      missing++;
    } else if (result.status === "changed") {
      console.log(`${model}: differs from ${url}: ${result.absent.join(", ")}`);
      changed++;
    } else console.log(`${model}: ok`);
  }
  if (unchecked.length > 0)
    console.log(`not yet checked (checkedAt null): ${[...new Set(unchecked)].join(", ")}`);
  if (unreachable > 0 || missing > 0) return 2;
  return changed > 0 ? 1 : 0;
}

// ---- --local -----------------------------------------------------------------------------------------------

/** The folder name Claude Code gives a working directory. Kept equal to `projectFolderName` of @kodel-ai/local by a test. */
export const projectFolderName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".kodel", "config.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const isInside = (parent, child) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function* jsonLines(path) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A torn or foreign line is skipped.
    }
  }
}

const DATE_TAIL = /^-(\d{8}|latest)$/;

/** The table key that names `model`: the exact one, else the longest one `model` is a dated form of (as the core does). */
export function keyFor(table, model) {
  if (Object.hasOwn(table.models, model)) return model;
  let best;
  for (const id of Object.keys(table.models)) {
    if (model.startsWith(id) && DATE_TAIL.test(model.slice(id.length))) {
      if (best === undefined || id.length > best.length) best = id;
    }
  }
  return best;
}

/** The price of one response by the entry in force at `ts` (the last entry whose effectiveFrom is not after it). */
export function priceOf(table, model, ts) {
  const key = keyFor(table, model);
  const list = key === undefined ? undefined : table.models[key];
  if (list === undefined) return undefined;
  const entries = (Array.isArray(list) ? list : [list])
    .filter((e) => e.effectiveFrom === undefined || e.effectiveFrom <= ts.slice(0, 10))
    .sort((a, b) => String(a.effectiveFrom ?? "").localeCompare(String(b.effectiveFrom ?? "")));
  return entries.at(-1);
}

/**
 * What one session file says: the cost-state entry (if any) and the table's cost of the usage lines, folded by
 * message id and request id with the last line winning (the usage grows while a response streams).
 */
export function summarizeSession(path, table) {
  let costState;
  const responses = new Map();
  for (const entry of jsonLines(path)) {
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type === "cost-state") {
      costState = entry;
      continue;
    }
    const message = entry.message;
    if (message === undefined || typeof message !== "object" || message.usage === undefined)
      continue;
    const key = `${message.id ?? ""}|${entry.requestId ?? ""}`;
    if (key === "|") continue;
    responses.set(key, {
      model: String(message.model ?? ""),
      usage: message.usage,
      ts: String(entry.timestamp ?? ""),
    });
  }
  let cost = 0;
  const absent = new Set();
  for (const { model, usage, ts } of responses.values()) {
    const price = priceOf(table, model, ts || "9999-12-31");
    if (price === undefined) {
      absent.add(model);
      continue;
    }
    const write = Number(usage.cache_creation_input_tokens ?? 0);
    const write1h = Math.min(write, Number(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0));
    cost +=
      (Number(usage.input_tokens ?? 0) * price.input +
        Number(usage.output_tokens ?? 0) * price.output +
        Number(usage.cache_read_input_tokens ?? 0) * price.cache_read +
        (write - write1h) * price.cache_write +
        write1h * (price.cache_write_1h ?? price.input * 2)) /
      1e6;
  }
  return { costState, cost, absent: [...absent].sort() };
}

/** The total a cost-state entry states, read tolerantly: Claude Code does not document the entry. */
export function costStateTotal(entry) {
  const inner = entry.costState ?? entry.state ?? entry;
  const total = inner.totalCostUSD ?? inner.total_cost_usd ?? inner.totalCostUsd ?? inner.costUSD;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

export function sessionFilesOfProject(root, configDir) {
  const store = join(configDir, "projects");
  const name = projectFolderName(root);
  const prefix = name.length > NAME_LIMIT ? name.slice(0, NAME_LIMIT) : `${name}-`;
  let folders;
  try {
    folders = readdirSync(store).filter((entry) => entry === name || entry.startsWith(prefix));
  } catch {
    return [];
  }
  const files = [];
  for (const folder of folders) {
    const dir = join(store, folder);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      if (!statSync(path).isFile()) continue;
      // A log counts only when the cwd of its first entry that has one lies in the project.
      const cwd = [...jsonLines(path)].find((e) => typeof e?.cwd === "string")?.cwd;
      if (typeof cwd === "string" && isInside(root, resolve(cwd))) files.push(path);
    }
  }
  return files;
}

function checkLocal(table, opts) {
  const root = opts.root ? resolve(opts.root) : findProjectRoot(process.cwd());
  if (root === undefined || !existsSync(join(root, ".kodel", "config.yaml"))) {
    console.log("not in a Kodel project (no .kodel/config.yaml): nothing was read");
    return 0;
  }
  const configDir = opts.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let drifted = 0;
  let compared = 0;
  const absent = new Set();
  for (const file of sessionFilesOfProject(root, configDir)) {
    const { costState, cost, absent: gone } = summarizeSession(file, table);
    for (const model of gone) absent.add(model);
    if (costState === undefined) continue;
    if ((costState.hasUnknownModelCost ?? costState.costState?.hasUnknownModelCost) === true)
      continue;
    const stated = costStateTotal(costState);
    if (stated === undefined || stated <= 0 || gone.length > 0) continue;
    compared++;
    const drift = (cost - stated) / stated;
    // The cost-state also counts requests the transcript does not hold, so it is expected to be above the table.
    if (Math.abs(drift) > DRIFT) {
      drifted++;
      console.log(
        `${basename(file)}: table $${cost.toFixed(4)} against cost-state $${stated.toFixed(4)} (${(drift * 100).toFixed(1)}%)`,
      );
    }
  }
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 8);
  console.log(
    `compared ${compared} session(s) of the project ${digest}; ${drifted} differ by more than 10%`,
  );
  if (absent.size > 0)
    console.log(`models in the events and not in the table: ${[...absent].sort().join(", ")}`);
  return drifted > 0 ? 1 : 0;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let table;
  try {
    table = loadTable(opts.table ?? DEFAULT_TABLE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  return opts.local ? checkLocal(table, opts) : checkPages(table, opts);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
