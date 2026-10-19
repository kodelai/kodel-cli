import { describe, expect, test } from "bun:test";
import { compileRules, entropy, redactDeep, redactText } from "../src";

// Reference secrets, assembled at run time so this file does not trip secret scanners.
const join = (...parts: string[]) => parts.join("");
const SECRETS: Record<string, string> = {
  "aws-key": join("AKIA", "IOSFODNN7EXAMPLE"),
  "github-token": join("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
  "github-fine-grained": join(
    "github_pat_",
    "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP",
  ),
  "slack-token": join("xox", "b-123456789012-abcdefghijklmno"),
  "api-key": join("sk-", "ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"),
  "stripe-key": join("sk_", "live_", "51HabcDEFghiJKLmnoPQRstu"),
  "google-key": join("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  jwt: join(
    "eyJhbGciOiJIUzI1NiJ9",
    ".",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ),
  "private-key": join(
    "-----BEGIN RSA PRIVATE ",
    "KEY-----\nMIIEowIBAAKCAQEA\nabc123\n-----END RSA PRIVATE ",
    "KEY-----",
  ),
};

describe("redactText: known secrets", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    test(`${name} is removed and named`, () => {
      const out = redactText(`before ${secret} after`);
      expect(out).not.toContain(secret);
      expect(out).toContain(`[REDACTED:${name.replace("github-fine-grained", "github-token")}]`);
      expect(out.startsWith("before ")).toBe(true);
      expect(out.endsWith(" after")).toBe(true);
    });
  }

  test("a secret in the middle of a log line, a JSON string and a shell command", () => {
    const secret = SECRETS["github-token"] as string;
    expect(redactText(`curl -H "Authorization: token ${secret}" https://x`)).not.toContain(secret);
    expect(redactText(JSON.stringify({ log: `used ${secret} here` }))).not.toContain(secret);
    expect(redactText(`GITHUB_TOKEN=${secret} npm publish`)).not.toContain(secret);
  });

  test("several secrets in one text are all removed", () => {
    const text = `${SECRETS["aws-key"]} and ${SECRETS["slack-token"]} and ${SECRETS["jwt"]}`;
    const out = redactText(text);
    for (const name of ["aws-key", "slack-token", "jwt"])
      expect(out).not.toContain(SECRETS[name] as string);
  });
});

describe("redactText: assignments, URLs and headers", () => {
  test("the value goes, the name stays", () => {
    expect(redactText("password = hunter22")).toBe("password = [REDACTED:assignment]");
    expect(redactText('{"api_key": "abcd1234efgh"}')).toBe('{"api_key": "[REDACTED:assignment]"}');
    expect(redactText("DB_PASSWORD=s3cretvalue")).toContain("[REDACTED:assignment]");
    expect(redactText("TOKEN: abcdef123456")).toBe("TOKEN: [REDACTED:assignment]");
  });

  test("names that merely contain a secret word still count, plain numbers do not", () => {
    expect(redactText("githubToken: abcdef123456")).toBe("githubToken: [REDACTED:assignment]");
    expect(redactText("my-api-key=Zx81-ab")).toContain("[REDACTED:assignment]");
    expect(redactText("max_tokens=100000")).toBe("max_tokens=100000");
    expect(redactText("Authorization: Basic")).toBe("Authorization: Basic");
  });

  test("short values and ordinary words are left alone", () => {
    expect(redactText("token: 5")).toBe("token: 5");
    expect(redactText("the password policy is documented")).toBe(
      "the password policy is documented",
    );
    expect(redactText("tokens used: 120")).toBe("tokens used: 120");
  });

  test("the password in a URL goes, the rest stays readable", () => {
    expect(redactText("clone https://alice:p4ssw0rd@github.com/x/y.git")).toBe(
      "clone https://alice:[REDACTED:url-password]@github.com/x/y.git",
    );
    expect(redactText("postgres://app:topsecret1@db:5432/main")).toContain(
      "app:[REDACTED:url-password]@db",
    );
    expect(redactText("https://github.com/x/y.git")).toBe("https://github.com/x/y.git");
  });

  test("bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop1234")).toBe(
      "Authorization: Bearer [REDACTED:bearer]",
    );
  });
});

describe("redactText: leaves ordinary text alone", () => {
  const harmless = [
    "Error: cannot find module './limit' in packages/pipeline-core/src/limit.ts:42",
    "commit 3a105aa9c4e1b7f2d8a6e0b5c3d1f9a7e2b4c6d8",
    "id 6f1c2a3e-8b4d-4c5e-9a7f-1d2e3f4a5b6c",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "https://example.com/docs/plans/add_login_rate_limit.md",
    "12 passed, 1 failed in 3.2s",
    "The quick brown fox jumps over the lazy dog, again and again and again",
    "packages/pipeline-core/test/pipeline.test.ts",
  ];
  for (const text of harmless) {
    test(text.slice(0, 40), () => expect(redactText(text)).toBe(text));
  }
});

describe("redactText: entropy", () => {
  test("a long random-looking word is removed", () => {
    const blob = "Zk3Pq9XvT2mW8nL5aR7cY1bH4dF6gJ0sQeUiOyVu";
    expect(redactText(`secret blob ${blob}`)).toContain("[REDACTED:high-entropy]");
  });

  test("a long word with low entropy is kept", () => {
    const word = "aaaaaaaaaabbbbbbbbbbccccccccccAAAA1111";
    expect(redactText(word)).toBe(word);
  });

  test("entropy of simple strings", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("ab")).toBe(1);
  });
});

describe("custom rules", () => {
  test("a project rule applies on top of the built-ins", () => {
    const rules = compileRules([{ name: "ticket", pattern: "ACME-\\d{4}" }]);
    expect(redactText("see ACME-1234 for details", rules)).toBe(
      "see [REDACTED:ticket] for details",
    );
    expect(redactText(`see ${SECRETS["aws-key"]}`, rules)).toContain("[REDACTED:aws-key]");
  });

  test("an invalid pattern is reported with the rule name, not silently ignored", () => {
    expect(() => compileRules([{ name: "broken", pattern: "(" }])).toThrow(
      'redaction rule "broken"',
    );
  });
});

describe("redactDeep", () => {
  test("every string inside objects and arrays, but not keys or other values", () => {
    const secret = SECRETS["aws-key"] as string;
    const value = {
      [secret]: 1,
      list: [`key ${secret}`, 3, null, true],
      nested: { a: `x ${secret}` },
    };
    const out = redactDeep(value) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(`key ${secret}`);
    expect(out.list).toEqual(["key [REDACTED:aws-key]", 3, null, true]);
    expect((out.nested as { a: string }).a).toBe("x [REDACTED:aws-key]");
  });

  test("does not modify its input", () => {
    const value = { a: SECRETS["aws-key"] as string };
    redactDeep(value);
    expect(value.a).toBe(SECRETS["aws-key"] as string);
  });

  test("is idempotent", () => {
    const once = redactText(`${SECRETS["jwt"]} password = hunter22 ${SECRETS["aws-key"]}`);
    expect(redactText(once)).toBe(once);
  });
});
