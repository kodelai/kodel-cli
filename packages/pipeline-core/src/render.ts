/** Filling `{{task}}` and `{{task.slug}}` into the strings of a pipeline. */
import { slugify } from "./slug";

export interface RenderContext {
  task: string;
}

/** `\{{` stays a literal `{{`; anything that is not a known placeholder is left as written. */
export function renderTemplate(template: string, context: RenderContext): string {
  const slug = slugify(context.task);
  const ESCAPED = "\u0000";
  return template
    .replace(/\\\{\{/g, ESCAPED)
    .replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (whole: string, name: string) => {
      if (name === "task") return context.task;
      if (name === "task.slug") return slug;
      return whole;
    })
    .replaceAll(ESCAPED, "{{");
}

/** Render every string inside a JSON-like value. */
export function renderDeep<T>(value: T, context: RenderContext): T {
  if (typeof value === "string") return renderTemplate(value, context) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, context)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderDeep(v, context)]),
    ) as T;
  }
  return value;
}
