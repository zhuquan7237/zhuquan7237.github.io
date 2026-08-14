export const SKIN_OVERLAY_CSS = `
#dsh-desktop-skin-root {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 2147483000;
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  color: #f4f1ea;
  pointer-events: none;
}
#dsh-desktop-skin-root * { box-sizing: border-box; }
#dsh-desktop-skin-root .fab,
#dsh-desktop-skin-root .panel,
#dsh-desktop-skin-root button,
#dsh-desktop-skin-root input {
  pointer-events: auto;
}
#dsh-desktop-skin-root .fab {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 25%, #f3e2b8, #c5a468 42%, #2a3348 78%);
  box-shadow: 0 8px 22px rgba(12, 16, 28, 0.42), inset 0 1px 0 rgba(255,255,255,0.35);
  color: #1b1408;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease;
}
#dsh-desktop-skin-root .fab:hover { transform: scale(1.06); }
#dsh-desktop-skin-root.open .fab { transform: rotate(18deg) scale(1.04); }
#dsh-desktop-skin-root .panel {
  position: absolute;
  top: 54px;
  right: 0;
  width: min(360px, calc(100vw - 28px));
  max-height: min(72vh, 560px);
  overflow: auto;
  padding: 14px;
  border-radius: 18px;
  background: rgba(16, 20, 32, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 22px 50px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(16px);
  transform-origin: top right;
  opacity: 0;
  transform: translateY(-14px) scale(0.86);
  pointer-events: none;
  transition: opacity 380ms cubic-bezier(0.22, 1, 0.36, 1), transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
}
#dsh-desktop-skin-root.open .panel {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
#dsh-desktop-skin-root h2 {
  margin: 0 0 4px;
  font-size: 15px;
  letter-spacing: -0.02em;
}
#dsh-desktop-skin-root .hint {
  margin: 0 0 12px;
  color: #b7b3a8;
  font-size: 12px;
  line-height: 1.5;
}
#dsh-desktop-skin-root .grid { display: grid; gap: 10px; }
#dsh-desktop-skin-root .card {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03);
  color: inherit;
  border-radius: 14px;
  padding: 8px;
  cursor: pointer;
  transition: border-color 180ms ease, transform 180ms ease, background 180ms ease;
}
#dsh-desktop-skin-root .card:hover { transform: translateY(-1px); border-color: rgba(197,164,104,0.55); }
#dsh-desktop-skin-root .card.active { border-color: #c5a468; background: rgba(197,164,104,0.12); }
#dsh-desktop-skin-root .thumb {
  width: 92px;
  height: 64px;
  border-radius: 10px;
  background: #151a27 center/cover no-repeat;
  display: grid;
  place-items: center;
  color: #8d93a5;
  font-size: 11px;
}
#dsh-desktop-skin-root .card strong { display: block; font-size: 13px; }
#dsh-desktop-skin-root .card span { display: block; color: #b7b3a8; font-size: 11px; line-height: 1.45; margin-top: 3px; }
#dsh-desktop-skin-root .row { display: flex; gap: 8px; margin-top: 12px; }
#dsh-desktop-skin-root .row input {
  flex: 1;
  min-height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.1);
  background: #101218;
  color: inherit;
  padding: 0 10px;
}
#dsh-desktop-skin-root .ghost {
  min-height: 36px;
  border: 1px solid rgba(255,255,255,0.12);
  background: transparent;
  color: inherit;
  border-radius: 10px;
  padding: 0 12px;
  cursor: pointer;
}
#dsh-desktop-skin-root .credit {
  margin: 12px 0 0;
  color: #8d93a5;
  font-size: 11px;
  line-height: 1.5;
}
#dsh-desktop-skin-root a { color: #e6c27a; }
#dsh-desktop-skin-root .status {
  margin: 8px 0 0;
  min-height: 16px;
  color: #e6c27a;
  font-size: 11px;
}
`;

export function skinOverlayHasPicker(script: string): boolean {
  return script.includes("dsh-desktop-skin-root") && script.includes("皮肤中心");
}

export function skinOverlayBootstrap(): string {
  return `(() => {
    if (document.getElementById("dsh-desktop-skin-root")) return;
    if (!window.desktop || !window.desktop.listSkins) return;
    const root = document.createElement("div");
    root.id = "dsh-desktop-skin-root";
    root.innerHTML = \`
      <button class="fab" type="button" title="皮肤中心" aria-label="打开皮肤中心" aria-expanded="false">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.8"/>
          <path d="M8 13.5c1.4 1.6 6.6 1.6 8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="9.2" cy="10.2" r="1" fill="currentColor"/>
          <circle cx="14.8" cy="10.2" r="1" fill="currentColor"/>
        </svg>
      </button>
      <div class="panel" role="dialog" aria-label="皮肤列表">
        <h2>皮肤中心</h2>
        <p class="hint">点一张就能换。以后也可以从文件夹或 GitHub 地址导入。</p>
        <div class="grid" id="dsh-skin-grid"></div>
        <div class="row">
          <input id="dsh-skin-url" placeholder="粘贴 GitHub 皮肤仓库地址" />
          <button class="ghost" id="dsh-skin-import-url" type="button">导入</button>
        </div>
        <div class="row">
          <button class="ghost" id="dsh-skin-import-dir" type="button">从文件夹导入</button>
        </div>
        <p class="credit">默认皮肤来自 <a href="https://github.com/Small-tailqwq/dsh-deep-whale" target="_blank" rel="noreferrer">Small-tailqwq/dsh-deep-whale</a>，CC BY-NC-SA 4.0，禁止商用。署名链：上善 → ZipZipPipe → Small-tailqwq。</p>
        <p class="status" id="dsh-skin-status"></p>
      </div>
    \`;
    document.documentElement.appendChild(root);
    const fab = root.querySelector(".fab");
    const grid = root.querySelector("#dsh-skin-grid");
    const urlInput = root.querySelector("#dsh-skin-url");
    const status = root.querySelector("#dsh-skin-status");
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
    const setStatus = (text) => { status.textContent = text || ""; };
    const render = (cards) => {
      grid.innerHTML = cards.map((card) => {
        const preview = String(card.previewDataUrl || "").startsWith("data:image/") ? card.previewDataUrl : "";
        return \`
        <button class="card\${card.active ? " active" : ""}" type="button" data-id="\${esc(card.id)}">
          <div class="thumb"\${preview ? ' style="background-image:url(\\'' + preview + '\\')"' : ""}>\${preview ? "" : "官方"}</div>
          <div>
            <strong>\${esc(card.name)}</strong>
            <span>\${esc(card.author)} · \${esc(card.tagline || card.license)}</span>
          </div>
        </button>
      \`;
      }).join("");
      grid.querySelectorAll(".card").forEach((button) => {
        button.addEventListener("click", async () => {
          setStatus("正在切换皮肤…");
          try {
            await window.desktop.selectSkin(button.getAttribute("data-id"));
          } catch (error) {
            setStatus(error && error.message ? error.message : String(error));
          }
        });
      });
    };
    const refresh = async () => {
      try {
        render(await window.desktop.listSkins());
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
      }
    };
    fab.addEventListener("click", () => {
      root.classList.toggle("open");
      fab.setAttribute("aria-expanded", root.classList.contains("open") ? "true" : "false");
      if (root.classList.contains("open")) void refresh();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        root.classList.remove("open");
        fab.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("mousedown", (event) => {
      if (!root.contains(event.target)) {
        root.classList.remove("open");
        fab.setAttribute("aria-expanded", "false");
      }
    });
    root.querySelector("#dsh-skin-import-dir").addEventListener("click", async () => {
      setStatus("正在导入文件夹…");
      try {
        await window.desktop.importSkinDir();
        await refresh();
        setStatus("");
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
      }
    });
    root.querySelector("#dsh-skin-import-url").addEventListener("click", async () => {
      const url = String(urlInput.value || "").trim();
      if (!url) return;
      setStatus("正在导入皮肤…");
      try {
        await window.desktop.importSkinUrl(url);
        urlInput.value = "";
        await refresh();
        setStatus("");
      } catch (error) {
        setStatus(error && error.message ? error.message : String(error));
      }
    });
    void refresh();
  })();`;
}
