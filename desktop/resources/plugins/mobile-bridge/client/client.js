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
    // Static sibling lists use variadic children; mapped device rows keep IDs.
    function h(type, props, children) {
      return Array.isArray(children)
        ? React.createElement(type, props, ...children)
        : React.createElement(type, props, children);
    }
    const { useState, useEffect, useCallback, useRef } = React;

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
          "把电脑上的会话带到手机，随时查看进度、继续对话。",
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
        noCode: "准备连接你的手机",
        noCodeHint: "生成一次性配对码后，使用手机 App 扫描左侧二维码。",
        generate: "生成配对码",
        regenerate: "重新生成配对码",
        generating: "生成中…",
        copyLink: "复制配对链接",
        copied: "已复制",
        qrAlt: "配对二维码",
        qrHint: "手机 App →「扫码配对」",
        qrUnavailable: "二维码不可用",
        linkLabel: "配对链接",
        linkMissing: "生成配对码后，可复制链接作为扫码的备用方式。",
        urlLabel: "连接地址",
        urlPlaceholder: "https://m.example.com",
        urlHint:
          "同一 Wi-Fi 可使用局域网地址；跨网络连接时填写手机可访问的隧道或中继地址。保存会更新二维码，并使旧配对码失效。",
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
        connectTitle: "连接新手机",
        step1: "打开手机 App",
        step1Hint: "进入「扫码配对」，允许使用相机。",
        step2: "扫描二维码",
        step2Hint: "扫码即可绑定；也可使用下方配对码。",
        manual: "无法扫码？输入配对码",
        privacy: "配对码 5 分钟有效，请勿向他人分享。模型密钥始终保留在电脑端。",
        addressHint: "检查手机能否访问此地址",
        devicesHint: "管理已获授权的手机；解除后，该设备立即失去访问权限。",
        searchDevices: "搜索设备名称或平台",
        noDevicesMatch: "没有匹配的设备",
        loading: "正在读取连接状态…",
        showDevices: "显示全部设备",
        collapseDevices: "收起设备列表",
        retry: "重新读取状态",
        codeExpiredHint: "配对码已过期，重新生成后再扫码。",
        qrReady: "生成后显示二维码",
        savedAddress: "当前连接地址",
      },
      en: {
        nav: "Phone pairing",
        title: "Phone pairing",
        subtitle:
          "Take your desktop conversations with you. Check progress and continue from your phone.",
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
        noCode: "Connect your phone",
        noCodeHint: "Generate a one-time code, then scan the QR with the mobile app.",
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
        urlLabel: "Connection address",
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
        connectTitle: "Connect a new phone",
        step1: "Open the mobile app",
        step1Hint: "Choose “Scan QR” and allow camera access.",
        step2: "Scan the QR code",
        step2Hint: "Scan to pair, or enter the code below.",
        manual: "Cannot scan? Enter this code",
        privacy: "Codes expire in 5 minutes. Keep them private. Model API keys stay on this computer.",
        addressHint: "Check that your phone can reach this address",
        devicesHint: "Manage authorized phones. Revoking a device immediately removes its access.",
        searchDevices: "Search by device name or platform",
        noDevicesMatch: "No matching devices",
        loading: "Reading connection status…",
        showDevices: "Show all devices",
        collapseDevices: "Show fewer devices",
        retry: "Retry connection",
        codeExpiredHint: "This code expired. Generate a new one to scan.",
        qrReady: "Generate a code to display the QR",
        savedAddress: "Current connection address",
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
      good: "var(--dsw-alias-state-success-primary, #237453)",
      bad: "var(--dsw-alias-state-error-primary, #e2635f)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))",
      accent: "var(--dsw-alias-link, #4176e6)",
      // A slightly deeper desktop blue keeps small white button text readable.
      fill: "color-mix(in srgb, var(--dsw-static-deepseek-500, #4176e6) 90%, #000)",
    };

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

    function buttonStyle(primary) {
      return {
        padding: "9px 14px",
        minHeight: "38px",
        fontSize: "13px",
        fontWeight: 500,
        borderRadius: "10px",
        border: primary ? "1px solid transparent" : V.border,
        background: primary ? V.fill : "transparent",
        color: primary ? "#fff" : V.text,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease",
      };
    }

    function inputStyle() {
      return {
        flex: 1,
        minHeight: "40px",
        minWidth: 0,
        width: "100%",
        padding: "9px 12px",
        fontSize: "13px",
        borderRadius: "10px",
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
        gap: "16px",
        padding: "20px",
        borderRadius: "16px",
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
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
      return data;
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
      return data;
    }

    async function del(path) {
      const response = await fetch(path, { method: "DELETE", headers: { accept: "application/json" } });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
      return data;
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
      const [deviceQuery, setDeviceQuery] = useState("");
      const [devicesExpanded, setDevicesExpanded] = useState(false);
      const [bridgeError, setBridgeError] = useState(false);
      const loadSequence = useRef(0);

      const say = useCallback((text, bad) => {
        setMessage(text || "");
        setMessageBad(bad === true);
      }, []);

      const load = useCallback(async (quiet = false) => {
        const sequence = ++loadSequence.current;
        if (!quiet) setBusy((current) => (current || "load"));
        try {
          const incoming = await get(URLS.state);
          if (sequence !== loadSequence.current) return;
          if (!incoming || incoming.ok === false) {
            say(`${t.errState}：${(incoming && (incoming.message || incoming.error)) || t.errNetwork}`, true);
            setBridgeError(true);
            return;
          }
          setState(incoming);
          setBridgeError(false);
          setMessage((current) => current.startsWith(t.errState) ? "" : current);
          // Background refresh must never overwrite an address being edited.
          setUrlDraft((draft) => draft === null ? incoming.publicUrl || "" : draft);
        } catch (error) {
          if (sequence !== loadSequence.current) return;
          say(`${t.errState}：${String((error && error.message) || error)}`, true);
          setBridgeError(true);
        } finally {
          if (!quiet && sequence === loadSequence.current) setBusy((current) => (current === "load" ? "" : current));
        }
      }, [say, t]);

      useEffect(() => {
        load();
        return () => { ++loadSequence.current; };
      }, [load]);

      // Reflect newly paired/revoked devices without disturbing form drafts.
      useEffect(() => {
        if (busy || revoking) return;
        const timer = setInterval(() => {
          if (document.visibilityState !== "hidden") load(true);
        }, 8000);
        return () => clearInterval(timer);
      }, [load, busy, revoking]);

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
      }, [codeLive, state && state.pairCode, link, t]);

      const rotate = useCallback(async () => {
        setBusy("rotate");
        try {
          const result = await post(URLS.rotate, {});
          if (!result || result.ok === false) {
            say(`${t.errRotate}：${(result && (result.message || result.error)) || t.errNetwork}`, true);
          } else {
            say("");
            setCopied(false);
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
            setUrlDraft(null);
            setCopied(false);
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

      const available = !!state && !bridgeError;
      const query = deviceQuery.trim().toLocaleLowerCase();
      const orderedDevices = devices.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
      const matchingDevices = orderedDevices.filter((device) =>
        !query || [device.name, device.platform].join(" ").toLocaleLowerCase().includes(query));
      const visibleDevices = devicesExpanded || query ? matchingDevices : matchingDevices.slice(0, 5);
      const locked = busy !== "" || !available;
      const address = state && (state.phoneUrl || publicUrl);
      const urlChanged = urlDraft !== null && urlDraft.trim() !== publicUrl;
      const css = `
        .dsh-pairing { container-type:inline-size; min-width:0; color:${V.text}; font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif); font-size:13px; line-height:1.55; }
        .dsh-pairing *, .dsh-pairing *::before, .dsh-pairing *::after { box-sizing:border-box; }
        .dsh-pairing h2,.dsh-pairing h3,.dsh-pairing p { margin:0; font-family:inherit; }
        .dsh-pairing h2 { font-size:20px; line-height:1.4; font-weight:600; letter-spacing:-.3px; }
        .dsh-pairing h3 { font-size:14px; line-height:1.5; font-weight:600; }
        .dsh-pairing button { display:inline-flex; align-items:center; justify-content:center; gap:7px; line-height:1.4; }
        .dsh-pairing button:hover:not(:disabled) { filter:brightness(.96); }
        .dsh-pairing button:disabled { opacity:.45; cursor:not-allowed; }
        .dsh-pairing :is(button,input,summary):focus-visible { outline:2px solid ${V.accent}; outline-offset:3px; }
        .dsh-pairing .pair-stack { display:flex; flex-direction:column; gap:20px; padding:4px 2px 24px; }
        .dsh-pairing .pair-head,.dsh-pairing .pair-section-head { display:flex; align-items:center; justify-content:space-between; gap:14px; }
        .dsh-pairing .pair-sub { color:${V.dim}; font-size:12px; line-height:1.7; margin-top:5px; }
        .dsh-pairing .pair-status { display:flex; gap:7px; align-items:center; font-size:12px; }
        .dsh-pairing .pair-status-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
        .dsh-pairing .pair-grid { display:grid; grid-template-columns:190px minmax(0,1fr); gap:28px; align-items:start; }
        .dsh-pairing .pair-qr-wrap { text-align:center; display:flex; flex-direction:column; align-items:center; gap:10px; }
        .dsh-pairing .pair-qr { width:190px; height:190px; border-radius:14px; display:grid; place-items:center; background:#fff; border:${V.borderSoft}; overflow:hidden; }
        .dsh-pairing .pair-qr-empty { display:flex; flex-direction:column; align-items:center; gap:12px; padding:16px; font-size:12px; color:#627086; }
        .dsh-pairing .pair-instructions { display:flex; flex-direction:column; gap:14px; min-width:0; }
        .dsh-pairing .pair-step { display:flex; align-items:flex-start; gap:10px; }
        .dsh-pairing .pair-step-no { display:grid; place-items:center; width:24px; height:24px; flex-shrink:0; border-radius:8px; background:${V.inner}; color:${V.accent}; font-size:12px; font-weight:600; }
        .dsh-pairing .pair-step-title { font-size:13px; font-weight:500; }
        .dsh-pairing .pair-step-hint { font-size:12px; color:${V.dim}; margin-top:3px; }
        .dsh-pairing .pair-manual { border-top:${V.borderSoft}; padding-top:12px; }
        .dsh-pairing .pair-code { font-family:${MONO}; font-size:28px; line-height:1.4; font-weight:600; letter-spacing:3px; font-variant-numeric:tabular-nums; user-select:all; margin:3px 0; overflow-wrap:anywhere; }
        .dsh-pairing .pair-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; }
        .dsh-pairing .pair-note { display:flex; gap:8px; font-size:12px; color:${V.dim}; border-top:${V.borderSoft}; padding-top:14px; }
        .dsh-pairing .pair-note svg { margin-top:2px; flex-shrink:0; }
        .dsh-pairing .pair-address-summary { display:flex; flex-direction:column; gap:4px; cursor:pointer; list-style:none; border-radius:8px; }
        .dsh-pairing summary::-webkit-details-marker { display:none; }
        .dsh-pairing summary .pair-chevron { transition:transform .16s; }
        .dsh-pairing details[open] .pair-chevron { transform:rotate(90deg); }
        .dsh-pairing .pair-address-label { display:flex; gap:8px; align-items:center; font-size:13px; font-weight:500; }
        .dsh-pairing .pair-address-value { font-size:12px; color:${V.dim}; overflow-wrap:anywhere; }
        .dsh-pairing .pair-url-form { display:flex; flex-direction:column; gap:10px; padding-top:16px; }
        .dsh-pairing .pair-url-row { display:flex; gap:8px; }
        .dsh-pairing .pair-devices { max-height:340px; overflow:auto; overscroll-behavior:contain; padding-right:3px; }
        .dsh-pairing .pair-device { display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:${V.borderSoft}; }
        .dsh-pairing .pair-device:last-child { border-bottom:0; }
        .dsh-pairing .pair-device-icon { width:36px; height:36px; display:grid; place-items:center; border-radius:11px; background:${V.inner}; color:${V.dim}; flex-shrink:0; }
        .dsh-pairing .pair-device-name { font-size:13px; font-weight:500; overflow-wrap:anywhere; }
        .dsh-pairing .pair-device-meta { display:flex; flex-wrap:wrap; gap:3px 12px; color:${V.dim}; font-size:11px; margin-top:3px; }
        .dsh-pairing .pair-empty { padding:20px; text-align:center; color:${V.dim}; font-size:12px; }
        .dsh-pairing .pair-feedback { font-size:12px; padding:12px 14px; border:${V.borderSoft}; border-radius:10px; color:${messageBad ? V.bad : V.dim}; background:${V.card}; overflow-wrap:anywhere; }
        @container (max-width:510px) { .dsh-pairing .pair-grid { grid-template-columns:minmax(0,1fr); gap:20px; } .dsh-pairing .pair-head { align-items:flex-start; flex-wrap:wrap; } .dsh-pairing .pair-qr-wrap { justify-self:center; } .dsh-pairing .pair-url-row { flex-wrap:wrap; } .dsh-pairing .pair-url-row input { flex-basis:100%; } }
        @media (prefers-reduced-motion:reduce) { .dsh-pairing summary .pair-chevron { transition:none; } }
      `;
      function icon(name, size = 18) {
        const paths = {
          phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM10 18h4",
          qr: "M3 3h6v6H3ZM15 3h6v6h-6ZM3 15h6v6H3ZM15 15h3v3h3v3h-6v-3h-3v-3ZM12 3v6M3 12h6M12 12h9M12 18v3",
          shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6ZM8 12l3 3 5-6",
          arrow: "m9 5 7 7-7 7",
          copy: "M9 9h12v12H9ZM5 15H3V3h12v2",
          refresh: "M20 7a9 9 0 1 0 1 8M20 3v5h-5",
        };
        return h("svg", { width:size, height:size, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:1.6, strokeLinecap:"round", strokeLinejoin:"round", "aria-hidden":true }, h("path", { d:paths[name] || paths.phone }));
      }
      function action(key, label, onClick, options = {}) {
        return h("button", { key, type:"button", style:buttonStyle(options.primary), disabled:options.disabled, onClick, "aria-label":options.ariaLabel }, [options.icon ? icon(options.icon, 15) : null, label]);
      }
      const qrVisible = available && codeLive && link && qrIssue === "";

      return h("div", { className:"dsh-pairing" }, [
        h("style", { key:"style" }, css),
        h("div", { key:"content", className:"pair-stack" }, [
          h("header", { key:"head", className:"pair-head" }, [
            h("div", { key:"title" }, [h("h2", null, t.title), h("p", { className:"pair-sub" }, t.subtitle)]),
            h("div", { key:"status", style:{ display:"flex", gap:12, alignItems:"center" } }, [
              h("span", { className:"pair-status", role:"status", style:{ color:available ? V.good : bridgeError ? V.bad : V.dim } }, [
                h("span", { className:"pair-status-dot" }), available ? t.bridge + " · " + t.bridgeUp : bridgeError ? t.bridgeDown : t.loading,
              ]),
              action("refresh", busy === "load" ? t.refreshing : t.refresh, () => load(), { icon:"refresh", disabled:busy !== "" }),
            ]),
          ]),
          message ? h("div", { key:"feedback", className:"pair-feedback", role:messageBad ? "alert" : "status" }, [
            message,
            bridgeError ? action("retry", t.retry, () => load(), { disabled:busy !== "" }) : null,
          ]) : null,
          h("section", { key:"pair", "aria-labelledby":"pair-connect-title", style:cardStyle() }, [
            h("h3", { key:"heading", id:"pair-connect-title" }, t.connectTitle),
            h("div", { key:"body", className:"pair-grid" }, [
              h("div", { key:"qr", className:"pair-qr-wrap" }, [
                h("div", { key:"tile", className:"pair-qr", style:{ background: "#ffffff" } },
                  qrVisible ? h("img", {
                    key:String(state.pairCode), src:URLS.qr + "?c=" + encodeURIComponent(state.pairCode),
                    alt:t.qrAlt, width:174, height:174, style:{ display:"block" },
                    onError:() => setQrIssue(t.qrUnavailable),
                  }) : h("div", { className:"pair-qr-empty" }, [icon("qr", 42),
                    h("span", null, !available ? bridgeError ? t.bridgeDown : t.loading : codeLive ? qrIssue || t.qrUnavailable : t.qrReady)])),
                h("span", { style:{ fontSize:11, color:V.dim } }, t.qrHint),
              ]),
              h("div", { key:"instructions", className:"pair-instructions" }, [
                [1, 2].map((number) => h("div", { key:"step" + number, className:"pair-step" }, [
                  h("span", { className:"pair-step-no" }, number),
                  h("div", null, [h("p", { className:"pair-step-title" }, t["step" + number]), h("p", { className:"pair-step-hint" }, t["step" + number + "Hint"])]),
                ])),
                h("div", { key:"code", className:"pair-manual" }, codeLive ? [
                  h("p", { style:{ fontSize:11, color:V.dim } }, t.manual),
                  h("div", { className:"pair-code", "aria-label":t.codeTitle }, code),
                  h("p", { style:{ fontSize:12, color:V.dim } }, expiresAt !== null ? countdown(expiresAt, now) + " " + t.codeTtl : t.privacy),
                ] : [
                  h("h3", null, code ? t.codeExpired : t.noCode),
                  h("p", { className:"pair-sub" }, code ? t.codeExpiredHint : t.noCodeHint),
                ]),
                h("div", { key:"actions", className:"pair-actions" }, [
                  action("generate", busy === "rotate" ? t.generating : codeLive ? t.regenerate : t.generate, rotate, { primary:true, disabled:locked }),
                  action("copy", copied ? t.copied : t.copyLink, copyLink, { icon:"copy", disabled:!link || !available || busy !== "" }),
                ]),
                codeLive && link ? h("details", { key:"link" }, [
                  h("summary", { style:{ cursor:"pointer", fontSize:11, color:V.dim } }, t.linkLabel),
                  h("p", { style:{ fontSize:11, overflowWrap:"anywhere", marginTop:6, userSelect:"all", color:V.dim } }, link),
                ]) : null,
              ]),
            ]),
            h("div", { key:"privacy", className:"pair-note" }, [icon("shield", 15), h("span", null, t.privacy)]),
          ]),
          h("details", { key:"url", style:cardStyle() }, [
            h("summary", { key:"summary", className:"pair-address-summary" }, [
              h("span", { className:"pair-address-label" }, [t.urlLabel, h("span", { className:"pair-chevron", style:{ marginLeft:"auto", display:"flex" } }, icon("arrow", 16))]),
              h("span", { className:"pair-address-value" }, address || t.publicUrlNone),
            ]),
            h("div", { key:"form", className:"pair-url-form" }, [
              h("label", { htmlFor:"pair-public-url", style:{ fontSize:12, color:V.dim } }, t.publicUrl + (urlNote ? " " + urlNote : "")),
              h("div", { className:"pair-url-row" }, [
                h("input", { id:"pair-public-url", type:"url", value:urlDraft === null ? publicUrl : urlDraft,
                  placeholder:t.urlPlaceholder, spellCheck:false, autoComplete:"off", style:inputStyle(),
                  onChange:(event) => setUrlDraft(event.target.value),
                  onKeyDown:(event) => { if (event.key === "Enter" && urlChanged && !locked) { event.preventDefault(); saveUrl(); } },
                }),
                action("save", busy === "url" ? t.urlSaving : t.urlSave, saveUrl, { disabled:locked || !urlChanged }),
              ]),
              h("p", { className:"pair-sub" }, t.urlHint),
              h("p", { style:{ fontSize:11, color:V.dim } }, t.addressHint),
            ]),
          ]),
          h("section", { key:"devices", "aria-labelledby":"pair-devices-title", style:cardStyle() }, [
            h("div", { key:"heading", className:"pair-section-head" }, [
              h("h3", { id:"pair-devices-title" }, t.devicesTitle),
              h("span", { style:{ borderRadius:7, background:V.inner, padding:"2px 8px", fontSize:12, color:V.dim } }, devices.length),
            ]),
            h("p", { key:"hint", className:"pair-sub", style:{ marginTop:-10 } }, t.devicesHint),
            devices.length > 5 ? h("input", { key:"search", type:"search", value:deviceQuery,
              "aria-label":t.searchDevices, placeholder:t.searchDevices, style:inputStyle(),
              onChange:(event) => setDeviceQuery(event.target.value),
            }) : null,
            h("div", { key:"list", className:"pair-devices", tabIndex:visibleDevices.length > 3 ? 0 : undefined, "aria-label":t.devicesTitle },
              visibleDevices.length ? visibleDevices.map((device, index) => h("div", { key:device.id || index, className:"pair-device" }, [
                h("div", { className:"pair-device-icon" }, icon("phone", 19)),
                h("div", { style:{ flex:1, minWidth:0 } }, [
                  h("p", { className:"pair-device-name" }, device.name || t.deviceUntitled),
                  h("div", { className:"pair-device-meta" }, [
                    h("span", null, [device.platform, scopesText(t, device.scopes)].filter(Boolean).join(" · ")),
                    h("span", null, t.lastSeen + " " + formatSeen(device.lastSeenAt, t)),
                  ]),
                ]),
                action("revoke", revoking === device.id ? t.revoking : t.revoke, () => revoke(device), {
                  disabled:!!revoking || locked, ariaLabel:t.revoke + " · " + (device.name || t.deviceUntitled),
                }),
              ])) : h("div", { className:"pair-empty" }, !state && !bridgeError ? t.loading : query ? t.noDevicesMatch : t.devicesEmpty)),
            matchingDevices.length > 5 && !query ? action("expand", devicesExpanded ? t.collapseDevices : t.showDevices + " (" + devices.length + ")", () => setDevicesExpanded(!devicesExpanded)) : null,
          ]),
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
