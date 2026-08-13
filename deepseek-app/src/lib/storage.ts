import { DEFAULT_SETTINGS, type AppState, type Project, type Thread, uid } from "../types";
import { seedWorkspace, type WorkspaceSnapshot } from "./workspace";

const STATE_KEY = "deepseek-app-state-v1";
const FILES_KEY = "deepseek-app-files-v1";

export function defaultState(): AppState {
  const project = createProject("Personal");
  const thread = createThread(project.id, "Welcome");
  return {
    settings: { ...DEFAULT_SETTINGS },
    projects: [project],
    threads: [thread],
    activeProjectId: project.id,
    activeThreadId: thread.id,
  };
}

export function createProject(name: string): Project {
  return { id: uid("proj"), name, createdAt: Date.now() };
}

export function createThread(projectId: string, title = "New task"): Thread {
  const now = Date.now();
  return {
    id: uid("thr"),
    projectId,
    title,
    mode: "agent",
    model: "deepseek-v4-flash",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    messages: [],
    todos: [],
    changes: [],
  };
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as AppState;
    return {
      ...defaultState(),
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: AppState): void {
  const copy: AppState = {
    ...state,
    settings: { ...state.settings, apiKey: state.settings.apiKey },
  };
  localStorage.setItem(STATE_KEY, JSON.stringify(copy));
}

export function loadFiles(): WorkspaceSnapshot {
  try {
    const raw = localStorage.getItem(FILES_KEY);
    if (!raw) return seedWorkspace();
    const parsed = JSON.parse(raw) as WorkspaceSnapshot;
    if (!parsed.files || typeof parsed.files !== "object") return seedWorkspace();
    return parsed;
  } catch {
    return seedWorkspace();
  }
}

export function saveFiles(snapshot: WorkspaceSnapshot): void {
  localStorage.setItem(FILES_KEY, JSON.stringify(snapshot));
}

export function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.slice(0, 42) || "New task";
}
