import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const execAsync = promisify(exec);

interface ProxyBody {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface FsBody {
  root?: string;
  path?: string;
  content?: string;
}

interface BashBody {
  root?: string;
  command?: string;
}

function json(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

async function readBody(req: { on: (event: string, cb: (chunk: Buffer | string) => void) => void }): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes workspace root");
  }
  return target;
}

async function collectFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const skip = new Set(["node_modules", ".git", "dist", "app", ".vite"]);
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skip.has(entry.name) || entry.name.startsWith(".DS_Store")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).replaceAll("\\", "/");
      try {
        const buf = await fs.readFile(full);
        if (buf.includes(0)) continue;
        files[rel] = buf.toString("utf8");
      } catch {
        // ignore unreadable files
      }
    }
  }
  await walk(root);
  return files;
}

export function createLocalAgentPlugin(): Plugin {
  return {
    name: "deepseek-local-agent",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/__dsh/")) return next();
        try {
          if (req.method === "GET" && url.startsWith("/__dsh/health")) {
            json(res, 200, { ok: true, local: true });
            return;
          }
          const raw = req.method === "GET" ? "{}" : await readBody(req);
          const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          if (url.startsWith("/__dsh/llm") && req.method === "POST") {
            const body = payload as { url?: string; apiKey?: string; body?: unknown };
            const target = String(body.url ?? "");
            const upstream = await fetch(target, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${String(body.apiKey ?? "")}`,
              },
              body: JSON.stringify(body.body ?? {}),
            });
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            if (!upstream.body) {
              res.end(await upstream.text());
              return;
            }
            const reader = upstream.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
            res.end();
            return;
          }
          if (url.startsWith("/__dsh/proxy") && req.method === "POST") {
            const body = payload as ProxyBody;
            const target = String(body.url ?? "");
            const upstream = await fetch(target, {
              method: body.method ?? "POST",
              headers: body.headers,
              body: typeof body.body === "string" ? body.body : JSON.stringify(body.body),
            });
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.end(buf);
            return;
          }
          if (url.startsWith("/__dsh/fs/list") && req.method === "POST") {
            const body = payload as FsBody;
            const root = String(body.root ?? process.cwd());
            json(res, 200, { files: await collectFiles(root) });
            return;
          }
          if (url.startsWith("/__dsh/fs/write") && req.method === "POST") {
            const body = payload as FsBody;
            const root = String(body.root ?? process.cwd());
            const rel = String(body.path ?? "");
            const full = safeJoin(root, rel);
            await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, String(body.content ?? ""), "utf8");
            json(res, 200, { ok: true });
            return;
          }
          if (url.startsWith("/__dsh/bash") && req.method === "POST") {
            const body = payload as BashBody;
            const root = String(body.root ?? process.cwd());
            const command = String(body.command ?? "");
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd: root,
                timeout: 30_000,
                maxBuffer: 2_000_000,
              });
              json(res, 200, { ok: true, output: `${stdout}${stderr}`.trim() || "(no output)" });
            } catch (error) {
              const err = error as { stdout?: string; stderr?: string; message?: string };
              json(res, 200, {
                ok: false,
                output: `${err.stdout ?? ""}${err.stderr ?? err.message ?? String(error)}`.trim(),
              });
            }
            return;
          }
          json(res, 404, { error: "not found" });
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
