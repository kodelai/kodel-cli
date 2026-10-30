/** The terminal loop: alternate screen, raw keys, redraw on a key, a resize, a frame or new data. */
import { MOUSE_OFF, MOUSE_ON, parseInput } from "./input";
import type { Loaded } from "./load";
import type { Comment, DiffState, GateDetail } from "./session";
import type { StatsData } from "./stats-load";
import { diffKey } from "./tabs";
import {
  detailKey,
  type Effect,
  initialModel,
  isAnimated,
  type Model,
  mouseUpdate,
  render,
  takeEffects,
  tick,
  update,
  withData,
  withDetail,
  withDiff,
  withStats,
} from "./view";

const FRAME_MS = 100;
const REFRESH_MS = 2000;
/** How often the card of a run that is going on is read again. */
const DETAIL_REFRESH_MS = 4000;
/** How often the pipeline on the Report screen is read again: it only changes when a run ends. */
const STATS_REFRESH_MS = 60_000;

export interface TuiOptions {
  /** Start with mouse events on; `m` turns them on and off while the screen is open. */
  mouse?: boolean;
  /** Reads what the card of a run at a human step shows; called for the selected run only. */
  loadDetail?: (runId: string) => Promise<GateDetail | undefined>;
  /** Reads the diff of one changed file of a run. */
  loadDiff?: (runId: string, path: string) => Promise<DiffState>;
  /** Records a comment at the gate of a run, or takes one out. A person's act, never an agent's. */
  addComment?: (runId: string, node: string, attempt: number, comment: Comment) => Promise<void>;
  deleteComment?: (runId: string, node: string, attempt: number, index: number) => Promise<void>;
  /** Sums up the runs of a pipeline for the Report screen. */
  loadStats?: (pipeline: string) => Promise<StatsData>;
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
  // The card of a run at a human step, or of one that is going on, is read when the run is selected
  // (it asks git), one at a time. A run that is going on is read again from time to time, since it
  // changes under the person's eyes; a failed read is not retried until the selection moves.
  const reading = new Set<string>();
  const readAt = new Map<string, number>();
  const ensureDetail = (again = false) => {
    const wanted = model.sessions.find((x) => x.id === model.selected);
    if (!options.loadDetail || !wanted) return;
    if (wanted.need !== "approve" && wanted.status !== "running") return;
    const key = detailKey(wanted);
    const stale =
      wanted.status === "running" && Date.now() - (readAt.get(key) ?? 0) > DETAIL_REFRESH_MS;
    if (reading.has(key) || (!again && !stale && key in model.details)) return;
    reading.add(key);
    readAt.set(key, Date.now());
    options
      .loadDetail(wanted.id)
      .then((detail) => {
        if (detail) model = withDetail(model, key, detail);
      })
      .catch(() => undefined)
      .finally(() => {
        reading.delete(key);
        draw();
      });
  };
  /** What the screen asked for and cannot do itself: a diff to read, a comment to write. */
  const perform = (effect: Effect) => {
    const failed = (what: string) => (error: unknown) => {
      model = {
        ...model,
        notice: `${what}: ${error instanceof Error ? error.message : String(error)}`,
      };
    };
    if (effect.type === "load_stats") {
      const read = options.loadStats?.(effect.pipeline);
      if (!read) {
        model = withStats(model, effect.pipeline, {
          status: "failed",
          error: "not available here",
        });
        return;
      }
      read
        .then((data) => {
          model = withStats(model, effect.pipeline, { status: "ready", data });
        })
        .catch((error: unknown) => {
          // A report that was read stays on the screen when the next read fails.
          if (model.stats[effect.pipeline]?.status === "ready") return;
          model = withStats(model, effect.pipeline, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(draw);
      return;
    }
    if (effect.type === "load_diff") {
      const read = options.loadDiff?.(effect.runId, effect.path);
      if (!read) return;
      read
        .then((diff) => {
          model = withDiff(model, diffKey(effect.runId, effect.path), diff);
        })
        .catch(failed("Cannot read the diff"))
        .finally(draw);
      return;
    }
    const write =
      effect.type === "add_comment"
        ? options.addComment?.(effect.runId, effect.node, effect.attempt, effect.comment)
        : options.deleteComment?.(effect.runId, effect.node, effect.attempt, effect.index);
    if (!write) {
      model = { ...model, notice: "Comments cannot be written here." };
      return;
    }
    write
      .then(() => {
        model = {
          ...model,
          notice: effect.type === "add_comment" ? "Comment saved." : "Comment deleted.",
        };
        ensureDetail(true);
      })
      .catch(failed("Could not change the comments"))
      .finally(draw);
  };
  const flush = () => {
    const [clean, effects] = takeEffects(model);
    model = clean;
    for (const effect of effects) perform(effect);
  };
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
          ensureDetail();
          draw();
        });
    }, REFRESH_MS);

    const statsRefresh = setInterval(() => {
      if (model.section === 3 && model.rep.selected !== "") {
        perform({ type: "load_stats", pipeline: model.rep.selected });
      }
    }, STATS_REFRESH_MS);

    const finish = () => {
      clearInterval(frames);
      clearInterval(refresh);
      clearInterval(statsRefresh);
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      stdin.pause();
      restore();
      resolve(0);
    };
    const onData = (chunk: string) => {
      const before = model.selected;
      for (const event of parseInput(chunk)) {
        model =
          event.type === "key"
            ? update(model, event.name, size())
            : mouseUpdate(model, size(), event);
        if (model.quit) break;
      }
      if (model.quit) {
        finish();
        return;
      }
      flush();
      ensureDetail(model.selected !== before);
      draw();
    };
    const onResize = () => {
      stdout.write("\u001b[2J");
      draw();
    };
    stdin.on("data", onData);
    stdout.on("resize", onResize);
    ensureDetail();
    draw();
  });
}
