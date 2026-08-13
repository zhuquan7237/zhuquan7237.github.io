import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMode, AppState, ChatMessage, Settings, Thread } from "./types";
import { MODELS } from "./types";
import { createAssistantSkeleton, createUserMessage, runAgentTurn } from "./lib/agent";
import { demoThread } from "./lib/demo";
import {
  createThread,
  loadState,
  saveState,
  titleFromPrompt,
} from "./lib/storage";
import { loadLocalDisk, openNativeFolder, probeLocal, restoreMemoryHost } from "./lib/host";
import type { ToolHost } from "./lib/agent";
import { renderMarkdown } from "./lib/markdown";
import { listPaths, unifiedDiff } from "./lib/workspace";

const STARTERS = [
  "总结当前工作区，并指出可以改进的地方",
  "给 index.html 加上暗色模式",
  "为 src/math.ts 写一组 vitest 测试",
  "把这个页面改成一个番茄钟",
];

export function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [local, setLocal] = useState(false);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [host, setHost] = useState<ToolHost | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"files" | "diff" | "todos">("files");
  const [draft, setDraft] = useState("");
  const [activeFile, setActiveFile] = useState("README.md");
  const abortRef = useRef<AbortController | null>(null);

  const thread = state.threads.find((item) => item.id === state.activeThreadId) ?? state.threads[0];
  const projectThreads = state.threads.filter((item) => item.projectId === state.activeProjectId);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const isLocal = await probeLocal();
      if (cancelled) return;
      setLocal(isLocal);
      if (isLocal) {
        const root = state.settings.workspaceRoot || guessRoot();
        try {
          const loaded = await loadLocalDisk(root);
          if (cancelled) return;
          setFiles(loaded.files);
          setHost(loaded.host);
          setActiveFile(Object.keys(loaded.files)[0] ?? "");
          return;
        } catch {
          // fall through to memory workspace
        }
      }
      const restored = restoreMemoryHost();
      if (cancelled) return;
      setFiles(restored.host.getFiles());
      setHost(restored.host);
    })();
    return () => {
      cancelled = true;
    };
  }, [state.settings.workspaceRoot]);

  const fileTree = useMemo(() => listPaths(files), [files]);

  async function send(text: string, mode: AgentMode = thread?.mode ?? "agent") {
    const prompt = text.trim();
    if (!prompt || !thread || !host) return;
    if (!state.settings.apiKey) {
      setSettingsOpen(true);
      return;
    }
    setDraft("");
    const user = createUserMessage(prompt);
    const assistant = createAssistantSkeleton();
    const nextTitle = thread.messages.length ? thread.title : titleFromPrompt(prompt);
    patchThread(thread.id, (current) => ({
      ...current,
      title: nextTitle,
      mode,
      model: state.settings.model,
      status: "running",
      error: undefined,
      updatedAt: Date.now(),
      messages: [...current.messages, user, assistant],
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    const working: ChatMessage[] = [...thread.messages, user];
    try {
      const result = await runAgentTurn({
        settings: state.settings,
        mode,
        messages: working,
        host,
        signal: controller.signal,
        onEvent: (event) => {
          setFiles({ ...host.getFiles() });
          patchThread(thread.id, (current) => {
            const messages = current.messages.map((message) =>
              message.id === assistant.id ? applyEvent(message, event) : message,
            );
            return { ...current, messages, status: "running", updatedAt: Date.now() };
          });
        },
      });
      patchThread(thread.id, (current) => ({
        ...current,
        status: "idle",
        todos: result.todos.length ? result.todos : current.todos,
        changes: mergeChanges(current.changes, result.changes),
        updatedAt: Date.now(),
      }));
      setFiles({ ...host.getFiles() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchThread(thread.id, (current) => ({
        ...current,
        status: message.includes("abort") ? "idle" : "error",
        error: message.includes("abort") ? undefined : message,
        updatedAt: Date.now(),
      }));
    }
  }

  function patchThread(id: string, updater: (thread: Thread) => Thread) {
    setState((current) => ({
      ...current,
      threads: current.threads.map((item) => (item.id === id ? updater(item) : item)),
    }));
  }

  function newTask() {
    if (!state.activeProjectId) return;
    const created = createThread(state.activeProjectId, "New task");
    created.model = state.settings.model;
    setState((current) => ({
      ...current,
      threads: [created, ...current.threads],
      activeThreadId: created.id,
    }));
  }

  async function chooseFolder() {
    const native = await openNativeFolder();
    if (native) {
      setFiles(native.files);
      setHost(native.host);
      setActiveFile(Object.keys(native.files)[0] ?? "");
      setState((current) => ({
        ...current,
        settings: { ...current.settings, workspaceRoot: native.name },
      }));
      return;
    }
    if (local) {
      const root = window.prompt("Workspace absolute path", state.settings.workspaceRoot || guessRoot());
      if (!root) return;
      const loaded = await loadLocalDisk(root);
      setFiles(loaded.files);
      setHost(loaded.host);
      setState((current) => ({
        ...current,
        settings: { ...current.settings, workspaceRoot: root },
      }));
    }
  }

  function runDemo() {
    if (!thread) return;
    patchThread(thread.id, (current) => demoThread(current));
  }

  if (!thread) return null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
              <path d="M8 18c3-6 13-6 16 0-3 5-13 5-16 0z" fill="#4D93F8" />
            </svg>
          </div>
          <div>
            <h1>DeepSeek App</h1>
            <p>{local ? "Local harness mode" : "Browser workspace"}</p>
          </div>
        </div>
        <div className="row-actions">
          <button className="btn btn-primary" onClick={newTask}>
            New task
          </button>
        </div>
        <div className="section-label">Threads</div>
        <div className="thread-list">
          {projectThreads.map((item) => (
            <button
              key={item.id}
              className={`thread-item${item.id === thread.id ? " active" : ""}`}
              onClick={() => setState((current) => ({ ...current, activeThreadId: item.id }))}
            >
              <strong>
                <span className={`status-dot ${item.status}`} />
                {item.title}
              </strong>
              <span>
                {item.mode} · {item.model.replace("deepseek-", "")}
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="btn btn-small" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="btn btn-small" onClick={chooseFolder}>
            Workspace
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h2>{thread.title}</h2>
            <div className="meta">
              {local ? "Local disk + bash" : "In-browser files"} · {Object.keys(files).length} files
            </div>
          </div>
          <div className="pills">
            {(["agent", "plan", "ask"] as AgentMode[]).map((mode) => (
              <button
                key={mode}
                className={`pill${thread.mode === mode ? " active" : ""}`}
                onClick={() => patchThread(thread.id, (current) => ({ ...current, mode }))}
              >
                {mode}
              </button>
            ))}
          </div>
        </header>

        <div className="thread-scroll">
          {thread.messages.length === 0 && (
            <div className="empty-hero">
              <h3>What should we build?</h3>
              <p>
                DeepSeek App 是一个 Codex 风格的编程助手：多任务线程、Plan/Agent/Ask、文件 diff，以及
                DeepSeek V4 的 tool loop。基于 DeepSeek Harness 的会话、工具与计划模式思路。
              </p>
              <div className="chips">
                {STARTERS.map((item) => (
                  <button key={item} className="chip" onClick={() => send(item)}>
                    {item}
                  </button>
                ))}
                <button className="chip" onClick={runDemo}>
                  查看 Demo 轨迹
                </button>
              </div>
            </div>
          )}
          {thread.messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
          {thread.error && <div className="tool-card">{thread.error}</div>}
        </div>

        <div className="composer">
          <div className="composer-box">
            <textarea
              value={draft}
              placeholder={
                thread.mode === "plan"
                  ? "描述目标，先让 agent 给出实现计划…"
                  : thread.mode === "ask"
                    ? "询问代码，不修改文件…"
                    : "把任务交给 DeepSeek…"
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            <div className="composer-bar">
              <select
                className="select"
                value={state.settings.model}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    settings: { ...current.settings, model: event.target.value as Settings["model"] },
                  }))
                }
              >
                {MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
              {thread.status === "running" ? (
                <button className="send" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button className="send" disabled={!draft.trim()} onClick={() => void send(draft)}>
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      <aside className="inspector">
        <div className="tabs">
          {(["files", "diff", "todos"] as const).map((item) => (
            <button key={item} className={`tab${tab === item ? " active" : ""}`} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </div>
        {tab === "files" && (
          <div className="file-tree">
            {fileTree.map((path) => (
              <button
                key={path}
                className={`file-item${activeFile === path ? " active" : ""}`}
                onClick={() => setActiveFile(path)}
              >
                <strong>{path}</strong>
              </button>
            ))}
            {files[activeFile] !== undefined && (
              <pre className="md-code" style={{ margin: 12 }}>
                {files[activeFile].slice(0, 4000)}
              </pre>
            )}
          </div>
        )}
        {tab === "diff" && (
          <div className="diff mono">
            {thread.changes.length === 0 && <div className="meta">No file changes yet.</div>}
            {thread.changes.map((change) => (
              <div key={change.path}>
                <div className="path">{change.path}</div>
                {(unifiedDiff(change.path, change.before ?? "", change.after ?? "") || "")
                  .split("\n")
                  .map((line, index) => (
                    <div key={index} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>
                      {line}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}
        {tab === "todos" && (
          <div>
            {thread.todos.length === 0 && <div className="meta" style={{ padding: 12 }}>No todos.</div>}
            {thread.todos.map((todo) => (
              <div key={todo.id} className={`todo ${todo.status}`}>
                <span className="box" />
                <span>{todo.content}</span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {settingsOpen && (
        <SettingsModal
          settings={state.settings}
          local={local}
          onClose={() => setSettingsOpen(false)}
          onSave={(settings) => {
            setState((current) => ({ ...current, settings }));
            setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return <div className="msg msg-user">{message.blocks.map((block) => block.text).join("\n")}</div>;
  }
  return (
    <div className="msg msg-assistant">
      {message.blocks.map((block, index) => {
        if (block.type === "thinking" && block.text) {
          return (
            <div className="thinking" key={index}>
              {block.text}
            </div>
          );
        }
        if (block.type === "tool" && block.tool) {
          return (
            <div className="tool-card" key={index}>
              <header>
                <span>
                  {block.tool.name} {String(block.tool.args.path ?? block.tool.args.command ?? block.tool.args.pattern ?? "")}
                </span>
                <span>{block.tool.ok ? "ok" : "error"} · {block.tool.durationMs}ms</span>
              </header>
              {block.tool.result && <pre>{block.tool.result.slice(0, 1200)}</pre>}
            </div>
          );
        }
        if ((block.type === "text" || block.type === "plan") && block.text) {
          return <div className="md" key={index} dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />;
        }
        if (block.type === "error") {
          return <div className="tool-card" key={index}>{block.text}</div>;
        }
        return null;
      })}
    </div>
  );
}

function SettingsModal({
  settings,
  local,
  onSave,
  onClose,
}: {
  settings: Settings;
  local: boolean;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>Settings</h3>
        <p className="meta">API key 只保存在本机浏览器。GitHub Pages 直连可能受 CORS 限制，本地 `npm run dev` 会走代理。</p>
        <label className="field">
          DeepSeek API Key
          <input
            type="password"
            value={draft.apiKey}
            placeholder="sk-..."
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
        </label>
        <label className="field">
          Base URL
          <input
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </label>
        <label className="field">
          Default model
          <select
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value as Settings["model"] })}
          >
            {MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} — {model.hint}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.thinking}
              onChange={(event) => setDraft({ ...draft, thinking: event.target.checked })}
            />{" "}
            Enable thinking
          </span>
        </label>
        {local && (
          <label className="field">
            Local workspace path
            <input
              value={draft.workspaceRoot}
              placeholder="/path/to/repo"
              onChange={(event) => setDraft({ ...draft, workspaceRoot: event.target.value })}
            />
          </label>
        )}
        <div className="notice">
          {local
            ? "已连接到本地 DeepSeek App 服务：可读写磁盘并执行 bash。"
            : "当前是浏览器工作区。Chrome 可打开真实文件夹；完整终端请在仓库里运行 npm run dev。"}
        </div>
        <div className="row-actions" style={{ padding: "16px 0 0" }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function applyEvent(message: ChatMessage, event: { type: string; text?: string; tool?: ChatMessage["blocks"][number]["tool"]; error?: string }): ChatMessage {
  const blocks = message.blocks.map((block) => ({ ...block }));
  if (event.type === "thinking") {
    const last = blocks.at(-1);
    if (last?.type === "thinking") last.text = event.text;
    else blocks.push({ type: "thinking", text: event.text });
  } else if (event.type === "text" || event.type === "plan") {
    const last = blocks.at(-1);
    if (last?.type === event.type) last.text = event.text;
    else blocks.push({ type: event.type as "text" | "plan", text: event.text });
  } else if (event.type === "tool_start" && event.tool) {
    blocks.push({ type: "tool", tool: event.tool });
  } else if (event.type === "tool_end" && event.tool) {
    const index = blocks.findIndex((block) => block.tool?.id === event.tool?.id);
    if (index >= 0) blocks[index] = { type: "tool", tool: event.tool };
  } else if (event.type === "error") {
    blocks.push({ type: "error", text: event.error });
  }
  return { ...message, blocks };
}

function mergeChanges(
  current: Thread["changes"],
  incoming: Thread["changes"],
): Thread["changes"] {
  const map = new Map(current.map((item) => [item.path, item]));
  for (const change of incoming) {
    const prev = map.get(change.path);
    map.set(change.path, prev ? { ...prev, after: change.after } : change);
  }
  return [...map.values()];
}

function guessRoot(): string {
  return "/workspace";
}
