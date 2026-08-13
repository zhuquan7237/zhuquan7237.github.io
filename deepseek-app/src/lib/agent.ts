import { toLlmMessages, streamChat } from "./llm";
import { systemPrompt, TOOL_SPECS } from "./tools";
import {
  applyEdit,
  globToRegExp,
  grepFiles,
  listPaths,
  normalizePath,
  unifiedDiff,
} from "./workspace";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  FileChange,
  LlmMessage,
  Settings,
  TodoItem,
  ToolCallRecord,
} from "../types";
import { uid } from "../types";

export interface ToolHost {
  local: boolean;
  getFiles(): Record<string, string>;
  setFile(path: string, content: string): Promise<void> | void;
  deleteFile?(path: string): Promise<void> | void;
  runBash?(command: string): Promise<string>;
  fetchUrl?(url: string): Promise<string>;
}

const ASK_BLOCKED = new Set(["write_file", "edit_file", "bash"]);

export async function runAgentTurn(options: {
  settings: Settings;
  mode: AgentMode;
  messages: ChatMessage[];
  host: ToolHost;
  signal?: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<{ todos: TodoItem[]; changes: FileChange[] }> {
  const todos: TodoItem[] = [];
  const changes: FileChange[] = [];
  const files = () => options.host.getFiles();
  const llmMessages: LlmMessage[] = [
    {
      role: "system",
      content: systemPrompt({
        mode: options.mode,
        local: options.host.local,
        language: options.settings.language,
        files: Object.keys(files()).sort(),
      }),
    },
    ...toLlmMessages(options.messages),
  ];

  const tools =
    options.mode === "ask"
      ? TOOL_SPECS.filter((tool) => !ASK_BLOCKED.has(tool.function.name))
      : options.mode === "plan"
        ? TOOL_SPECS.filter((tool) => tool.function.name !== "bash")
        : TOOL_SPECS;

  for (let step = 0; step < 16; step += 1) {
    let thinking = "";
    let text = "";
    let toolCalls: ToolCallRecord[] = [];
    for await (const delta of streamChat({
      apiKey: options.settings.apiKey,
      baseUrl: options.settings.baseUrl,
      model: options.settings.model,
      thinking: options.settings.thinking,
      messages: llmMessages,
      tools,
      signal: options.signal,
      localProxy: options.host.local,
    })) {
      if (delta.thinking) {
        thinking += delta.thinking;
        options.onEvent({ type: "thinking", text: thinking });
      }
      if (delta.text) {
        text += delta.text;
        options.onEvent({ type: "text", text });
      }
      if (delta.toolCalls?.length) {
        for (const call of delta.toolCalls) {
          const started = Date.now();
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = { raw: call.function.arguments };
          }
          options.onEvent({
            type: "tool_start",
            tool: {
              id: call.id,
              name: call.function.name,
              args,
              result: "",
              ok: true,
              durationMs: 0,
            },
          });
          const executed = await executeTool({
            name: call.function.name,
            args,
            mode: options.mode,
            host: options.host,
            files: files(),
          });
          if (executed.todos) {
            todos.splice(0, todos.length, ...executed.todos);
          }
          if (executed.change) upsertChange(changes, executed.change);
          const record: ToolCallRecord = {
            id: call.id,
            name: call.function.name,
            args,
            result: executed.result,
            ok: executed.ok,
            durationMs: Date.now() - started,
          };
          toolCalls.push(record);
          options.onEvent({ type: "tool_end", tool: record });
        }
      }
    }

    if (text && options.mode === "plan") {
      options.onEvent({ type: "plan", text });
    }

    llmMessages.push({
      role: "assistant",
      content: text || null,
      tool_calls: toolCalls.length
        ? toolCalls.map((tool) => ({
            id: tool.id,
            type: "function" as const,
            function: { name: String(tool.name), arguments: JSON.stringify(tool.args) },
          }))
        : undefined,
    });
    for (const tool of toolCalls) {
      llmMessages.push({
        role: "tool",
        tool_call_id: tool.id,
        content: tool.result,
      });
    }

    if (!toolCalls.length) {
      options.onEvent({ type: "done", text });
      return { todos, changes };
    }
  }

  options.onEvent({ type: "error", error: "Stopped after 16 tool steps" });
  return { todos, changes };
}

function upsertChange(changes: FileChange[], change: FileChange): void {
  const index = changes.findIndex((item) => item.path === change.path);
  if (index === -1) {
    changes.push(change);
    return;
  }
  changes[index] = { ...changes[index], after: change.after };
}

export async function executeTool(input: {
  name: string;
  args: Record<string, unknown>;
  mode: AgentMode;
  host: ToolHost;
  files: Record<string, string>;
}): Promise<{ ok: boolean; result: string; todos?: TodoItem[]; change?: FileChange }> {
  const name = input.name;
  if ((input.mode === "ask" || input.mode === "plan") && ASK_BLOCKED.has(name) && name !== "bash") {
    if (input.mode === "ask" && (name === "write_file" || name === "edit_file")) {
      return { ok: false, result: "Writing files is disabled in ask mode." };
    }
  }
  if (input.mode === "ask" && name === "bash") {
    return { ok: false, result: "bash is disabled in ask mode." };
  }
  if (input.mode === "plan" && (name === "write_file" || name === "edit_file")) {
    return { ok: false, result: "Editing is disabled in plan mode. Propose the plan only." };
  }

  try {
    switch (name) {
      case "read_file": {
        const path = normalizePath(String(input.args.path ?? ""));
        const content = input.files[path];
        if (content === undefined) return { ok: false, result: `File not found: ${path}` };
        return { ok: true, result: content.slice(0, 80_000) };
      }
      case "write_file": {
        const path = normalizePath(String(input.args.path ?? ""));
        const content = String(input.args.content ?? "");
        const before = input.files[path] ?? null;
        await input.host.setFile(path, content);
        return {
          ok: true,
          result: `Wrote ${path} (${content.length} chars)`,
          change: { path, before, after: content },
        };
      }
      case "edit_file": {
        const path = normalizePath(String(input.args.path ?? ""));
        const current = input.files[path];
        if (current === undefined) return { ok: false, result: `File not found: ${path}` };
        const edited = applyEdit(
          current,
          String(input.args.old_text ?? ""),
          String(input.args.new_text ?? ""),
          Boolean(input.args.replace_all),
        );
        if (!edited.ok) return { ok: false, result: edited.error ?? "edit failed" };
        await input.host.setFile(path, edited.next);
        return {
          ok: true,
          result: unifiedDiff(path, current, edited.next) || `Updated ${path}`,
          change: { path, before: current, after: edited.next },
        };
      }
      case "list_dir": {
        const path = String(input.args.path ?? "");
        const listing = listPaths(input.files, path);
        return { ok: true, result: listing.join("\n") || "(empty)" };
      }
      case "grep": {
        const hits = grepFiles(
          input.files,
          String(input.args.pattern ?? ""),
          String(input.args.glob ?? "**/*"),
        );
        return { ok: true, result: hits.join("\n") || "No matches" };
      }
      case "glob": {
        const re = globToRegExp(String(input.args.pattern ?? "**/*"));
        const hits = Object.keys(input.files).filter((path) => re.test(path));
        return { ok: true, result: hits.join("\n") || "No matches" };
      }
      case "bash": {
        if (!input.host.runBash) {
          return { ok: false, result: "bash is only available when running DeepSeek App locally." };
        }
        const command = String(input.args.command ?? "");
        const output = await input.host.runBash(command);
        return { ok: true, result: output.slice(0, 80_000) };
      }
      case "todo_write": {
        const todos = Array.isArray(input.args.todos) ? (input.args.todos as TodoItem[]) : [];
        return { ok: true, result: `Updated ${todos.length} todos`, todos };
      }
      case "web_fetch": {
        const url = String(input.args.url ?? "");
        if (input.host.fetchUrl) {
          const text = await input.host.fetchUrl(url);
          return { ok: true, result: text.slice(0, 40_000) };
        }
        const response = await fetch(url);
        const text = await response.text();
        return { ok: true, result: text.slice(0, 40_000) };
      }
      default:
        return { ok: false, result: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return { ok: false, result: error instanceof Error ? error.message : String(error) };
  }
}

export function createUserMessage(text: string): ChatMessage {
  return {
    id: uid("msg"),
    role: "user",
    createdAt: Date.now(),
    blocks: [{ type: "text", text }],
  };
}

export function createAssistantSkeleton(): ChatMessage {
  return {
    id: uid("msg"),
    role: "assistant",
    createdAt: Date.now(),
    blocks: [],
  };
}
