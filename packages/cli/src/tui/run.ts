/** The terminal loop: alternate screen, raw keys, redraw on a key, a resize, a frame or new data. */
import { MOUSE_OFF, MOUSE_ON, parseInput } from "./input";
import type { Loaded } from "./load";
import {
  initialModel,
  isAnimated,
  type Model,
  mouseUpdate,
  render,
  tick,
  update,
  withData,
} from "./view";

const FRAME_MS = 100;
const REFRESH_MS = 2000;

export interface TuiOptions {
  /** Start with mouse events on; `m` turns them on and off while the screen is open. */
  mouse?: boolean;
}

export async function runTui(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  load: () => Promise<Loaded>,
  source: Model["source"],
  options: TuiOptions = {},
): Promise<number> {
  // Read before the screen is taken over, so a project that cannot be read ends with a plain error.
  let model: Model = initialModel(await load(), source, Date.now(), options.mouse === true);
  let mouseSent = false;

  const size = () => ({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
  const draw = () => {
    if (model.mouse !== mouseSent) {
      stdout.write(model.mouse ? MOUSE_ON : MOUSE_OFF);
      mouseSent = model.mouse;
    }
    const lines = render(model, size());
    stdout.write(lines.map((line, i) => `\u001b[${i + 1};1H${line}`).join(""));
  };
  // Always turned off on the way out, whatever was sent: a terminal left reporting the mouse
  // fills the person's shell with escape codes.
  const restore = () => {
    stdout.write(`${MOUSE_OFF}\u001b[?25h\u001b[?1049l`);
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
      for (const event of parseInput(chunk)) {
        model =
          event.type === "key" ? update(model, event.name) : mouseUpdate(model, size(), event);
        if (model.quit) break;
      }
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
