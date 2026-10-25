/**
 * Secret redaction. Every write path into history goes through this module: a secret that reaches
 * a git-tracked run history is leaked for good. The built-in rules are tuned to miss as little as
 * possible without eating ordinary text (commit hashes, UUIDs, prose); a project adds its own.
 */

export interface RedactRule {
  name: string;
  pattern: RegExp;
  /** Replace only part of the match; the default replaces all of it. */
  replace?: (match: string, ...groups: string[]) => string;
}

const tag = (name: string) => `[REDACTED:${name}]`;

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** More specific rules come first so the generic ones see what is left. */
export const BUILTIN_RULES: RedactRule[] = [
  {
    name: "private-key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "api-key", pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "url-password",
    // Every part is bounded: an open-ended scheme made a long run of letters and dashes quadratic.
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,256}:)([^\s@/]{1,512})(@)/gi,
    replace: (_m, head: string, _secret: string, at: string) =>
      `${head}${tag("url-password")}${at}`,
  },
  {
    name: "bearer",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    replace: (_m, head: string) => `${head}${tag("bearer")}`,
  },
  {
    name: "assignment",
    // A name that contains a secret word (DB_PASSWORD, api-key, githubToken), then : or =, then a
    // value of six or more characters that is not a plain number (max_tokens=100000 is not secret).
    // The name parts are bounded: an open-ended prefix made a long run of name characters quadratic.
    pattern:
      /([A-Za-z0-9_.-]{0,64}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?)[A-Za-z0-9_.-]{0,64}["']?\s*[:=]\s*["']?)(?!\d+(?:[\s"',;&]|$))([^\s"',;&]{6,})/gi,
    replace: (match, head: string, value: string) =>
      value.startsWith("[REDACTED:") || /^(?:bearer|basic|token)$/i.test(value)
        ? match
        : `${head}${tag("assignment")}`,
  },
];

/** Long, high-entropy words that no rule named: random tokens, base64 blobs. */
const ENTROPY_WORD = /[A-Za-z0-9+/_=-]{32,}/g;
const ENTROPY_BITS = 4.3;

function looksRandom(word: string): boolean {
  if (word.startsWith("[REDACTED")) return false;
  const mixed = /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word);
  return mixed && entropy(word) >= ENTROPY_BITS;
}

export function redactText(text: string, extra: RedactRule[] = []): string {
  let out = text;
  for (const rule of [...BUILTIN_RULES, ...extra]) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      if (rule.replace) {
        const groups = args.slice(1).filter((a) => typeof a === "string") as string[];
        return rule.replace(match, ...groups);
      }
      return tag(rule.name);
    });
  }
  return out.replace(ENTROPY_WORD, (word) => (looksRandom(word) ? tag("high-entropy") : word));
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

/**
 * For text whose beginning was cut off: a private key whose header went with the cut leaves its
 * body and footer, which no rule matches. Everything up to such a footer is replaced; a footer that
 * has its header in the text is left for `redactText`. Other secrets are short enough for the
 * margin the caller keeps before the cut.
 */
export function redactCutPrivateKey(text: string): string {
  const end = PRIVATE_KEY_END.exec(text);
  if (!end) return text;
  const begin = PRIVATE_KEY_BEGIN.exec(text);
  if (begin && begin.index < end.index) return text;
  return `${tag("private-key")}${text.slice(end.index + end[0].length)}`;
}

/** Redact every string inside a JSON-like value (keys are left alone). */
export function redactDeep<T>(value: T, extra: RedactRule[] = []): T {
  if (typeof value === "string") return redactText(value, extra) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, extra)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, extra)]),
    ) as T;
  }
  return value;
}

/** Project rules from `config.yaml`: `{ name, pattern }` with a regular expression source. */
export function compileRules(custom: { name: string; pattern: string }[]): RedactRule[] {
  return custom.map(({ name, pattern }) => {
    try {
      return { name, pattern: new RegExp(pattern, "g") };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`redaction rule "${name}" is not a valid regular expression: ${why}`);
    }
  });
}
