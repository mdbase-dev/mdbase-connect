import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MdbaseConnect, MdbaseConnectError, type JsonObject } from "@mdbase/connect";
import {
  TasknotesCollection,
  type TaskFieldDefinition,
  type TaskFrontmatter,
  type TasknotesContract,
  type TaskSummary
} from "@mdbase/tasknotes";
import {
  editableTaskFields,
  missingRequiredFields,
  requiredCreateFields,
  taskFieldPatch,
  taskFieldValue
} from "./taskFields";
import "./styles.css";

const serverUrl = import.meta.env.VITE_CONNECT_SERVER_URL ?? "http://127.0.0.1:8787";
const requestedOperations = [
  "describe",
  "changes",
  "read",
  "query",
  "create",
  "update",
  "rename"
] as const;

function App() {
  const connect = useMemo(() => new MdbaseConnect<TaskFrontmatter>({ serverUrl }), []);
  const [bound, setBound] = useState(() => {
    const first = connect.connections()[0];
    return first ? connect.connection(first.collectionId) : null;
  });
  const tasknotes = useMemo(() => bound ? new TasknotesCollection(bound) : null, [bound]);
  const connection = bound?.info() ?? null;
  const connected = connection !== null;
  const [contract, setContract] = useState<TasknotesContract>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [title, setTitle] = useState("");
  const [creationValues, setCreationValues] = useState<Record<string, string | boolean>>({});
  const [expandedPath, setExpandedPath] = useState<string>();
  const [busyPath, setBusyPath] = useState<string>();
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
      const activeContract = await tasknotes.describe();
      const next = await tasknotes.list();
      if (generation === loadGeneration.current) {
        setContract(activeContract);
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
    if (!tasknotes) return;
    void bound.checkDirectAccess();
    void load();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of bound.watch({ signal: controller.signal })) {
          if (event.type === "mdbase.type.changed") {
            setContract(await tasknotes.refreshContract());
            await load();
          } else if (event.type.startsWith("mdbase.record.")) {
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
    const createFields = contract ? requiredCreateFields(contract) : [];
    const missing = missingRequiredFields(createFields, creationValues);
    if (missing.length > 0) {
      setError(`Complete the required ${missing.join(", ")} field${missing.length === 1 ? "" : "s"}.`);
      return;
    }
    setSaving(true);
    try {
      if (!tasknotes) return;
      await tasknotes.create({
        title: nextTitle,
        fields: taskFieldPatch(createFields, creationValues)
      });
      setTitle("");
      setCreationValues({});
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
      setBusyPath(task.path);
      await tasknotes.setCompleted(task.path, !task.completed);
      await load();
    } catch (caught) {
      setError(message(caught));
      await load();
    } finally {
      setBusyPath(undefined);
    }
  }

  async function updateStatus(task: TaskSummary, status: string) {
    if (!tasknotes || task.status === status) return;
    setBusyPath(task.path);
    try {
      await tasknotes.setStatus(task.path, status);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusyPath(undefined);
    }
  }

  async function updatePriority(task: TaskSummary, priority: string) {
    if (!tasknotes || task.priority === priority) return;
    setBusyPath(task.path);
    try {
      await tasknotes.setPriority(task.path, priority);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusyPath(undefined);
    }
  }

  async function saveFields(task: TaskSummary, fields: JsonObject) {
    if (!tasknotes) return;
    setBusyPath(task.path);
    try {
      await tasknotes.updateFields(task.path, fields);
      setExpandedPath(undefined);
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusyPath(undefined);
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
        setContract(undefined);
        setTasks([]);
      }}>Disconnect</button>
    </header>

    <section aria-labelledby="tasks-heading">
      <h1 id="tasks-heading">Tasks</h1>
      <form className="quick-add" onSubmit={addTask}>
        <div className="quick-add-title">
          <label className="sr-only" htmlFor="new-task">New task</label>
          <input
            id="new-task"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a task"
            autoComplete="off"
          />
          <button disabled={!title.trim() || saving}>{saving ? "Adding" : "Add"}</button>
        </div>
        {contract && requiredCreateFields(contract).length > 0 && (
          <div className="quick-add-required" aria-label="Required task details">
            {requiredCreateFields(contract).map((field, index) => (
              <TaskFieldControl
                key={field.key}
                id={`create-field-${index}`}
                field={field}
                value={creationValues[field.key] ?? (field.kind === "boolean" ? false : "")}
                onChange={(value) => setCreationValues((current) => ({
                  ...current,
                  [field.key]: value
                }))}
              />
            ))}
          </div>
        )}
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && tasks.length === 0 ? <div className="loading" aria-label="Loading tasks">
        <span /><span /><span />
      </div> : tasks.length === 0 ? <p className="empty">No tasks yet. Add the first one above.</p> :
        <ul className="task-list">
          {tasks.map((task) => <li key={task.path}>
            <div className="task-row">
              <label className="task-check">
                <input
                  type="checkbox"
                  checked={task.completed}
                  disabled={busyPath === task.path}
                  onChange={() => void toggle(task)}
                />
                <span className={task.completed ? "completed" : ""}>{task.title}</span>
              </label>
              {contract && <div className="task-controls">
                <label>
                  <span className="sr-only">Status for {task.title}</span>
                  <select
                    value={task.status ?? contract.configuration.status.default ?? ""}
                    disabled={busyPath === task.path}
                    onChange={(event) => void updateStatus(task, event.target.value)}
                  >
                    {contract.statuses.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </label>
                {contract.priorities.length > 0 && <label>
                  <span className="sr-only">Priority for {task.title}</span>
                  <select
                    value={task.priority ?? contract.configuration.priority?.default ?? ""}
                    disabled={busyPath === task.path}
                    onChange={(event) => void updatePriority(task, event.target.value)}
                  >
                    {contract.priorities.map((priority) => (
                      <option key={priority.value} value={priority.value}>{priority.label}</option>
                    ))}
                  </select>
                </label>}
                {editableTaskFields(contract).length > 0 && <button
                  type="button"
                  className="details-button"
                  aria-expanded={expandedPath === task.path}
                  aria-controls={`task-details-${safeId(task.path)}`}
                  onClick={() => setExpandedPath((current) =>
                    current === task.path ? undefined : task.path
                  )}
                >
                  {expandedPath === task.path ? "Close" : "Details"}
                </button>}
              </div>}
            </div>
            {contract && expandedPath === task.path && <TaskEditor
              id={`task-details-${safeId(task.path)}`}
              task={task}
              contract={contract}
              saving={busyPath === task.path}
              onSave={(fields) => saveFields(task, fields)}
            />}
          </li>)}
        </ul>}
    </section>
  </main>;
}

function TaskEditor({
  id,
  task,
  contract,
  saving,
  onSave
}: {
  id: string;
  task: TaskSummary;
  contract: TasknotesContract;
  saving: boolean;
  onSave: (fields: JsonObject) => Promise<void>;
}) {
  const fields = useMemo(() => editableTaskFields(contract), [contract]);
  const initialValues = useCallback(
    () => Object.fromEntries(
      fields.map((field) => [field.key, taskFieldValue(task.frontmatter, field)])
    ),
    [fields, task.frontmatter]
  );
  const [values, setValues] = useState<Record<string, string | boolean>>(initialValues);
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    setValues(initialValues());
    setValidationError(undefined);
  }, [initialValues]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const missing = missingRequiredFields(
      fields.filter((field) => field.required),
      values
    );
    if (missing.length > 0) {
      setValidationError(
        `Complete ${missing.join(", ")} before saving.`
      );
      return;
    }
    try {
      await onSave(taskFieldPatch(fields, values));
      setValidationError(undefined);
    } catch (caught) {
      setValidationError(message(caught));
    }
  }

  const preserved = contract.fields.filter(
    (field) => field.kind === "unsupported" && !field.readOnly
  ).length;

  return <form id={id} className="task-editor" onSubmit={(event) => void submit(event)}>
    <div className="field-grid">
      {fields.map((field, index) => <TaskFieldControl
        key={field.key}
        id={`${id}-field-${index}`}
        field={field}
        value={values[field.key] ?? (field.kind === "boolean" ? false : "")}
        onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
      />)}
    </div>
    {preserved > 0 && <p className="preservation-note">
      {preserved} advanced field{preserved === 1 ? " is" : "s are"} preserved without changes.
    </p>}
    {validationError && <p className="field-error" role="alert">{validationError}</p>}
    <div className="editor-actions">
      <button type="submit" disabled={saving}>{saving ? "Saving" : "Save details"}</button>
    </div>
  </form>;
}

function TaskFieldControl({
  id,
  field,
  value,
  onChange
}: {
  id: string;
  field: TaskFieldDefinition;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const descriptionId = field.description ? `${id}-description` : undefined;
  if (field.kind === "boolean") {
    return <label className="field-control boolean-field" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{field.label}{field.required && <b aria-hidden="true"> *</b>}</span>
      {field.description && <small id={descriptionId}>{field.description}</small>}
    </label>;
  }

  return <label className="field-control" htmlFor={id}>
    <span>{field.label}{field.required && <b aria-hidden="true"> *</b>}</span>
    {field.kind === "enum" ? <select
      id={id}
      value={String(value)}
      required={field.required}
      aria-describedby={descriptionId}
      onChange={(event) => onChange(event.target.value)}
    >
      {!field.required && <option value="">None</option>}
      {field.enumValues?.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select> : <input
      id={id}
      type={
        field.kind === "number" || field.kind === "integer"
          ? "number"
          : field.kind === "date"
            ? "date"
            : "text"
      }
      step={field.kind === "integer" ? "1" : field.kind === "number" ? "any" : undefined}
      value={String(value)}
      required={field.required}
      aria-describedby={descriptionId}
      placeholder={field.kind === "list" ? "Comma-separated values" : undefined}
      onChange={(event) => onChange(event.target.value)}
    />}
    {field.description && <small id={descriptionId}>{field.description}</small>}
  </label>;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function message(error: unknown): string {
  if (error instanceof MdbaseConnectError && error.code === "connector_offline") {
    return "The computer hosting this collection is offline.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
