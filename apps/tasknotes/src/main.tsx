import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MdbaseConnect, MdbaseConnectError } from "@mdbase/connect";
import { TasknotesCollection, type TaskFrontmatter, type TaskSummary } from "@mdbase/tasknotes";
import "./styles.css";

const serverUrl = import.meta.env.VITE_CONNECT_SERVER_URL ?? "http://127.0.0.1:8787";
const requestedOperations = ["describe", "changes", "read", "query", "create", "update"] as const;

function App() {
  const connect = useMemo(() => new MdbaseConnect<TaskFrontmatter>({ serverUrl }), []);
  const [bound, setBound] = useState(() => {
    const first = connect.connections()[0];
    return first ? connect.connection(first.collectionId) : null;
  });
  const tasknotes = useMemo(() => bound ? new TasknotesCollection(bound) : null, [bound]);
  const connection = bound?.info() ?? null;
  const connected = connection !== null;
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const loadGeneration = useRef(0);

  useEffect(() => connect.onConnectionsChange((connections) => {
    const current = bound && connect.connection(bound.collectionId);
    if (current) setBound(current);
    else setBound(connections[0] ? connect.connection(connections[0].collectionId) : null);
  }), [bound, connect]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      if (!tasknotes) return;
      const next = await tasknotes.list();
      if (generation === loadGeneration.current) {
        setTasks(next);
        setError(undefined);
      }
    } catch (caught) {
      if (generation === loadGeneration.current) setError(message(caught));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [tasknotes]);

  useEffect(() => {
    const callback = new URL(location.href);
    if (!callback.searchParams.has("code")) return;
    connect.completeAuthorization()
      .then(({ connection }) => {
        history.replaceState({}, "", callback.pathname);
        setBound(connection);
      })
      .catch((caught) => setError(message(caught)));
  }, [connect]);

  useEffect(() => {
    if (!connected) return;
    if (!bound) return;
    void bound.checkDirectAccess();
    void load();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of bound.watch({ signal: controller.signal })) {
          if (event.type.startsWith("mdbase.record.") || event.type === "mdbase.type.changed") {
            await load();
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(message(caught));
      }
    })();
    return () => controller.abort();
  }, [bound, connected, load]);

  async function addTask(event: React.FormEvent) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    setSaving(true);
    try {
      if (!tasknotes) return;
      await tasknotes.create({ title: nextTitle });
      setTitle("");
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(task: TaskSummary) {
    setTasks((current) => current.map((item) => item.path === task.path
      ? { ...item, completed: !item.completed }
      : item));
    try {
      if (!tasknotes) return;
      await tasknotes.setCompleted(task.path, !task.completed);
      await load();
    } catch (caught) {
      setError(message(caught));
      await load();
    }
  }

  if (!connected) {
    return <main className="welcome">
      <div>
        <p className="wordmark">TaskNotes</p>
        <h1>Your tasks, wherever you need them.</h1>
        <p>Use this app with a TaskNotes collection on your computer.</p>
        <button className="primary" onClick={() => void connect.authorize({ operations: [...requestedOperations] })}>
          Connect a collection
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </main>;
  }

  return <main className="shell">
    <header>
      <div>
        <p className="wordmark">TaskNotes</p>
        <p className="connection">{connection?.route === "direct" ? "Connected directly" : "Connected through mdbase"}</p>
        {connection?.directAccess === "permission_required" && (
          <div className="direct-option">
            <button className="direct-access" aria-describedby="direct-access-hint" onClick={() => void bound?.requestDirectAccess()}>
              Connect directly
            </button>
            <span id="direct-access-hint">Let TaskNotes reach mdbase on this computer.</span>
          </div>
        )}
      </div>
      <button className="quiet" onClick={() => {
        bound?.forget();
        setBound(null);
        setTasks([]);
      }}>Disconnect</button>
    </header>

    <section aria-labelledby="tasks-heading">
      <h1 id="tasks-heading">Tasks</h1>
      <form className="quick-add" onSubmit={addTask}>
        <label className="sr-only" htmlFor="new-task">New task</label>
        <input
          id="new-task"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Add a task"
          autoComplete="off"
        />
        <button disabled={!title.trim() || saving}>{saving ? "Adding" : "Add"}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && tasks.length === 0 ? <div className="loading" aria-label="Loading tasks">
        <span /><span /><span />
      </div> : tasks.length === 0 ? <p className="empty">No tasks yet. Add the first one above.</p> :
        <ul className="task-list">
          {tasks.map((task) => <li key={task.path}>
            <label>
              <input
                type="checkbox"
                checked={task.completed}
                onChange={() => void toggle(task)}
              />
              <span className={task.completed ? "completed" : ""}>{task.title}</span>
            </label>
          </li>)}
        </ul>}
    </section>
  </main>;
}

function message(error: unknown): string {
  if (error instanceof MdbaseConnectError && error.code === "connector_offline") {
    return "The computer hosting this collection is offline.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
