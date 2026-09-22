/**
 * `@dsh-desktop/dsh-mobile-bridge` browser half — the 「手机配对」 settings page.
 *
 * Hand-written in the loader's bundle format, like the desktop panel's and the
 * search-engine page's: the body needs React from the host's module table and
 * nothing else.
 *
 * It replaces the pairing card that used to live in the desktop shell's own
 * settings window (a dark, modal dialog that had nothing to do with the engine's
 * design language, and whose failure path could do nothing but stay silent). The
 * page reads the bridge's loopback routes — the same ones the shell and the
 * pairing page use — so the plugin stays the only writer of the pairing store,
 * and it renders inside the engine's own settings, which means the theme, the
 * borders and the type all follow the host automatically.
 *
 * Every request failure is rendered as text: a page that cannot reach its bridge
 * must say why, never show an empty card.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-mobile-bridge",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const URLS = {
      state: "/mobile-local/state",
      rotate: "/mobile-local/rotate",
      config: "/mobile-local/config",
      qr: "/mobile-local/qr",
      seat: "/mobile-local/seat",
      device: (id) => `/mobile-local/devices/${encodeURIComponent(id)}`,
    };

    const COPY = {
      zh: {
        nav: "手机配对",
        title: "手机配对",
        subtitle:
          "手机是随身的遥控器：会话、模型和干活都在电脑上。这里生成配对码与二维码，也管理已经绑定的设备。配对码 5 分钟有效，扫一次就完成绑定。",
        bridge: "桥接",
        bridgeUp: "正常",
        bridgeDown: "读不到状态",
        devices: "已绑定设备",
        publicUrl: "公网地址",
        publicUrlNone: "未配置",
        fromStore: "（在本页修改）",
        fromConfig: "（来自桌面端设置）",
        refresh: "刷新",
        refreshing: "读取中…",
        codeTitle: "配对码",
        codeExpired: "已过期",
        codeTtl: "后失效",
        noCode: "当前没有有效配对码",
        noCodeHint: "点下面的按钮生成一串新码。",
        generate: "生成配对码",
        regenerate: "重新生成配对码",
        generating: "生成中…",
        copyLink: "复制配对链接",
        copied: "已复制",
        qrAlt: "配对二维码",
        qrHint: "手机 App →「扫码配对」",
        qrUnavailable: "二维码不可用",
        linkLabel: "配对链接",
        linkMissing: "先生成配对码，并确认已配置公网地址。",
        urlLabel: "公网地址（配对二维码指向的地址）",
        urlPlaceholder: "https://m.example.com",
        urlHint:
          "手机和电脑不在同一网络时填隧道域名，例如 Cloudflare Tunnel 的域名；留空表示只用局域网地址。保存后二维码会立即指向新地址，并自动换一枚新码。",
        urlSave: "保存地址",
        urlSaving: "保存中…",
        urlSaved: "已保存",
        urlCleared: "已清除",
        devicesTitle: "已绑定设备",
        devicesEmpty: "还没有设备绑定",
        deviceUntitled: "未命名设备",
        never: "从未",
        lastSeen: "最近",
        revoke: "解除",
        revoking: "解除中…",
        revokeConfirm: "解除「{name}」？它会立刻失去访问权限。",
        scopesNone: "无权限",
        scopeLabels: {
          read: "查看",
          prompt: "对话",
          config: "配置",
          admin: "管理",
        },
        storePath: "存储文件",
        openPhone: "在浏览器打开手机端",
        hint: "配对新手机：手机连上这个地址 → 打开 App → 扫码配对或用配对码；也可以让手机浏览器直接打开上面的链接。",
        errState: "读不到配对状态",
        errRotate: "生成配对码失败",
        errRevoke: "解除设备失败",
        errConfig: "保存地址失败",
        errNetwork: "请求失败",
      },
      en: {
        nav: "Phone pairing",
        title: "Phone pairing",
        subtitle:
          "The phone is a remote control: sessions, models and work stay on this computer. Generate the pairing code and QR here, and manage the devices that are already bound. A code answers for five minutes; one scan binds the phone.",
        bridge: "Bridge",
        bridgeUp: "healthy",
        bridgeDown: "no state",
        devices: "Bound devices",
        publicUrl: "Public address",
        publicUrlNone: "not configured",
        fromStore: "(set on this page)",
        fromConfig: "(from desktop settings)",
        refresh: "Refresh",
        refreshing: "Loading…",
        codeTitle: "Pairing code",
        codeExpired: "expired",
        codeTtl: "left",
        noCode: "No live pairing code",
        noCodeHint: "Press the button below to issue one.",
        generate: "Generate code",
        regenerate: "New code",
        generating: "Generating…",
        copyLink: "Copy pairing link",
        copied: "Copied",
        qrAlt: "Pairing QR code",
        qrHint: "Phone app → “Scan QR”",
        qrUnavailable: "QR unavailable",
        linkLabel: "Pairing link",
        linkMissing: "Generate a code and make sure the public address is set.",
        urlLabel: "Public address (what the QR points at)",
        urlPlaceholder: "https://m.example.com",
        urlHint:
          "Fill in the tunnel domain when the phone is not on the same network, e.g. a Cloudflare Tunnel hostname. Blank keeps the LAN address only. Saving re-points the QR immediately and issues a fresh code.",
        urlSave: "Save address",
        urlSaving: "Saving…",
        urlSaved: "Saved",
        urlCleared: "Cleared",
        devicesTitle: "Bound devices",
        devicesEmpty: "No device is bound yet",
        deviceUntitled: "Unnamed device",
        never: "never",
        lastSeen: "last seen",
        revoke: "Revoke",
        revoking: "Revoking…",
        revokeConfirm: "Revoke “{name}”? It loses access immediately.",
        scopesNone: "no scopes",
        scopeLabels: {
          read: "read",
          prompt: "prompt",
          config: "config",
          admin: "admin",
        },
        storePath: "Store file",
        openPhone: "Open the phone page in a browser",
        hint: "To pair a phone: open this address on the phone, start the app, then scan the QR or type the code. The phone's browser can also follow the link above.",
        errState: "Cannot read pairing state",
        errRotate: "Failed to generate a code",
        errRevoke: "Failed to revoke the device",
        errConfig: "Failed to save the address",
        errNetwork: "Request failed",
      },
    };

    /** Theme variables the dsh client defines, always with neutral fallbacks. */
    const V = {
      text: "var(--dsw-alias-label-primary, currentColor)",
      dim: "var(--dsw-alias-label-secondary, rgba(127,127,127,1))",
      faint: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))",
      border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
      borderSoft: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))",
      card: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
      inner: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
      good: "var(--dsw-alias-state-business-primary, #1a9e63)",
      bad: "var(--dsw-alias-state-error-primary, #e2635f)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))",
      accent: "var(--dsw-alias-brand-primary, #3a83f7)",
    };

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

    function buttonStyle(primary) {
      return {
        padding: "6px 14px",
        fontSize: "12.5px",
        borderRadius: "8px",
        border: primary ? "1px solid transparent" : V.border,
        background: primary ? V.accent : "transparent",
        color: primary ? "#fff" : V.text,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease",
      };
    }

    function inputStyle() {
      return {
        flex: 1,
        minHeight: "34px",
        minWidth: "200px",
        padding: "0 10px",
        fontSize: "12.5px",
        borderRadius: "8px",
        border: V.border,
        background: V.inner,
        color: V.text,
        fontFamily: "inherit",
      };
    }

    function cardStyle() {
      return {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "14px",
        borderRadius: "12px",
        border: V.borderSoft,
        background: V.card,
      };
    }

    async function readJson(response) {
      const text = await response.text();
      if (text === "") return {};
      try {
        return JSON.parse(text);
      } catch (_error) {
        return { message: text.slice(0, 300) };
      }
    }

    async function get(path) {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      return readJson(response);
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return readJson(response);
    }

    async function del(path) {
      const response = await fetch(path, { method: "DELETE", headers: { accept: "application/json" } });
      return readJson(response);
    }

    /** "4:07" style countdown for a millisecond deadline. */
    function countdown(deadline, now) {
      const left = Math.max(0, Math.floor((deadline - now) / 1000));
      const minutes = Math.floor(left / 60);
      const seconds = left % 60;
      return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    function scopesText(t, scopes) {
      const list = Array.isArray(scopes) ? scopes : [];
      if (list.length === 0) return t.scopesNone;
      return list.map((scope) => t.scopeLabels[scope] || String(scope)).join(" / ");
    }

    function formatSeen(value, t) {
      if (!value) return t.never;
      try {
        return new Date(value).toLocaleString();
      } catch (_error) {
        return t.never;
      }
    }

    function pairCodeText(code) {
      const raw = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : String(code || "");
    }

    function MobilePairingPage(props) {
      const lang = props && props.lang === "en" ? "en" : "zh";
      const t = COPY[lang];
      const [state, setState] = useState(null);
      const [message, setMessage] = useState("");
      const [messageBad, setMessageBad] = useState(false);
      const [busy, setBusy] = useState("");
      const [now, setNow] = useState(Date.now());
      const [urlDraft, setUrlDraft] = useState(null);
      const [qrIssue, setQrIssue] = useState("");
      const [copied, setCopied] = useState(false);
      const [revoking, setRevoking] = useState("");

      const say = useCallback((text, bad) => {
        setMessage(text || "");
        setMessageBad(bad === true);
      }, []);

      const load = useCallback(async () => {
        setBusy((current) => (current === "rotate" ? current : "load"));
        try {
          const incoming = await get(URLS.state);
          if (!incoming || incoming.ok === false) {
            say(`${t.errState}：${(incoming && (incoming.message || incoming.error)) || t.errNetwork}`, true);
            setState(null);
            return;
          }
          setState(incoming);
          setUrlDraft(incoming.publicUrl || "");
          if (messageBad) say("");
        } catch (error) {
          say(`${t.errState}：${String((error && error.message) || error)}`, true);
          setState(null);
        } finally {
          setBusy((current) => (current === "load" ? "" : current));
        }
      }, [say, t, messageBad]);

      useEffect(() => {
        load();
      }, [load]);

      // A live countdown is cheap here (one text node per second) and it is the
      // difference between "this code works" and "why does pairing fail".
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, []);

      const code = state && state.pairCode ? pairCodeText(state.pairCode) : "";
      const expiresAt = state && typeof state.pairExpiresAt === "number" ? state.pairExpiresAt : null;
      const codeLive = code !== "" && (expiresAt === null || expiresAt > now);
      const link = codeLive && state && state.pairUrl ? String(state.pairUrl) : "";

      // Preflight the QR so a 404 from the bridge ("no public address") becomes
      // readable text instead of a broken image.
      useEffect(() => {
        if (!codeLive) {
          setQrIssue("");
          return;
        }
        let cancelled = false;
        const url = `${URLS.qr}?c=${encodeURIComponent(state.pairCode)}`;
        fetch(url)
          .then(async (response) => {
            if (cancelled) return;
            if (response.ok) {
              setQrIssue("");
              return;
            }
            const text = await response.text();
            if (!cancelled) setQrIssue(text.trim() || t.qrUnavailable);
          })
          .catch((error) => {
            if (!cancelled) setQrIssue(String((error && error.message) || error));
          });
        return () => {
          cancelled = true;
        };
      }, [codeLive, state, t]);

      const rotate = useCallback(async () => {
        setBusy("rotate");
        try {
          const result = await post(URLS.rotate, {});
          if (!result || result.ok === false) {
            say(`${t.errRotate}：${(result && (result.message || result.error)) || t.errNetwork}`, true);
          } else {
            say("");
            setNow(Date.now());
          }
        } catch (error) {
          say(`${t.errRotate}：${String((error && error.message) || error)}`, true);
        } finally {
          setBusy("");
          await load();
        }
      }, [load, say, t]);

      const copyLink = useCallback(async () => {
        if (!link) {
          say(t.linkMissing, true);
          return;
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(link);
          } else {
            const holder = document.createElement("textarea");
            holder.value = link;
            document.body.appendChild(holder);
            holder.select();
            document.execCommand("copy");
            holder.remove();
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (error) {
          say(String((error && error.message) || error), true);
        }
      }, [link, say, t]);

      const saveUrl = useCallback(async () => {
        const value = String(urlDraft === null ? "" : urlDraft).trim();
        setBusy("url");
        try {
          const result = await post(URLS.config, { publicUrl: value });
          if (!result || result.ok === false) {
            say(`${t.errConfig}：${(result && (result.message || result.error)) || t.errNetwork}`, true);
          } else {
            say(value === "" ? t.urlCleared : t.urlSaved, false);
            setNow(Date.now());
          }
        } catch (error) {
          say(`${t.errConfig}：${String((error && error.message) || error)}`, true);
        } finally {
          setBusy("");
          await load();
        }
      }, [urlDraft, load, say, t]);

      const revoke = useCallback(
        async (device) => {
          const name = device.name || t.deviceUntitled;
          if (typeof window !== "undefined" && !window.confirm(t.revokeConfirm.replace("{name}", name))) return;
          setRevoking(device.id);
          try {
            const result = await del(URLS.device(device.id));
            if (!result || result.ok === false) {
              say(`${t.errRevoke}：${(result && (result.message || result.error)) || t.errNetwork}`, true);
            }
          } catch (error) {
            say(`${t.errRevoke}：${String((error && error.message) || error)}`, true);
          } finally {
            setRevoking("");
            await load();
          }
        },
        [load, say, t],
      );

      const devices = (state && Array.isArray(state.devices) ? state.devices : []).slice();
      const publicUrl = state ? String(state.publicUrl || "") : "";
      const source = state ? String(state.publicUrlSource || "") : "";
      const urlNote =
        source === "store" ? t.fromStore : source === "config" ? t.fromConfig : "";

      const codeColor = codeLive ? V.text : V.faint;

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px 20px", color: V.text } }, [
        h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
          h("strong", { key: "t", style: { fontSize: "15px" } }, t.title),
          h("span", { key: "s", style: { fontSize: "12px", color: V.dim, lineHeight: 1.7 } }, t.subtitle),
        ]),

        // Status bar: bridge health, device count, the effective address.
        h(
          "div",
          {
            key: "bar",
            style: {
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
              padding: "10px 14px",
              borderRadius: "12px",
              border: V.borderSoft,
              background: V.card,
            },
          },
          [
            h(
              "span",
              { key: "b", style: { fontSize: "12px", color: state ? V.good : V.bad } },
              `${t.bridge}：${state ? t.bridgeUp : t.bridgeDown}`,
            ),
            h(
              "span",
              { key: "d", style: { fontSize: "12px", color: V.dim } },
              `${t.devices}：${devices.length}`,
            ),
            h(
              "span",
              { key: "u", style: { fontSize: "12px", color: publicUrl ? V.dim : V.bad } },
              `${t.publicUrl}：${publicUrl || t.publicUrlNone}${urlNote === "" ? "" : ` ${urlNote}`}`,
            ),
            h(
              "div",
              { key: "sp", style: { marginLeft: "auto", display: "flex", gap: "8px" } },
              [
                h(
                  "button",
                  { key: "r", type: "button", style: buttonStyle(false), disabled: busy === "load", onClick: load },
                  busy === "load" ? t.refreshing : t.refresh,
                ),
              ],
            ),
          ],
        ),

        // Pairing card: QR on the left, code and link on the right.
        h("div", { key: "pair", style: cardStyle() }, [
          h("span", { key: "h", style: { fontSize: "13px", fontWeight: 600 } }, t.codeTitle),
          h(
            "div",
            { key: "body", style: { display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" } },
            [
              h(
                "div",
                {
                  key: "qr",
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "6px",
                    width: "180px",
                  },
                },
                [
                  h(
                    "div",
                    {
                      key: "tile",
                      style: {
                        // A QR must stay on white: scanners fail on a themed tile.
                        width: "180px",
                        height: "180px",
                        display: "grid",
                        placeItems: "center",
                        borderRadius: "12px",
                        border: V.borderSoft,
                        background: "#ffffff",
                        overflow: "hidden",
                      },
                    },
                    codeLive && link && qrIssue === ""
                      ? h("img", {
                          key: "img",
                          src: `${URLS.qr}?c=${encodeURIComponent(state.pairCode)}`,
                          alt: t.qrAlt,
                          width: 168,
                          height: 168,
                          style: { display: "block" },
                        })
                      : h(
                          "span",
                          { key: "ph", style: { fontSize: "11px", color: "#9aa0a6", padding: "0 10px", textAlign: "center", lineHeight: 1.6 } },
                          codeLive ? qrIssue || t.qrUnavailable : t.noCode,
                        ),
                  ),
                  h(
                    "span",
                    { key: "hint", style: { fontSize: "11px", color: V.faint, textAlign: "center", lineHeight: 1.5 } },
                    qrIssue === "" ? t.qrHint : t.qrUnavailable,
                  ),
                ],
              ),
              h(
                "div",
                { key: "main", style: { flex: 1, minWidth: "240px", display: "flex", flexDirection: "column", gap: "8px" } },
                [
                  h(
                    "div",
                    {
                      key: "code",
                      style: {
                        fontFamily: MONO,
                        fontSize: "30px",
                        letterSpacing: "4px",
                        fontWeight: 600,
                        color: codeColor,
                        lineHeight: 1.3,
                      },
                    },
                    codeLive ? code : t.noCode,
                  ),
                  h(
                    "span",
                    { key: "ttl", style: { fontSize: "12px", color: codeLive ? V.dim : V.bad } },
                    codeLive && expiresAt !== null
                      ? `${countdown(expiresAt, now)} ${t.codeTtl}`
                      : t.noCodeHint,
                  ),
                  h(
                    "div",
                    { key: "link", style: { display: "flex", flexDirection: "column", gap: "4px" } },
                    [
                      h("span", { key: "l", style: { fontSize: "11px", color: V.faint } }, t.linkLabel),
                      h(
                        "code",
                        {
                          key: "v",
                          style: {
                            fontFamily: MONO,
                            fontSize: "11.5px",
                            color: link ? V.dim : V.faint,
                            wordBreak: "break-all",
                            lineHeight: 1.6,
                          },
                        },
                        link || t.linkMissing,
                      ),
                    ],
                  ),
                  h("div", { key: "btn", style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "2px" } }, [
                    h(
                      "button",
                      {
                        key: "g",
                        type: "button",
                        style: buttonStyle(true),
                        disabled: busy === "rotate",
                        onClick: rotate,
                      },
                      busy === "rotate" ? t.generating : codeLive ? t.regenerate : t.generate,
                    ),
                    h(
                      "button",
                      { key: "c", type: "button", style: buttonStyle(false), onClick: copyLink, disabled: !link },
                      copied ? t.copied : t.copyLink,
                    ),
                  ]),
                ],
              ),
            ],
          ),
        ]),

        // Public address, editable here so pairing never needs the shell window.
        h("div", { key: "url", style: cardStyle() }, [
          h("span", { key: "l", style: { fontSize: "13px", fontWeight: 600 } }, t.urlLabel),
          h(
            "div",
            { key: "row", style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
            [
              h("input", {
                key: "i",
                type: "text",
                value: urlDraft === null ? "" : urlDraft,
                placeholder: t.urlPlaceholder,
                spellCheck: false,
                style: inputStyle(),
                onChange: (event) => setUrlDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") saveUrl();
                },
              }),
              h(
                "button",
                { key: "s", type: "button", style: buttonStyle(false), disabled: busy === "url", onClick: saveUrl },
                busy === "url" ? t.urlSaving : t.urlSave,
              ),
            ],
          ),
          h("span", { key: "h", style: { fontSize: "11px", color: V.faint, lineHeight: 1.7 } }, t.urlHint),
        ]),

        // Devices.
        h("div", { key: "dev", style: cardStyle() }, [
          h(
            "span",
            { key: "h", style: { fontSize: "13px", fontWeight: 600 } },
            `${t.devicesTitle}（${devices.length}）`,
          ),
          devices.length === 0
            ? h("span", { key: "e", style: { fontSize: "12px", color: V.faint } }, t.devicesEmpty)
            : h(
                "div",
                { key: "list", style: { display: "flex", flexDirection: "column", gap: "8px" } },
                devices.map((device, index) =>
                  h(
                    "div",
                    {
                      key: device.id || index,
                      style: {
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        flexWrap: "wrap",
                        padding: "8px 10px",
                        borderRadius: "10px",
                        border: V.borderSoft,
                        background: V.inner,
                      },
                    },
                    [
                      h(
                        "div",
                        { key: "who", style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "180px", flex: 1 } },
                        [
                          h("span", { key: "n", style: { fontSize: "12.5px" } }, device.name || t.deviceUntitled),
                          h(
                            "span",
                            { key: "m", style: { fontSize: "11px", color: V.dim } },
                            `${device.platform ? `${device.platform} · ` : ""}${scopesText(t, device.scopes)} · ${t.lastSeen} ${formatSeen(device.lastSeenAt, t)}`,
                          ),
                        ],
                      ),
                      h(
                        "button",
                        {
                          key: "r",
                          type: "button",
                          style: buttonStyle(false),
                          disabled: revoking === device.id,
                          onClick: () => revoke(device),
                        },
                        revoking === device.id ? t.revoking : t.revoke,
                      ),
                    ],
                  ),
                ),
              ),
        ]),

        message !== ""
          ? h(
              "div",
              {
                key: "msg",
                style: {
                  fontSize: "12px",
                  color: messageBad ? V.bad : V.dim,
                  lineHeight: 1.7,
                  padding: "8px 12px",
                  borderRadius: "10px",
                  border: V.borderSoft,
                  background: V.card,
                },
              },
              message,
            )
          : null,

        h("div", { key: "foot", style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
          h("span", { key: "h", style: { fontSize: "11px", color: V.faint, lineHeight: 1.7 } }, t.hint),
          state && state.storePath
            ? h(
                "span",
                { key: "p", style: { fontSize: "11px", color: V.faint, fontFamily: MONO, wordBreak: "break-all" } },
                `${t.storePath}：${String(state.storePath)}`,
              )
            : null,
        ]),
      ]);
    }

    function activeLanguage(ctx) {
      try {
        const active = ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : "";
        if (active) return String(active).toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch (_error) {
        /* fall through to the browser */
      }
      return String((typeof navigator !== "undefined" && navigator.language) || "").toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
    }

    function apply(ctx) {
      const lang = activeLanguage(ctx);
      try {
        ctx.slots.inject("settings.section", () => {
          ctx.slots.register(
            {
              name: "settings.section",
              id: "mobile-bridge",
              order: 22,
              label: () => COPY[lang].nav,
              locale: "dsh-mobile-bridge",
              inject: () => ({ lang: lang }),
            },
            MobilePairingPage,
          );
          post(URLS.seat, { stage: "seated", lang: lang }).catch(() => undefined);
        });
      } catch (error) {
        if (typeof console !== "undefined") console.warn("dsh-mobile-bridge: settings seat unavailable", error);
        post(URLS.seat, {
          stage: "failed",
          failure: String((error && error.message) || error),
        }).catch(() => undefined);
      }
    }

    return {
      name: "dsh-mobile-bridge",
      inject: ["slots", "locale"],
      apply: apply,
      MobilePairingPage: MobilePairingPage,
      COPY: COPY,
    };
  },
});
