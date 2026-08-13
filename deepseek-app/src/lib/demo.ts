import type { ChatMessage, Thread } from "../types";

export const DEMO_PROMPT = "给这个 demo 页面加一个暗色模式开关，并补一个简单测试说明。";

export function demoThread(thread: Thread): Thread {
  const user: ChatMessage = {
    id: "demo_user",
    role: "user",
    createdAt: Date.now() - 20_000,
    blocks: [{ type: "text", text: DEMO_PROMPT }],
  };
  const assistant: ChatMessage = {
    id: "demo_assistant",
    role: "assistant",
    createdAt: Date.now() - 5_000,
    blocks: [
      {
        type: "thinking",
        text: "先看现有 HTML/CSS/JS，再加一个不破坏现有计数器的 theme toggle。",
      },
      {
        type: "tool",
        tool: {
          id: "demo_read",
          name: "read_file",
          args: { path: "index.html" },
          result: "<!DOCTYPE html> ...",
          ok: true,
          durationMs: 42,
        },
      },
      {
        type: "tool",
        tool: {
          id: "demo_edit",
          name: "edit_file",
          args: { path: "index.html", old_text: "<h1>Hello DeepSeek</h1>", new_text: "<h1>Hello DeepSeek</h1>\n      <button id=\"theme\">Toggle dark</button>" },
          result: "Updated index.html",
          ok: true,
          durationMs: 88,
        },
      },
      {
        type: "text",
        text: "已经加上暗色模式开关：\n\n- `index.html` 增加 Toggle dark 按钮\n- `src/main.js` 切换 `document.body.dataset.theme`\n- `styles.css` 增加 `[data-theme='dark']` 变量\n\n本地运行 `npm run dev` 后，agent 还可以执行终端命令。打开 Settings 填入 DeepSeek API Key 即可开始真实任务。",
      },
    ],
  };
  return {
    ...thread,
    title: "Demo: dark mode toggle",
    status: "idle",
    messages: [user, assistant],
    todos: [
      { id: "1", content: "Inspect current page", status: "completed" },
      { id: "2", content: "Add theme toggle", status: "completed" },
    ],
    changes: [
      {
        path: "index.html",
        before: "<h1>Hello DeepSeek</h1>",
        after: "<h1>Hello DeepSeek</h1>\n      <button id=\"theme\">Toggle dark</button>",
      },
    ],
  };
}
