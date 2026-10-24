/**
 * The skills `kodel init` puts into a project. The texts live in `skills/<name>/SKILL.md` at the
 * root of the repository and are embedded in the build as text, like the engine's agent docs.
 *
 * To ship a skill, import its file and add it to `SKILLS`:
 *
 *   import design from "../../../../skills/design/SKILL.md" with { type: "text" };
 *   export const SKILLS: Skill[] = [{ name: "kodel-design", text: design }];
 *
 * `name` is the directory name in the project and must match `name:` in the skill's frontmatter.
 */
import { join } from "node:path";
import design from "../../../../skills/design/SKILL.md" with { type: "text" };
import kodelRun from "../../../../skills/kodel-run/SKILL.md" with { type: "text" };
import type { AgentAdapter } from "./agents";
import { type Context, editFile, ownership, stamp } from "./files";

export interface Skill {
  name: string;
  /** The whole SKILL.md, frontmatter included. */
  text: string;
}

export const SKILLS: readonly Skill[] = [
  { name: "kodel-run", text: kodelRun },
  { name: "kodel-design", text: design },
];

/**
 * Add or update the skills. A copy init wrote and nobody edited is replaced by the new text; one
 * that was edited, or that init did not write, stays as it is unless `--force` was given.
 */
export async function installSkills(
  ctx: Context,
  agent: AgentAdapter,
  skills: readonly Skill[] = SKILLS,
): Promise<void> {
  for (const skill of skills) {
    const rel = join(agent.skillsDir, skill.name, "SKILL.md").replaceAll("\\", "/");
    await editFile(ctx, rel, (previous) => {
      if (previous !== undefined && !ctx.force) {
        const owner = ownership(previous);
        if (owner === "foreign") return { skip: "not written by kodel; use --force to replace it" };
        if (owner === "modified")
          return { skip: "edited since kodel wrote it; use --force to replace it" };
      }
      return { text: stamp(skill.text) };
    });
  }
}
