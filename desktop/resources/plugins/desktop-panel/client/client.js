/**
 * `@dsh-desktop/dsh-desktop-panel` browser half.
 *
 * Hand-written in the loader's bundle format (`window.__ModuleLoader__.load`)
 * rather than produced by a bundler: the module body only needs React from the
 * host's module table, so a build step would add toolchain risk without adding
 * capability.
 *
 * It registers one settings section ("桌面端" / "Desktop") that reads the host
 * half's `/dsh-desktop` routes: shell and engine facts, the profile's plugin
 * inventory with enable/disable toggles, the desktop log tail, and the
 * diagnostics export. Every request failure is rendered as text — a panel that
 * cannot reach its host must never blank the settings page.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-desktop-panel",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const COPY = {
      zh: {
        nav: "桌面端",
        title: "DeepSeek Harness 桌面端",
        subtitle: "外壳状态、插件开关、日志与诊断",
        shell: "桌面外壳",
        engine: "引擎",
        profile: "Profile",
        plugins: "插件",
        enabled: "启用中",
        disabled: "已停用",
        restart: "重启引擎后生效",
        log: "桌面日志",
        appLog: "外壳日志",
        engineLog: "引擎日志",
        diagnostics: "导出诊断包",
        diagnosticsBusy: "正在导出…",
        copy: "复制路径",
        copied: "已复制",
        paths: "路径",
        refresh: "刷新",
        unavailable: "桌面端信息不可用（可能不是由桌面端启动的引擎）",
        toggleOff: "停用",
        toggleOn: "启用",
        core: "自带层",
        shellGroup: "随桌面端分发（junction 进 profile，不是依赖）",
        self: "面板自身：请到桌面端插件市场停用",
        empty: "没有内容",
        openMarket: "在桌面端打开插件市场（菜单 Harness → 插件市场…）",
      },
      en: {
        nav: "Desktop",
        title: "DeepSeek Harness Desktop",
        subtitle: "Shell facts, plugin toggles, logs and diagnostics",
        shell: "Desktop shell",
        engine: "Engine",
        profile: "Profile",
        plugins: "Plugins",
        enabled: "enabled",
        disabled: "disabled",
        restart: "takes effect after an engine restart",
        log: "Desktop log",
        appLog: "Shell log",
        engineLog: "Engine log",
        diagnostics: "Export diagnostics",
        diagnosticsBusy: "Exporting…",
        copy: "Copy path",
        copied: "Copied",
        paths: "Paths",
        refresh: "Refresh",
        unavailable: "Desktop facts unavailable (this engine was probably not started by the desktop)",
        toggleOff: "Disable",
        toggleOn: "Enable",
        core: "In-box",
        shellGroup: "Shipped with the desktop (linked into the profile, not a dependency)",
        self: "This panel: disable it from the desktop market window",
        empty: "Nothing here",
        openMarket: "Open the plugin market in the desktop app (menu Harness → Plugin market…)",
      },
    };

    function activeLanguage(ctx) {
      try {
        const active = ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : "";
        if (active) return String(active).toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch (_error) {
        /* fall through to the browser */
      }
      return String(navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    async function getJson(url, init) {
      const response = await fetch(url, init);
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_error) {
        body = null;
      }
      if (!response.ok) {
        throw new Error((body && body.message) || `HTTP ${response.status}`);
      }
      return body;
    }

    const box = (style, children) => h("div", { style: Object.assign({ display: "flex", flexDirection: "column", gap: "8px" }, style || {}) }, children);
    const row = (children) => h("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, children);
    const hint = (text) =>
      h("span", { style: { color: "var(--dsw-alias-label-tertiary, currentColor)", fontSize: "12px" } }, text);
    const button = (label, onClick, disabled) =>
      h(
        "button",
        {
          type: "button",
          onClick,
          disabled: Boolean(disabled),
          style: {
            padding: "4px 10px",
            borderRadius: "6px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45))",
            background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))",
            color: "var(--dsw-alias-label-primary, currentColor)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.5 : 1,
            fontSize: "12px",
          },
        },
        label,
      );
    const mono = (text) =>
      h(
        "code",
        {
          style: {
            fontFamily: "ui-monospace, Consolas, monospace",
            fontSize: "11.5px",
            wordBreak: "break-all",
            background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.10))",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
            borderRadius: "6px",
            padding: "2px 6px",
          },
        },
        text,
      );

    function Panel(props) {
      const t = COPY[props && props.lang === "en" ? "en" : "zh"];
      const [state, setState] = React.useState(null);
      const [plugins, setPlugins] = React.useState(null);
      const [logText, setLogText] = React.useState("");
      const [logWhich, setLogWhich] = React.useState("app");
      const [message, setMessage] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [copied, setCopied] = React.useState("");

      const load = async () => {
        try {
          const nextState = await getJson("/dsh-desktop/state");
          setState(nextState);
          setMessage("");
        } catch (error) {
          setMessage(String(error.message || error));
          setState(null);
        }
        try {
          const nextPlugins = await getJson("/dsh-desktop/plugins");
          setPlugins(nextPlugins);
        } catch (_error) {
          setPlugins(null);
        }
      };

      const loadLog = async (which) => {
        try {
          const body = await getJson(`/dsh-desktop/log?lines=120&which=${which === "engine" ? "engine" : "app"}`);
          setLogText(body.text || "");
        } catch (error) {
          setLogText(String(error.message || error));
        }
      };

      React.useEffect(() => {
        load();
        loadLog("app");
      }, []);

      const toggle = async (plugin) => {
        // A manifest dependency is disabled by package name; a shell plugin by
        // its Cordis row id, which is what the patch layer keys on.
        const key = plugin.rowId || plugin.packageName;
        setBusy(key);
        try {
          const result = await getJson("/dsh-desktop/toggle", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: key, disabled: !plugin.disabled }),
          });
          setMessage(result.message || "");
          await load();
        } catch (error) {
          setMessage(String(error.message || error));
        }
        setBusy("");
      };

      const exportDiagnostics = async () => {
        setBusy("diagnostics");
        try {
          const result = await getJson("/dsh-desktop/diagnostics", { method: "POST" });
          setMessage(result.bundlePath ? `${t.diagnostics}: ${result.bundlePath}` : t.diagnostics);
        } catch (error) {
          setMessage(String(error.message || error));
        }
        setBusy("");
      };

      const copy = async (value) => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(value);
          setTimeout(() => setCopied(""), 1500);
        } catch (_error) {
          setMessage(value);
        }
      };

      const facts = state || {};
      const pluginList = (plugins && plugins.plugins) || [];
      const shellRows = (plugins && plugins.shellPlugins) || [];
      const pluginRowList = (list) =>
        list.length === 0
          ? hint(t.empty)
          : box(
              {},
              list.slice(0, 80).map((plugin) =>
                row([
                  mono(plugin.packageName),
                  plugin.rowId && plugin.rowId !== plugin.packageName ? hint(`(${plugin.rowId})`) : null,
                  plugin.version ? hint(plugin.version) : null,
                  plugin.core ? hint(t.core) : null,
                  plugin.disabled ? hint(`· ${t.disabled}`) : null,
                  // The panel cannot disable itself: the patch layer applies
                  // live, so its own routes would vanish with it.
                  plugin.rowId === "dsh-desktop-panel"
                    ? hint(t.self)
                    : button(
                        plugin.disabled ? t.toggleOn : t.toggleOff,
                        () => toggle(plugin),
                        busy === (plugin.rowId || plugin.packageName),
                      ),
                ]),
              ),
            );

      return h(
        "div",
        {
          "data-dsw-desktop-panel": "",
          style: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", maxWidth: "760px", color: "var(--dsw-alias-label-primary, currentColor)" },
        },
        [
          box({ gap: "2px" }, [h("h3", { style: { margin: 0 } }, t.title), hint(t.subtitle)]),
          message ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #e2635f)", fontSize: "12px" } }, message) : null,
          state === null && !message ? hint(t.unavailable) : null,
          state
            ? box({}, [
                row([
                  hint(`${t.shell}: ${facts.shellVersion || "—"}`),
                  hint(`${t.engine}: ${facts.engineVersion || "—"}`),
                  hint(`${t.profile}: ${facts.profile || "—"}`),
                  hint(
                    `${t.plugins}: ${facts.inventory ? `${facts.inventory.enabled}/${facts.inventory.total} ${t.enabled}` : "—"}${
                      facts.inventory && facts.inventory.disabled ? ` · ${facts.inventory.disabled} ${t.disabled}` : ""
                    }`,
                  ),
                ]),
                row([
                  hint(`${t.paths}: ${facts.logDir || "—"}`),
                  mono(facts.dshHome || ""),
                  button(copied === facts.logDir ? t.copied : t.copy, () => copy(facts.logDir || "")),
                ]),
              ])
            : null,
          h("h4", { style: { margin: "6px 0 0" } }, t.plugins),
          plugins === null ? hint(t.empty) : pluginRowList(pluginList),
          shellRows.length > 0 ? h("h4", { style: { margin: "6px 0 0" } }, t.shellGroup) : null,
          plugins === null ? null : pluginRowList(shellRows),
          h("h4", { style: { margin: "6px 0 0" } }, t.log),
          row([
            button(t.appLog, () => {
              setLogWhich("app");
              loadLog("app");
            }),
            button(t.engineLog, () => {
              setLogWhich("engine");
              loadLog("engine");
            }),
            button(t.refresh, load),
            button(busy === "diagnostics" ? t.diagnosticsBusy : t.diagnostics, exportDiagnostics, busy === "diagnostics"),
          ]),
          h(
            "pre",
            {
              "data-dsh-block": "log",
              style: {
                margin: 0,
                maxHeight: "220px",
                overflow: "auto",
                background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
                border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
                borderRadius: "8px",
                padding: "10px",
                fontSize: "11.5px",
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
              },
            },
            logText || t.empty,
          ),
          hint(`${logWhich === "engine" ? t.engineLog : t.appLog} · ${t.restart}`),
        ].filter(Boolean),
      );
    }

    function report(ctx, payload) {
      try {
        fetch("/dsh-desktop/hello", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.assign({ lang: activeLanguage(ctx) }, payload)),
        }).catch(() => undefined);
      } catch (_error) {
        /* the receipt is diagnostic only */
      }
    }

    function apply(ctx) {
      const lang = activeLanguage(ctx);
      // `slots.inject` is a conditional injection: the callback runs when the
      // seat actually exists, which is later than apply(). Each stage reports
      // for itself, so the receipt says whether this half materialized, whether
      // the seat was granted, or why it was refused — the seat's own success is
      // never inferred from the intent to register.
      report(ctx, { stage: "apply", seats: [] });
      try {
        ctx.slots.inject("settings.section", () => {
          ctx.slots.register(
            {
              name: "settings.section",
              id: "desktop",
              order: 90,
              label: () => COPY[lang].nav,
              locale: "dsh-desktop-panel",
            },
            Panel,
          );
          report(ctx, { stage: "seated", seats: ["settings.section"] });
        });
      } catch (error) {
        /* A seat that is already taken must not take the whole client down. */
        if (typeof console !== "undefined") console.warn("dsh-desktop-panel: settings seat unavailable", error);
        report(ctx, { stage: "failed", seats: [], failure: String((error && error.message) || error) });
      }
    }

    return {
      name: "dsh-desktop-panel",
      inject: ["slots"],
      apply,
      Panel,
      COPY,
    };
  },
});
