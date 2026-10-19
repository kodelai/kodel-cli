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
