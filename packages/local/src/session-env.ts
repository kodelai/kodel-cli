/**
 * The environment of a session child. No inherited `KODEL_*` passes (a switch meant for kodel must not
 * reach a program that may run its own kodel), the window variables of the starter's terminal are dropped,
 * and `KODEL_ENGINE=1` is forced so every human-only command refuses inside a session.
 * `engineEnv` (a run's step) is a separate function and its output is unchanged.
 */
const WINDOW_VARS = [
  /^VSCODE_/,
  /^TMUX/,
  /^KITTY_WINDOW_ID$/,
  /^TERM_PROGRAM/,
  /^ITERM_/,
  /^WEZTERM_/,
  /^STY$/,
];

export function sessionEnv(
  specEnv: Record<string, string> | undefined,
  inherit: boolean,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (inherit) {
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined || key.startsWith("KODEL_")) continue;
      if (WINDOW_VARS.some((re) => re.test(key))) continue;
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(specEnv ?? {})) {
    if (!key.startsWith("KODEL_")) env[key] = value;
  }
  env.KODEL_ENGINE = "1";
  return env;
}
