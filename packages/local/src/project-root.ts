/** The project root as an error for the callers that need one (the CLI, the MCP server, the host). */
import { KodelError } from "@kodel-ai/pipeline-core";
import { type FindProjectOptions, locateProject, type ProjectRoot } from "./project-locate";

export * from "./project-locate";

export const NO_PROJECT_MESSAGE =
  "no Kodel project here (no .kodel/config.yaml in this folder or above); run `kodel init` here, or pass --root";

export async function findProjectRoot(
  cwd: string,
  options: FindProjectOptions = {},
): Promise<ProjectRoot> {
  const found = await locateProject(cwd, options);
  if (found === undefined) throw new KodelError("NO_PROJECT", NO_PROJECT_MESSAGE);
  return found;
}
