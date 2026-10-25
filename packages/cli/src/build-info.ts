import type { BuildInfo } from "@kodel-ai/local";
import pkg from "../package.json" with { type: "json" };

/** Replaced by `scripts/build-cli.mjs` with the commit the artifact is built from. */
declare const __KODEL_COMMIT__: string | undefined;

export const BUILD_COMMIT: string = typeof __KODEL_COMMIT__ === "string" ? __KODEL_COMMIT__ : "dev";

/** The program that serves the runs: what `run_started.engine` records. */
export const BUILD: BuildInfo = { version: pkg.version, commit: BUILD_COMMIT };
