/** Filling `{{task}}`, `{{task.slug}}`, `{{run.slug}}` and `{{run.start_date}}` into the strings of a pipeline. */
import { runSlug, slugify, startDate } from "./slug";

export interface RenderContext {
  task: string;
  /** What the run itself gives; absent where no run exists (a dry run), and then these stay as written. */
  run?: { slug: string; startDate: string };
}

/** The part of a run's state the placeholders are made from. */
export interface RenderSource {
  task: string;
  slug?: string | undefined;
  startedAt: number;
}

/** One place that says what a run gives the placeholders, so a new one is a change here. */
export function renderContextOf(state: RenderSource): RenderContext {
  return {
    task: state.task,
    // A run from before it had a title gets the name the task text would have given it.
    run: {
      slug: state.slug ?? runSlug(undefined, state.task),
      startDate: startDate(state.startedAt),
    },
  };
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
      if (name === "run.slug") return context.run?.slug ?? whole;
      if (name === "run.start_date") return context.run?.startDate ?? whole;
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
