// Fails when an installed dependency has a license that is not on the allowlist (all compatible with
// Apache-2.0), or no license at all. Run it after `bun install`; it reads the package store of Bun.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(root, "node_modules/.bun");

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
]);

// A package that must be let through without an allowed license, with the reason. Empty on purpose.
const EXCEPTIONS = new Map([]);

const fail = (msg) => {
  console.error(`license check failed: ${msg}`);
  process.exit(1);
};

if (!existsSync(store)) fail("node_modules/.bun not found: run `bun install` first");

const packageDirs = [];
for (const entry of readdirSync(store)) {
  if (entry === "node_modules") continue;
  const modules = join(store, entry, "node_modules");
  if (!existsSync(modules)) continue;
  for (const name of readdirSync(modules)) {
    if (name.startsWith("@")) {
      for (const child of readdirSync(join(modules, name)))
        packageDirs.push(join(modules, name, child));
    } else {
      packageDirs.push(join(modules, name));
    }
  }
}

// `(MIT OR Apache-2.0)` needs one allowed id; `MIT AND ISC` needs all. Anything unclear is refused.
const accepted = (expression) =>
  expression.split(/\s+AND\s+/).every((part) =>
    part
      .replace(/[()]/g, "")
      .split(/\s+OR\s+/)
      .some((id) => ALLOWED.has(id.trim())),
  );

const declared = (pkg) => {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? "").join(" AND ");
  return "";
};

const seen = new Set();
const counts = new Map();
const problems = [];
for (const dir of packageDirs) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const license = declared(pkg);
  counts.set(license || "(none)", (counts.get(license || "(none)") ?? 0) + 1);
  if (license && accepted(license)) continue;
  if (EXCEPTIONS.has(pkg.name)) continue;
  problems.push(`${id}: ${license || "no license field"}`);
}

if (seen.size === 0)
  fail("no installed packages found: the layout of node_modules may have changed");
if (problems.length > 0) fail(`not allowed:\n  ${problems.join("\n  ")}`);

const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}: ${n}`);
console.log(`license check passed for ${seen.size} packages (${summary.join(", ")})`);
