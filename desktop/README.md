# DeepSeek Desktop

A Codex-style **desktop shell** around official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This package does **not** vendor harness source. On launch it:

1. Uses system Node `>= 22.19` or downloads an official Node sidecar
2. Installs / updates `@deepseek-ai/dsh` from npm into user data
3. Starts `dsh web` and shows the official Web UI in a native window

Harness releases therefore land without rebuilding this desktop app. The shell only needs a new version if windowing, installers, or the updater itself change.

## Installers

GitHub Actions builds:

| OS | Packages |
| --- | --- |
| Windows | NSIS `.exe` installer, portable `.exe`, `.zip` (x64 + arm64) |
| macOS | `.dmg`, `.zip` (Intel + Apple Silicon) |
| Linux | AppImage, `.deb`, `.rpm`, `.tar.gz` (x64 + arm64) |

Download artifacts from the **Desktop installers** workflow on this repository.

## Run from source

```sh
cd desktop
npm install
npm start
```

Menus:

- **File → Open Workspace** — cwd for `dsh` (default filesystem root)
- **Harness → Check for Harness updates** — pull latest `@deepseek-ai/dsh`
- **Harness → Engine settings** — npm channel, registry, or a local built checkout

## Why this is not a fork

`npx @deepseek-ai/dsh web` is the product. The desktop app is a Codex-like frame: native window, installers, workspace picker, and an independent engine updater. All agent tools, plugins, settings, and the Web UI come from the published harness.
