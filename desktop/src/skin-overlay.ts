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
  background: #ffffff;
  box-shadow: 0 8px 22px rgba(12, 16, 28, 0.32), inset 0 1px 0 rgba(255,255,255,0.9);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 220ms ease;
}
#dsh-desktop-skin-root .fab svg { width: 28px; height: 28px; display: block; }
#dsh-desktop-skin-root .fab:hover { transform: scale(1.06); }
#dsh-desktop-skin-root.open .fab { transform: scale(1.04); }
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
#dsh-desktop-skin-root .power {
  width: 100%;
  margin-top: 12px;
  min-height: 40px;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(255,255,255,0.06);
  color: inherit;
  border-radius: 10px;
  padding: 0 12px;
  cursor: pointer;
  font-size: 13px;
}
`;

/** Official DeepSeek whale (fill #4D6BFE), same path as desktop/scripts/deepseek-whale.svg. */
export const DEEPSEEK_WHALE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 57 57" fill="none" aria-hidden="true"><g transform="translate(0.4 7.3)"><path fill="#4D6BFE" fill-rule="nonzero" d="M55.6128 3.47119C55.0175 3.17944 54.7611 3.73535 54.413 4.01782C54.2939 4.10889 54.1932 4.22729 54.0924 4.33667C53.2223 5.26587 52.2057 5.87646 50.8776 5.80347C48.9359 5.69409 47.2781 6.30469 45.8126 7.78979C45.5012 5.9585 44.4663 4.86499 42.8909 4.16357C42.0667 3.79907 41.2332 3.43457 40.6561 2.64185C40.2532 2.07715 40.1432 1.44849 39.9418 0.828857C39.8135 0.455322 39.6853 0.0725098 39.2548 0.00878906C38.7877 -0.0639648 38.6045 0.327637 38.4213 0.655762C37.6886 1.99512 37.4047 3.47119 37.4321 4.96533C37.4962 8.32739 38.9159 11.0059 41.7369 12.9102C42.0575 13.1289 42.1399 13.3474 42.0392 13.6665C41.8468 14.3225 41.6178 14.9602 41.4164 15.6162C41.2881 16.0354 41.0957 16.1265 40.647 15.9441C39.0991 15.2974 37.7618 14.3406 36.5803 13.1836C34.5745 11.2429 32.761 9.10181 30.4988 7.42529C29.9675 7.03345 29.4363 6.66919 28.8867 6.32275C26.5786 4.08154 29.189 2.24097 29.7935 2.02246C30.4254 1.79468 30.0133 1.01099 27.9708 1.02026C25.9283 1.0293 24.0599 1.71265 21.6786 2.62378C21.3306 2.7605 20.9641 2.8606 20.5886 2.94263C18.4271 2.53271 16.1831 2.44141 13.8384 2.70581C9.42371 3.19775 5.89758 5.28418 3.30554 8.84668C0.191406 13.1289 -0.54126 17.9941 0.356323 23.0691C1.29968 28.4172 4.02905 32.8452 8.22388 36.3076C12.5745 39.8972 17.5845 41.6558 23.2997 41.3186C26.771 41.1182 30.6361 40.6536 34.9958 36.9636C36.0948 37.5103 37.2489 37.7288 39.1632 37.8928C40.6378 38.0295 42.0575 37.8201 43.1565 37.5923C44.8784 37.2278 44.7594 35.6333 44.1366 35.3418C39.09 32.9912 40.1981 33.9478 39.1907 33.1733C41.7552 30.1394 45.6204 26.9868 47.1316 16.7732C47.2506 15.9624 47.1499 15.4521 47.1316 14.7961C47.1224 14.3953 47.214 14.2405 47.672 14.1948C48.9359 14.0491 50.1632 13.7029 51.2898 13.0833C54.5596 11.2976 55.8784 8.36377 56.1898 4.84692C56.2357 4.30933 56.1807 3.75342 55.6128 3.47119ZM27.119 35.123C22.2281 31.2783 19.856 30.0117 18.8759 30.0664C17.96 30.1211 18.1249 31.1689 18.3263 31.8523C18.537 32.5264 18.8118 32.9912 19.1964 33.5833C19.462 33.9751 19.6453 34.5581 18.9309 34.9956C17.3555 35.9705 14.6169 34.6675 14.4886 34.6038C11.3014 32.7268 8.63611 30.2485 6.75842 26.8594C4.94495 23.5974 3.89172 20.0989 3.71765 16.3633C3.67188 15.4614 3.9375 15.1423 4.83508 14.9785C6.0166 14.7598 7.23474 14.7141 8.41626 14.8872C13.408 15.6162 17.6577 17.8484 21.2206 21.3835C23.2539 23.397 24.7926 25.8025 26.3772 28.1531C28.0624 30.6494 29.8759 33.0276 32.184 34.9773C32.9991 35.6606 33.6494 36.1799 34.2722 36.5627C32.3947 36.7722 29.2622 36.8179 27.119 35.123ZM29.4637 20.0442C29.4637 19.6433 29.7843 19.3245 30.1874 19.3245C30.2789 19.3245 30.3613 19.3425 30.4346 19.3699C30.5354 19.4065 30.627 19.4612 30.7002 19.543C30.8285 19.6707 30.9017 19.8528 30.9017 20.0442C30.9017 20.4451 30.5812 20.7639 30.1782 20.7639C29.7751 20.7639 29.4637 20.4451 29.4637 20.0442ZM36.7452 23.7798C36.2781 23.9712 35.811 24.135 35.3622 24.1533C34.6661 24.1897 33.9059 23.9072 33.4938 23.561C32.8527 23.0234 32.3947 22.7229 32.2023 21.7844C32.1199 21.3835 32.1656 20.7639 32.239 20.4087C32.4038 19.6433 32.2206 19.1514 31.6803 18.7048C31.2406 18.3403 30.6819 18.2402 30.0682 18.2402C29.8392 18.2402 29.6287 18.1399 29.4729 18.0579C29.2164 17.9304 29.0059 17.6116 29.2073 17.2197C29.2714 17.0923 29.5829 16.7825 29.6561 16.7278C30.4896 16.2539 31.4513 16.4089 32.3397 16.7642C33.1641 17.1013 33.7869 17.7209 34.6844 18.5955C35.6003 19.6523 35.7651 19.9441 36.2872 20.7366C36.6995 21.3562 37.075 21.9939 37.3314 22.7229C37.4871 23.1785 37.2856 23.552 36.7452 23.7798Z"/></g></svg>`;

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
        ${DEEPSEEK_WHALE_SVG}
      </button>
      <div class="panel" role="dialog" aria-label="皮肤列表">
        <h2>皮肤中心</h2>
        <p class="hint">点一张就能换。关闭皮肤中心用下面的按钮，或菜单「皮肤」。</p>
        <div class="grid" id="dsh-skin-grid"></div>
        <div class="row">
          <input id="dsh-skin-url" placeholder="粘贴 GitHub 皮肤仓库地址" />
          <button class="ghost" id="dsh-skin-import-url" type="button">导入</button>
        </div>
        <div class="row">
          <button class="ghost" id="dsh-skin-import-dir" type="button">从文件夹导入</button>
        </div>
        <button class="power" id="dsh-skin-disable" type="button">关闭皮肤中心</button>
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
    root.querySelector("#dsh-skin-disable").addEventListener("click", async () => {
      setStatus("正在关闭皮肤中心…");
      try {
        await window.desktop.setSkinsEnabled(false);
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
