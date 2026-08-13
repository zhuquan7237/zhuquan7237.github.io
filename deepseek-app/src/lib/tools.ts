import type { ToolSpec } from "../types";

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders under a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path; empty means workspace root" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a JavaScript regular expression.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          glob: { type: "string", description: "Optional glob, default **/*" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find file paths matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "e.g. src/**/*.ts" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the workspace. Only available in local mode.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Replace the current task list shown to the user.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a public URL and return text content.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
];

export function systemPrompt(options: {
  mode: "agent" | "plan" | "ask";
  local: boolean;
  language: "zh" | "en";
  files: string[];
}): string {
  const lang =
    options.language === "zh"
      ? "Reply in Simplified Chinese unless the user writes in another language."
      : "Reply in English unless the user writes in another language.";
  const mode =
    options.mode === "plan"
      ? "You are in plan mode. Inspect the workspace, then write a concrete implementation plan. Do not edit files unless the user later asks you to execute the plan."
      : options.mode === "ask"
        ? "You are in ask mode. Answer questions about the workspace. Do not write or edit files."
        : "You are in agent mode. Solve the user's coding task by reading and editing workspace files. Prefer small, working changes.";
  const shell = options.local
    ? "The bash tool runs on the user's machine in the workspace directory."
    : "bash is unavailable in the in-browser workspace. Use file tools only.";
  const listing = options.files.slice(0, 80).join("\n") || "(empty workspace)";
  return `You are DeepSeek App, a Codex-style coding agent built on DeepSeek Harness ideas: session log, tool loop, plan mode, and workspace tools.

${mode}
${lang}
${shell}

Rules:
- Use tools to inspect the workspace before changing it.
- Keep edits focused. After edits, summarize what changed.
- For multi-step work, maintain todos.
- Never invent file contents you have not read.
- Paths are relative to the workspace root.

Workspace files:
${listing}`;
}
