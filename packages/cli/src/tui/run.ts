/** The terminal loop: alternate screen, raw keys, redraw on a key or a resize. */
import { DEMO_SESSIONS } from "./demo";
import { initialModel, type Model, render, update } from "./view";

const KEYS: Record<string, string> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\u001b": "escape",
  "\u0003": "ctrl-c",
};

export function keyName(chunk: string): string {
  return KEYS[chunk] ?? chunk;
}

export async function runTui(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<number> {
  let model: Model = initialModel(DEMO_SESSIONS);

  const draw = () => {
    const lines = render(model, { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.write(lines.map((line, i) => `\u001b[${i + 1};1H${line}`).join(""));
  };
  const restore = () => {
    stdout.write("\u001b[?25h\u001b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
  };

  stdout.write("\u001b[?1049h\u001b[?25l\u001b[2J");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  process.once("exit", restore);

  return await new Promise<number>((resolve) => {
    const finish = () => {
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      stdin.pause();
      restore();
      resolve(0);
    };
    const onData = (chunk: string) => {
      model = update(model, keyName(chunk));
      if (model.quit) finish();
      else draw();
    };
    const onResize = () => {
      stdout.write("\u001b[2J");
      draw();
    };
    stdin.on("data", onData);
    stdout.on("resize", onResize);
    draw();
  });
}
