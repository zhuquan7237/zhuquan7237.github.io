import { describe, expect, it } from "vitest";
import { applyEdit, globToRegExp, grepFiles, listPaths, normalizePath, unifiedDiff } from "./workspace";
import { executeTool } from "./agent";
import { toLlmMessages } from "./llm";
import { renderMarkdown } from "./markdown";
import { createMemoryHost } from "./host";
import { seedWorkspace } from "./workspace";
import type { ChatMessage } from "../types";

describe("workspace helpers", () => {
  it("normalizes and lists nested paths", () => {
    const files = { "src/main.js": "a", "src/lib/x.ts": "b", "README.md": "c" };
    expect(normalizePath("./src/../src/main.js")).toBe("src/main.js");
    expect(listPaths(files, "src")).toEqual(["src/lib", "src/main.js"]);
  });

  it("edits a unique snippet and rejects duplicates", () => {
    const once = applyEdit("hello world", "world", "deepseek");
    expect(once.ok).toBe(true);
    expect(once.next).toBe("hello deepseek");
    const dup = applyEdit("a a", "a", "b");
    expect(dup.ok).toBe(false);
    const all = applyEdit("a a", "a", "b", true);
    expect(all.next).toBe("b b");
  });

  it("greps and globs files", () => {
    const files = seedWorkspace().files;
    expect(grepFiles(files, "Hello DeepSeek")[0]).toContain("index.html");
    expect(Object.keys(files).filter((path) => globToRegExp("**/*").test(path))).toContain("index.html");
    expect(Object.keys(files).filter((path) => globToRegExp("src/**").test(path))).toContain("src/math.ts");
  });

  it("builds a unified diff", () => {
    const diff = unifiedDiff("a.txt", "one\ntwo", "one\nthree");
    expect(diff).toContain("-two");
    expect(diff).toContain("+three");
  });
});

describe("tools and messages", () => {
  it("reads and writes through the memory host", async () => {
    const host = createMemoryHost(seedWorkspace(), false);
    const read = await executeTool({
      name: "read_file",
      args: { path: "src/math.ts" },
      mode: "agent",
      host,
      files: host.getFiles(),
    });
    expect(read.ok).toBe(true);
    expect(read.result).toContain("export function add");

    const write = await executeTool({
      name: "write_file",
      args: { path: "notes.md", content: "hi" },
      mode: "ask",
      host,
      files: host.getFiles(),
    });
    expect(write.ok).toBe(false);

    const edit = await executeTool({
      name: "edit_file",
      args: { path: "src/math.ts", old_text: "return a + b;", new_text: "return a + b + 0;" },
      mode: "agent",
      host,
      files: host.getFiles(),
    });
    expect(edit.ok).toBe(true);
    expect(host.getFiles()["src/math.ts"]).toContain("a + b + 0");
  });

  it("projects chat history into LLM messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "u",
        role: "user",
        createdAt: 1,
        blocks: [{ type: "text", text: "hi" }],
      },
      {
        id: "a",
        role: "assistant",
        createdAt: 2,
        blocks: [
          { type: "thinking", text: "secret" },
          {
            type: "tool",
            tool: {
              id: "c1",
              name: "read_file",
              args: { path: "a.ts" },
              result: "ok",
              ok: true,
              durationMs: 1,
            },
          },
          { type: "text", text: "done" },
        ],
      },
    ];
    const llm = toLlmMessages(messages);
    expect(llm[0]).toEqual({ role: "user", content: "hi" });
    expect(llm[1]?.tool_calls?.[0]?.id).toBe("c1");
    expect(llm[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  it("renders markdown fences", () => {
    const html = renderMarkdown("Use `add`:\n\n```ts\nadd(1, 2)\n```");
    expect(html).toContain("<code>add</code>");
    expect(html).toContain("md-code");
    expect(html).not.toContain("```");
  });
});
