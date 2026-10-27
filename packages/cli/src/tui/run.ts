/** The terminal loop: alternate screen, raw keys, redraw on a key, a resize, a frame or new data. */
import type { Loaded } from "./load";
import { initialModel, isAnimated, type Model, render, tick, update, withData } from "./view";

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

const FRAME_MS = 100;
const REFRESH_MS = 2000;

export async function runTui(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  load: () => Promise<Loaded>,
  source: Model["source"],
): Promise<number> {
  // Read before the screen is taken over, so a project that cannot be read ends with a plain error.
  let model: Model = initialModel(await load(), source, Date.now());

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
    let refreshing = false;
    const frames = setInterval(() => {
      model = tick(model, Date.now());
      if (isAnimated(model)) draw();
    }, FRAME_MS);
    const refresh = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      load()
        .then((loaded) => {
          model = withData(model, loaded, Date.now());
        })
        .catch((error: unknown) => {
          model = {
            ...model,
            notice: `Cannot read the runs: ${error instanceof Error ? error.message : String(error)}`,
          };
        })
        .finally(() => {
          refreshing = false;
          draw();
        });
    }, REFRESH_MS);

    const finish = () => {
      clearInterval(frames);
      clearInterval(refresh);
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
