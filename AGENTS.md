# Agent notes

## Desktop version, downloads, and public copy must stay in sync

Whenever the desktop version changes — or download links, product copy, or skin credits change — update **all** of the places below in the **same turn**. Do not tell people a new version is out while any of these still advertise an older one.

After a newer desktop version ships, do not recommend older installers (0.1.0 through the previous version). Prefer Linux **tar.gz** or **deb** in user-facing copy.

### This repo (`zhuquan7237/zhuquan7237.github.io`)

GitHub Pages https://dsh.zhuquan.xyz/ (custom domain, `CNAME` file) deploys from **`main`**. `https://zhuquan7237.github.io/` should redirect there after Pages picks up the domain. A feature-branch PR does **not** update the public site until it is merged.

Bump or rewrite all of these together:

- `desktop/package.json` and `desktop/package-lock.json` (`version`)
- `.github/workflows/desktop.yml` — `tag_name` `desktop-vX.Y.Z`, release name, notes, and every download URL
- `README.md`
- `desktop/README.md`
- `index.html` — hero button, OS cards, FAQ, footer, and the JS `links` map
- `mac.html` — if macOS Gatekeeper /「已损坏」说明有变
- `me.html` — if it names the version or the new feature
- `assets/desktop-preview.png` — the README / Pages / og:image shot. Use the real maid-atelier window (official `preview/light.webp` inside Electron chrome), not the first-run API Key modal and not the old Skin Center overlay mock. Site gallery images live next to it as `assets/skin-*.webp`. When the default skin changes, replace this set and keep the author thanks on `index.html`.

Public installer links use `https://dsh.zhuquan.xyz/dl/DeepSeek-X.Y.Z-win.exe` (and the matching Linux/macOS names). Do **not** commit the binaries into this repo — GitHub Pages rejects files over 100 MB. A Cloudflare Worker on `dsh.zhuquan.xyz/dl/*` streams GitHub Release assets and caches them at the edge. Keep GitHub Release URLs as fallback in `dl/latest.json`.

CI publishes the public GitHub Release from `desktop.yml` (`make_latest: true`). Confirm `/releases/latest` points at the new tag and that both `https://dsh.zhuquan.xyz/dl/…` and the GitHub installer URLs return HTTP 200.

`$DSH_HOME/cordis.patch.yml` (and `profiles/web/cordis.patch.yml` if present) must be a **top-level YAML array**. Official dsh throws on empty or comments-only files. Write `[]` when there are no entries; never write only `#` comments. On boot, repair a non-array file to `[]` (keep a `.bak`).

The default skin (`maid-atelier`) is **bundled** at `desktop/resources/skins/maid-atelier` (runtime files + LICENSE/NOTICE only; do not vendor dsh-web-ui or the skin’s TypeScript). First launch copies it into userData. Do not require a GitHub download for the default skin.

Official API keys live in `$DSH_HOME/.credentials.yaml`. Desktop `DSH_HOME` is `userData/dsh-home` (`%AppData%\DeepSeek\dsh-home` / `~/.config/DeepSeek/dsh-home`). On boot, if the current home has no credentials, copy them from older Electron folders (`深度求索`, `DeepSeek Harness`, …) or official `~/.dsh`. Never overwrite a key the user already saved in the current folder.

### Other public GitHub repos (update their `main` in the same turn)

These are not this git checkout. Use the GitHub API / MCP to edit their `main` files:

| Repo | What to update |
| --- | --- |
| [zhuquan7237/deepseek-harness-desktop](https://github.com/zhuquan7237/deepseek-harness-desktop) | Search landing `README.md` (and `index.html` if it has versioned links) |
| [zhuquan7237/zhuquan7237](https://github.com/zhuquan7237/zhuquan7237) | Profile `README.md` download table and version mention |

### GitHub About / topics (cannot be set from git files)

The search landing repo is what people find when they type `DeepSeek Harness Desktop`. After creating or editing it, open **About** on both repos and keep:

- **Description (Chinese first):** `基于官方 DeepSeek Harness 打造的 Electron 桌面端，Windows / Linux / macOS 开箱即用。引擎从 npm 更新 @deepseek-ai/dsh，不整仓拷贝官方源码。`
- **Website:** `https://dsh.zhuquan.xyz`
- **Topics:** `deepseek`, `deepseek-harness`, `dsh`, `dsh-plugin`, `electron`, `desktop`, `windows`, `linux`, `macos`
- **License:** MIT (root `LICENSE`; the bundled maid-atelier skin stays CC BY-NC-SA 4.0)

Do not vendor `deepseek-ai/deepseek-harness` into this repo to chase GitHub search rank. The product is a thin npm shell. Public comparison copy lives in `compare.html`.

### Done only when all of these match the new version

1. GitHub Release `desktop-vX.Y.Z` exists and is latest, with Windows / Linux tar.gz+deb / macOS dmg
2. This repo’s `main` README + `index.html` + `me.html` (Pages)
3. `deepseek-harness-desktop` README
4. Profile `zhuquan7237` README
