import { KodelError } from "./errors";

/**
 * `{{task.slug}}`: a filesystem-safe identifier derived from the task text.
 * Cyrillic is transliterated, everything else that is not a letter or digit becomes a separator,
 * and the result is capped. Text with nothing to transliterate falls back to a stable hash.
 */

export const SLUG_SEPARATOR = "_";
export const DEFAULT_SLUG_MAX_LENGTH = 60;

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  // Ukrainian and Belarusian additions.
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
};

/** A small deterministic hash (FNV-1a, 32 bit) as 8 hex digits; no platform APIs needed. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function slugify(text: string, maxLength = DEFAULT_SLUG_MAX_LENGTH): string {
  const transliterated = [...text.normalize("NFKD").toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    // Drop combining accents left by NFKD (é -> e).
    .replace(/[̀-ͯ]/g, "");

  const words = transliterated.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  let slug = words.join(SLUG_SEPARATOR);

  if (slug.length === 0) return `task${SLUG_SEPARATOR}${shortHash(text)}`;

  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength);
    while (slug.endsWith(SLUG_SEPARATOR)) slug = slug.slice(0, -1);
  }
  return slug;
}

/** The most characters a run title may have; the slug made from the task text is capped to it too. */
export const MAX_TITLE_LENGTH = 40;

/** Why a run title is not accepted, or `undefined` when it is. */
function titleProblem(title: string): string | undefined {
  if (title.length === 0) return "must not be empty";
  if (title.length > MAX_TITLE_LENGTH) {
    return `is ${title.length} characters, the most is ${MAX_TITLE_LENGTH}`;
  }
  // The alphabet below already rules this out; it stays named so a wider alphabet cannot let it in.
  if (title.includes("..")) return 'must not contain ".."';
  if (/[^a-z0-9-]/.test(title)) {
    return "may only have lowercase English letters, digits and single dashes (kebab-case, e.g. pipeline-version-field)";
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(title)) {
    return "must not start or end with a dash, or have two dashes in a row";
  }
  return undefined;
}

/** The title if the engine accepts it; otherwise a `KodelError` that says why, naming the field. */
export function validateTitle(title: string): string {
  const problem = titleProblem(title);
  if (problem !== undefined) {
    throw new KodelError("INVALID_ARGUMENTS", `title ${problem}`, [
      { path: ["title"], message: problem },
    ]);
  }
  return title;
}

/**
 * `{{run.slug}}`: the title the agent gave, or a name made from the task text. It is a label, not
 * an identity (that is the run id), so two runs may have the same one.
 */
export function runSlug(title: string | undefined, task: string): string {
  if (title !== undefined) return title;
  return slugify(task, MAX_TITLE_LENGTH).replaceAll(SLUG_SEPARATOR, "-");
}

/** `{{run.start_date}}`: the UTC day of a timestamp, `YYYY-MM-DD`. */
export function startDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
