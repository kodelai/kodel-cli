/**
 * The page and its script and styles. The built CLI carries them in itself (`scripts/build-cli.mjs`
 * defines `__KODEL_WEB_APP__`); run from source under Bun, the app is built when the server starts.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assets } from "./handler";

declare const __KODEL_WEB_APP__: { js: string; css: string } | undefined;

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#11151c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Kodel</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

export async function loadAssets(): Promise<Assets> {
  if (typeof __KODEL_WEB_APP__ !== "undefined") {
    return { html: HTML, js: __KODEL_WEB_APP__.js, css: __KODEL_WEB_APP__.css };
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), "app");
  if (typeof Bun === "undefined") {
    throw new Error("this build carries no web app; build the CLI with `bun run build`");
  }
  const built = await Bun.build({
    entrypoints: [join(dir, "main.tsx")],
    target: "browser",
    minify: true,
  });
  if (!built.success || built.outputs[0] === undefined) {
    throw new Error(`the web app did not build: ${built.logs.map(String).join("\n")}`);
  }
  return {
    html: HTML,
    js: await built.outputs[0].text(),
    css: await readFile(join(dir, "app.css"), "utf8"),
  };
}
