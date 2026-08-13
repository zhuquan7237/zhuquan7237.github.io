export type AgentMode = "agent" | "plan" | "ask";

export type ModelId = "deepseek-v4-flash" | "deepseek-v4-pro";

export type ThreadStatus = "idle" | "running" | "waiting" | "error";

export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_dir"
  | "grep"
  | "glob"
  | "bash"
  | "todo_write"
  | "web_fetch";

export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: ModelId;
  thinking: boolean;
  language: "zh" | "en";
  workspaceRoot: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ToolCallRecord {
  id: string;
  name: ToolName | string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  durationMs: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatBlock {
  type: "text" | "thinking" | "tool" | "plan" | "error";
  text?: string;
  tool?: ToolCallRecord;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  blocks: ChatBlock[];
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  mode: AgentMode;
  model: ModelId;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  todos: TodoItem[];
  changes: FileChange[];
  error?: string;
}

export interface AppState {
  settings: Settings;
  projects: Project[];
  threads: Thread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentEvent {
  type:
    | "thinking"
    | "text"
    | "tool_start"
    | "tool_end"
    | "plan"
    | "done"
    | "error";
  text?: string;
  tool?: ToolCallRecord;
  error?: string;
}

export const MODELS: Array<{ id: ModelId; label: string; hint: string }> = [
  { id: "deepseek-v4-flash", label: "V4 Flash", hint: "Fast coding agent" },
  { id: "deepseek-v4-pro", label: "V4 Pro", hint: "Frontier long-horizon" },
];

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinking: true,
  language: "zh",
  workspaceRoot: "",
};

export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
