export interface VirtualFile {
  path: string;
  content: string;
}

export interface WorkspaceSnapshot {
  files: Record<string, string>;
}

const SAMPLE_FILES: Record<string, string> = {
  "README.md": `# Demo workspace

This is an in-browser workspace for DeepSeek App.
Open a real folder (Chrome) or run \`npm run dev\` locally for shell access.

## Try asking

- Summarize this workspace
- Add a dark-mode toggle to index.html
- Write tests for src/math.ts
`,
  "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Demo</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main>
      <h1>Hello DeepSeek</h1>
      <p>A tiny demo page the agent can edit.</p>
      <button id="count">Clicked 0 times</button>
    </main>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
`,
  "styles.css": `body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  margin: 0;
  background: #f4f6fb;
  color: #152033;
}
main {
  max-width: 640px;
  margin: 64px auto;
}
button {
  border: 0;
  border-radius: 8px;
  padding: 10px 16px;
  background: #4d93f8;
  color: white;
}
`,
  "src/main.js": `const button = document.querySelector("#count");
let n = 0;
button?.addEventListener("click", () => {
  n += 1;
  button.textContent = \`Clicked \${n} times\`;
});
`,
  "src/math.ts": `export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
`,
  "package.json": `{
  "name": "demo-workspace",
  "private": true,
  "version": "0.0.1",
  "type": "module"
}
`,
};

export function normalizePath(input: string): string {
  const raw = input.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function seedWorkspace(): WorkspaceSnapshot {
  return { files: { ...SAMPLE_FILES } };
}

export function listPaths(files: Record<string, string>, dir = ""): string[] {
  const prefix = dir ? `${normalizePath(dir)}/` : "";
  const names = new Set<string>();
  for (const path of Object.keys(files)) {
    if (prefix && !path.startsWith(prefix) && path !== normalizePath(dir)) continue;
    const rest = prefix ? path.slice(prefix.length) : path;
    const [head] = rest.split("/");
    if (head) names.add(prefix ? `${normalizePath(dir)}/${head}` : head);
  }
  return [...names].sort();
}

export function globToRegExp(pattern: string): RegExp {
  const source = pattern.replaceAll("\\", "/");
  let regex = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "*" && next === "*") {
      if (source[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    if ("+.^${}()|[]\\".includes(char)) regex += `\\${char}`;
    else regex += char;
  }
  return new RegExp(`^${regex}$`);
}

export function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): { ok: boolean; next: string; error?: string } {
  if (!oldText) return { ok: false, next: content, error: "old_text is empty" };
  if (!content.includes(oldText)) {
    return { ok: false, next: content, error: "old_text not found in file" };
  }
  if (!replaceAll) {
    const first = content.indexOf(oldText);
    const second = content.indexOf(oldText, first + oldText.length);
    if (second !== -1) {
      return {
        ok: false,
        next: content,
        error: "old_text matched more than once; pass replace_all or more context",
      };
    }
  }
  const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
  return { ok: true, next };
}

export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  const max = Math.max(a.length, b.length);
  let hunk: string[] = [];
  let start = 0;
  const flush = () => {
    if (!hunk.length) return;
    lines.push(`@@ -${start + 1} +${start + 1} @@`);
    lines.push(...hunk);
    hunk = [];
  };
  for (let i = 0; i < max; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      if (hunk.length) flush();
      continue;
    }
    if (!hunk.length) start = i;
    if (left !== undefined && right === undefined) hunk.push(`-${left}`);
    else if (right !== undefined && left === undefined) hunk.push(`+${right}`);
    else {
      hunk.push(`-${left}`);
      hunk.push(`+${right}`);
    }
  }
  flush();
  return lines.join("\n");
}

export function grepFiles(
  files: Record<string, string>,
  pattern: string,
  glob = "**/*",
): string[] {
  const re = new RegExp(pattern, "i");
  const globRe = globToRegExp(glob);
  const hits: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!globRe.test(path)) continue;
    content.split("\n").forEach((line, index) => {
      if (re.test(line)) hits.push(`${path}:${index + 1}:${line}`);
    });
  }
  return hits.slice(0, 80);
}
