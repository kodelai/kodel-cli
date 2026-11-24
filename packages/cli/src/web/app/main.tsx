/** @jsxImportSource preact */
/** The web UI: pairing, the list of runs (kept current by the server's event stream) and a run. */
import { render } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../tui/session";
import { ApiError, api, type Me } from "./api";
import { Icon, type IconName } from "./icons";
import { RunsTab } from "./list";
import { nameOf, RunScreen, StepScreen } from "./run";
import { TaskScreen, TasksTab } from "./tasks";
import { Modal, Toast } from "./ui";

type TabName = "runs" | "pipelines" | "tasks" | "stats";
type Route =
  | { kind: "tab"; tab: TabName }
  | { kind: "run"; id: string }
  | { kind: "step"; id: string; index: number | "journal" }
  | { kind: "task"; key: string }
  | { kind: "pair"; code: string };

const TABS: { tab: TabName; label: string; icon: IconName }[] = [
  { tab: "runs", label: "Runs", icon: "inbox" },
  { tab: "pipelines", label: "Pipelines", icon: "route" },
  { tab: "tasks", label: "Tasks", icon: "tasks" },
  { tab: "stats", label: "Stats", icon: "chart" },
];

function routeOf(hash: string): Route {
  const pair = /^#pair=([A-Za-z0-9_-]+)$/.exec(hash);
  if (pair?.[1]) return { kind: "pair", code: pair[1] };
  const step = /^#\/run\/([^/]+)\/(?:step\/(\d+)|(journal))$/.exec(hash);
  if (step?.[1]) {
    return {
      kind: "step",
      id: decodeURIComponent(step[1]),
      index: step[3] ? "journal" : Number(step[2]),
    };
  }
  const task = /^#\/task\/([^/]+)$/.exec(hash);
  if (task?.[1]) return { kind: "task", key: decodeURIComponent(task[1]) };
  const run = /^#\/run\/([^/]+)$/.exec(hash);
  if (run?.[1]) return { kind: "run", id: decodeURIComponent(run[1]) };
  const tab = TABS.find((t) => hash === `#/${t.tab}`);
  return { kind: "tab", tab: tab?.tab ?? "runs" };
}

function TabBar(props: { current: TabName; waiting: number }) {
  return (
    <nav class="tabbar">
      {TABS.map((t) => (
        <a key={t.tab} href={`#/${t.tab}`} class={t.tab === props.current ? "on" : ""}>
          <span class="tab-icon">
            <Icon name={t.icon} />
            {t.tab === "runs" && props.waiting > 0 ? (
              <span class="badge">{props.waiting}</span>
            ) : null}
          </span>
          {t.label}
        </a>
      ))}
    </nav>
  );
}

function Soon(props: { title: string }) {
  return (
    <div class="screen">
      <header class="bar">
        <div class="bar-title">
          <h1>{props.title}</h1>
        </div>
      </header>
      <p class="empty">Coming next.</p>
    </div>
  );
}

function guessName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Browser";
}

function PairScreen(props: { code?: string; onPaired: () => void }) {
  const [name, setName] = useState(guessName());
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  if (props.code === undefined) {
    return (
      <div class="pair">
        <h1>Kodel</h1>
        <p>This device is not paired.</p>
        <p>
          On the computer where Kodel runs, type <code>kodel web pair</code> and scan the code it
          shows.
        </p>
      </div>
    );
  }
  const code = props.code;
  const pair = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.pair(code, name);
      history.replaceState(null, "", "#/");
      props.onPaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="pair">
      <h1>Pair this device</h1>
      <p>It will open this project's runs and decide on them, until you revoke it.</p>
      <label>
        Device name
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      {error ? <p class="bad">{error}</p> : null}
      <button type="button" class="btn primary wide" disabled={busy} onClick={pair}>
        Pair
      </button>
    </div>
  );
}

/** A screen by the place it is at: where the list was scrolled is kept per screen. */
const routeKey = (r: Route) =>
  r.kind === "tab"
    ? r.tab
    : r.kind === "run"
      ? `run:${r.id}`
      : r.kind === "step"
        ? `step:${r.id}:${r.index}`
        : r.kind === "task"
          ? `task:${r.key}`
          : "pair";

function App() {
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const scrolls = useRef(new Map<string, number>());
  const shown = useRef(routeKey(route));
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [sessions, setSessions] = useState<Session[] | undefined>();
  const [proposals, setProposals] = useState(0);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<{ text: string; ok: boolean; at: number } | undefined>();
  const [more, setMore] = useState(false);
  const [unreachable, setUnreachable] = useState(false);

  const notify = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), toast.ok ? 3_000 : 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    history.scrollRestoration = "manual";
    const onHash = () => {
      // Where the screen being left was scrolled, so that coming back finds the same place.
      scrolls.current.set(shown.current, window.scrollY);
      setRoute(routeOf(location.hash));
    };
    window.addEventListener("hashchange", onHash);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(tick);
    };
  }, []);

  const whoami = useCallback(() => {
    api
      .me()
      .then((m) => {
        setUnreachable(false);
        setMe(m);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setUnreachable(true);
      });
  }, []);
  useEffect(whoami, []);

  useLayoutEffect(() => {
    const key = routeKey(route);
    shown.current = key;
    window.scrollTo(0, scrolls.current.get(key) ?? 0);
  }, [route]);

  // A server that could not be reached is asked again until it answers.
  useEffect(() => {
    if (!unreachable) return;
    const t = setInterval(whoami, 3_000);
    return () => clearInterval(t);
  }, [unreachable, whoami]);

  useEffect(() => {
    if (!me) return;
    api
      .sessions()
      .then((r) => {
        setSessions(r.sessions);
        setProposals(r.proposals);
      })
      .catch(() => undefined);
    const events = new EventSource("/api/events");
    events.addEventListener("open", () => setLive(true));
    events.addEventListener("error", () => {
      setLive(false);
      // A device revoked meanwhile gets the pairing screen, not a stream that keeps failing.
      whoami();
    });
    events.addEventListener("sessions", (e) => {
      const data = JSON.parse((e as MessageEvent<string>).data) as {
        sessions: Session[];
        proposals: number;
      };
      setSessions(data.sessions);
      setProposals(data.proposals);
      setNow(Date.now());
    });
    return () => events.close();
  }, [me, whoami]);

  if (route.kind === "pair" && !me) {
    return <PairScreen code={route.code} onPaired={whoami} />;
  }
  if (me === undefined) {
    return unreachable ? (
      <div class="pair">
        <h1>Can't reach Kodel</h1>
        <p class="muted">
          Is <code>kodel web</code> running? Trying again…
        </p>
      </div>
    ) : (
      <p class="empty">Loading…</p>
    );
  }
  if (me === null) return <PairScreen onPaired={whoami} />;

  const waiting = sessions?.filter((s) => s.status === "waiting").length ?? 0;
  const tab: TabName = route.kind === "tab" ? route.tab : route.kind === "task" ? "tasks" : "runs";
  document.title = waiting > 0 ? `(${waiting}) Kodel` : "Kodel";

  return (
    <div class="app">
      {route.kind === "task" ? (
        <TaskScreen
          taskKey={route.key}
          sessions={sessions}
          me={me}
          now={now}
          notify={notify}
          nameOf={nameOf}
        />
      ) : route.kind === "step" ? (
        <StepScreen
          id={route.id}
          index={route.index}
          title={nameOf(sessions?.find((s) => s.id === route.id))}
        />
      ) : route.kind === "run" ? (
        <RunScreen
          id={route.id}
          session={sessions?.find((s) => s.id === route.id)}
          me={me}
          now={now}
          notify={notify}
        />
      ) : (
        <>
          {tab === "runs" ? (
            <RunsTab
              sessions={sessions}
              proposals={proposals}
              now={now}
              live={live}
              project={me.project}
              onMore={() => setMore(true)}
            />
          ) : tab === "tasks" && me.canTasks ? (
            <TasksTab me={me} onMore={() => setMore(true)} notify={notify} />
          ) : (
            <Soon title={TABS.find((t) => t.tab === tab)?.label ?? ""} />
          )}
          <TabBar current={tab} waiting={waiting} />
        </>
      )}
      {more ? (
        <Modal
          title={me.project}
          onClose={() => setMore(false)}
          actions={
            <button type="button" class="btn" onClick={() => setMore(false)}>
              Close
            </button>
          }
        >
          <div class="sheet-row">
            <span>Connection</span>
            <span class="muted">{live ? "live" : "offline"}</span>
          </div>
          <div class="sheet-row">
            <span>This device</span>
            <span class="muted">{me.device.name}</span>
          </div>
          {me.source === "demo" ? (
            <div class="sheet-row">
              <span>Data</span>
              <span class="muted">sample runs</span>
            </div>
          ) : null}
          <button
            type="button"
            class="sheet-row danger"
            onClick={async () => {
              if (!confirm(`Unpair "${me.device.name}"? You will need a new code to come back.`))
                return;
              await api.logout().catch(() => undefined);
              setMore(false);
              setMe(null);
            }}
          >
            Unpair this device
          </button>
        </Modal>
      ) : null}
      {toast ? <Toast text={toast.text} ok={toast.ok} /> : null}
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
