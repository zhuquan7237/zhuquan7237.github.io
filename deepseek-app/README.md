# DeepSeek App

A Codex-style coding agent for [DeepSeek V4](https://api-docs.deepseek.com/), inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): session threads, tool loop, plan/agent/ask modes, diffs, and a local workspace.

## Run locally (full agent)

```sh
cd deepseek-app
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. In **Settings**, paste a DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com). Local mode proxies the API (no CORS), reads the workspace from disk, and can run `bash`.

## GitHub Pages (browser workspace)

The built UI lives in `/app`. It keeps an in-browser virtual workspace (and can open a real folder in Chrome via the File System Access API). Direct calls to `https://api.deepseek.com` may be blocked by CORS; use local `npm run dev` for a complete Codex-like loop.

## Modes

| Mode | Behavior |
| --- | --- |
| **Agent** | Read/edit files, optional bash, keep todos |
| **Plan** | Inspect the repo and write a plan; no edits |
| **Ask** | Answer questions; no writes or shell |

Models: `deepseek-v4-flash` (fast) and `deepseek-v4-pro` (frontier). Thinking can be toggled in Settings.

## Tests

```sh
npm test
npm run build
```
