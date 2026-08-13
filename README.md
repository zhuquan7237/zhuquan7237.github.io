# zhuquan7237.github.io

Personal GitHub Pages site.

## DeepSeek Desktop

Codex-style **native app** whose engine is official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`). The desktop shell does not vendor harness source; it auto-updates `dsh` from npm, so harness releases do not require a new desktop build.

- Source: [`desktop/`](./desktop/)
- Installers: GitHub Actions workflow **Desktop installers** (Windows NSIS/portable, macOS dmg/zip, Linux AppImage/deb/rpm/tar.gz, x64 + arm64)
- Dev: `cd desktop && npm install && npm start`

## Browser preview

A lighter in-browser UI remains at [App](./app/) (`deepseek-app/`). It is not a substitute for the full harness.

Also: [Pomodoro](./pomodoro.html)
