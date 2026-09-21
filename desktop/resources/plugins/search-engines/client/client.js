/**
 * `@dsh-desktop/dsh-search-engines` browser half — the 「搜索引擎」 settings page.
 *
 * Hand-written in the loader's bundle format, like the desktop panel's: the body
 * needs React from the host's module table and nothing else.
 *
 * It replaces two disconnected places that made search configurable-but-broken
 * (an official card whose Endpoint silently accepted a URL that is not an
 * Anthropic Messages base, and a two-option dropdown in the desktop shell) with
 * one page: a card per engine that knows its own protocol, a real query behind
 * each 测试 button, plain-language failures, and an order that decides which
 * engine answers first.
 *
 * Styling uses only theme variables the dsh client actually defines, always with
 * theme-neutral fallbacks: naming a variable that does not exist is how the
 * desktop panel once painted black on light themes.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-search-engines",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const URLS = {
      state: "/dsh-search-engines/state",
      test: "/dsh-search-engines/test",
      save: "/dsh-search-engines/save",
      seat: "/dsh-search-engines/seat",
    };

    const COPY = {
      zh: {
        nav: "搜索引擎",
        title: "搜索引擎",
        subtitle:
          "引擎之间协议不同：官方搜索请求的是「Anthropic 兼容接口」的 /messages，本机池和 SearXNG 是各自的 JSON 接口。以前这些差异要靠你记，填错了也保存成功、要等模型回合才报错 —— 现在每张卡自己知道该发什么请求，保存前会拦住明显对不上的地址，测试按钮会当场告诉你结果。",
        active: "当前生效",
        none: "没有启用任何引擎，搜索会直接失败",
        test: "测试",
        testing: "测试中…",
        save: "保存全部",
        saving: "保存中…",
        saved: "已保存",
        reload: "重新读取",
        enable: "启用",
        disabled: "未启用",
        key: "API Key",
        keyConfigured: "已配置（不显示原值）",
        keyMissing: "未配置",
        keyHint: "留空表示不改动已保存的 Key",
        writeKey: "填入新 Key",
        clearKey: "清除",
        needsKey: "这个引擎必须配 Key 才能用",
        noKeyNeeded: "不需要 Key",
        priority: "优先级",
        priorityHint: "搜索时按这个顺序试，第一个成功就返回；全失败会把每个引擎的原因列出来。",
        up: "上移",
        down: "下移",
        global: "全局",
        timeout: "单次超时（毫秒）",
        maxResults: "结果条数",
        proxy: "代理",
        proxyHint: "留空直连。谷歌系的接口在部分网络下需要代理，例如 http://127.0.0.1:7897",
        testQuery: "测试用的关键词",
        endpoint: "实际请求",
        took: "用时",
        got: "命中",
        first: "第一条",
        ok: "正常",
        failed: "失败",
        loading: "读取中…",
        notTested: "还没测过 · 点「测试」会真的发一次搜索",
        addressWarning: "地址可能填错",
        emptyQuery: "请先填关键词",
        hint: "把「本机搜索池」打开就能立刻用：它不需要 Key。",
      },
      en: {
        nav: "Search engines",
        title: "Search engines",
        subtitle:
          "Engines speak different protocols: the official engine posts to an Anthropic-compatible /messages, while a local pool and SearXNG each expose their own JSON endpoint. Previously you had to remember which, a wrong address saved happily, and the failure only surfaced inside a model turn — now each card knows the request it must send, an address that cannot match is flagged before saving, and the test button reports the real result.",
        active: "In effect",
        none: "No engine is enabled — search will fail",
        test: "Test",
        testing: "Testing…",
        save: "Save all",
        saving: "Saving…",
        saved: "Saved",
        reload: "Reload",
        enable: "Enabled",
        disabled: "Disabled",
        key: "API key",
        keyConfigured: "Configured (value hidden)",
        keyMissing: "Not configured",
        keyHint: "Blank keeps the stored key",
        writeKey: "Enter a new key",
        clearKey: "Clear",
        needsKey: "This engine needs a key",
        noKeyNeeded: "No key needed",
        priority: "Priority",
        priorityHint: "Tried in this order; the first success answers. If all fail, every engine's reason is listed.",
        up: "Up",
        down: "Down",
        global: "Global",
        timeout: "Timeout (ms)",
        maxResults: "Results",
        proxy: "Proxy",
        proxyHint: "Blank goes direct. Google-backed endpoints need a proxy on some networks, e.g. http://127.0.0.1:7897",
        testQuery: "Test query",
        endpoint: "Requested",
        took: "Took",
        got: "Returned",
        first: "First",
        ok: "OK",
        failed: "Failed",
        loading: "Loading…",
        notTested: "Not tested yet · the button runs a real search",
        addressWarning: "Address looks wrong",
        emptyQuery: "Enter a query first",
        hint: "Enable 本机搜索池 to have working search immediately — it needs no key.",
      },
    };

    const V = {
      text: "var(--dsw-alias-label-primary, currentColor)",
      dim: "var(--dsw-alias-label-secondary, rgba(127,127,127,1))",
      faint: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))",
      border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
      borderSoft: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))",
      card: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
      inner: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
      good: "var(--dsw-alias-state-business-primary, inherit)",
      bad: "var(--dsw-alias-state-error-primary, #e2635f)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))",
    };

    /** Inputs each engine kind shows: [field, labelKey, type]. */
    const FIELDS = {
      pool: [["baseURL", "地址", "text"], ["maxResults", "结果条数", "number"]],
      searxng: [["baseURL", "实例地址", "text"], ["language", "语言", "text"], ["safesearch", "安全搜索", "number"], ["maxResults", "结果条数", "number"]],
      tavily: [["baseURL", "接口地址", "text"], ["searchDepth", "检索深度", "text"], ["maxResults", "结果条数", "number"]],
      serper: [["baseURL", "接口地址", "text"], ["gl", "地区", "text"], ["hl", "语言", "text"], ["maxResults", "结果条数", "number"]],
      deepseek: [["baseURL", "Anthropic 兼容基址", "text"], ["maxUses", "单次最多搜索次数", "number"], ["maxResults", "结果条数", "number"]],
      custom: [
        ["method", "请求方法", "select"],
        ["urlTemplate", "地址模板", "text"],
        ["headerLines", "鉴权头（每行 Name: value）", "textarea"],
        ["resultsPath", "结果数组路径", "text"],
        ["urlPath", "链接字段", "text"],
        ["titlePath", "标题字段", "text"],
        ["snippetPath", "摘要字段", "text"],
        ["maxResults", "结果条数", "number"],
      ],
    };

    const FIELDS_EN = {
      custom: [
        ["method", "Method", "select"],
        ["urlTemplate", "URL template", "text"],
        ["headerLines", "Auth headers (Name: value per line)", "textarea"],
        ["resultsPath", "Results path", "text"],
        ["urlPath", "URL field", "text"],
        ["titlePath", "Title field", "text"],
        ["snippetPath", "Snippet field", "text"],
        ["maxResults", "Results", "number"],
      ],
    };

    const labelFor = (field, lang) => {
      if (lang !== "en") return field === "地址" || true ? field : field;
      const map = {
        地址: "Address", 结果条数: "Results", 实例地址: "Instance URL", 语言: "Language", 安全搜索: "Safe search",
        接口地址: "Endpoint", 检索深度: "Depth", 地区: "Region", "Anthropic 兼容基址": "Anthropic-compatible base",
        单次最多搜索次数: "Searches per request", 请求方法: "Method", 地址模板: "URL template",
        "鉴权头（每行 Name: value）": "Auth headers", 结果数组路径: "Results path", 链接字段: "URL field",
        标题字段: "Title field", 摘要字段: "Snippet field",
      };
      return map[field] || field;
    };

    async function get(path) {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      return response.json();
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    }

    function activeLanguage(ctx) {
      try {
        const active = ctx && ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : "";
        if (active) return String(active).toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch (error) {
        /* fall through to the browser */
      }
      return String(typeof navigator !== "undefined" ? navigator.language : "").toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    const inputStyle = {
      padding: "5px 9px",
      fontSize: "12px",
      borderRadius: "7px",
      border: V.border,
      background: "transparent",
      color: V.text,
      minWidth: "200px",
      fontFamily: "inherit",
    };

    function buttonStyle(primary) {
      return {
        padding: "5px 12px",
        fontSize: "12px",
        borderRadius: "7px",
        border: V.border,
        background: primary ? V.inner : "transparent",
        color: V.text,
        cursor: "pointer",
        fontFamily: "inherit",
      };
    }

    /** One engine's card: what it is, what it needs, and a real test. */
    function EngineCard(props) {
      const { engine, t, lang, index, total, draft, keyInput, onKey, onPatch, onMove } = props;
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const fields = (lang === "en" && FIELDS_EN[engine.kind]) || FIELDS[engine.kind] || [];
      const config = draft[engine.kind] || {};

      const runTest = async () => {
        setBusy(true);
        setResult(null);
        try {
          const outcome = await post(URLS.test, { kind: engine.kind, config: config, apiKey: keyInput, query: props.query });
          setResult(outcome);
        } catch (error) {
          setResult({ ok: false, message: String((error && error.message) || error) });
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            borderRadius: "12px",
            border: engine.enabled ? V.border : V.borderSoft,
            background: V.card,
            overflow: "hidden",
          },
        },
        [
          h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", flexWrap: "wrap" } }, [
            h("input", {
              key: "on",
              type: "checkbox",
              checked: config.enabled === true,
              onChange: (event) => onPatch(engine.kind, { enabled: event.target.checked }),
              style: { cursor: "pointer" },
            }),
            h("strong", { key: "n", style: { fontSize: "13px", color: V.text } }, engine.label),
            h(
              "span",
              { key: "s", style: { fontSize: "11px", color: engine.enabled ? V.good : V.faint } },
              engine.enabled ? t.enable : t.disabled,
            ),
            engine.needsKey
              ? h(
                  "span",
                  { key: "k", style: { fontSize: "11px", color: engine.keyConfigured ? V.good : V.bad } },
                  `${engine.keyRef || t.key}：${engine.keyConfigured ? t.keyConfigured : t.keyMissing}`,
                )
              : h("span", { key: "k2", style: { fontSize: "11px", color: V.faint } }, t.noKeyNeeded),
            h("span", { key: "p", style: { fontSize: "11px", color: V.faint, marginLeft: "auto" } }, `${t.priority} ${index + 1}/${total}`),
            index > 0 ? h("button", { key: "u", type: "button", style: buttonStyle(false), onClick: () => onMove(index, -1) }, t.up) : null,
            index < total - 1 ? h("button", { key: "d", type: "button", style: buttonStyle(false), onClick: () => onMove(index, 1) }, t.down) : null,
          ]),
          h("div", { key: "hint", style: { padding: "0 14px 8px", fontSize: "11px", color: V.dim, lineHeight: 1.6 } }, engine.hint),
          engine.addressWarning
            ? h(
                "div",
                {
                  key: "warn",
                  style: { margin: "0 14px 8px", padding: "7px 10px", borderRadius: "8px", border: V.border, background: V.inner, fontSize: "11px", color: V.bad, lineHeight: 1.6 },
                },
                `${t.addressWarning}：${engine.addressWarning}`,
              )
            : null,
          h(
            "div",
            { key: "fields", style: { display: "flex", flexWrap: "wrap", gap: "8px 14px", padding: "0 14px 10px" } },
            fields.map(([field, label, type]) => {
              const value = config[field] === undefined || config[field] === null ? "" : String(config[field]);
              const onChange = (event) =>
                onPatch(engine.kind, {
                  [field]: type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value,
                });
              const common = { key: field, value: value, onChange: onChange, style: inputStyle };
              return h("label", { key: field, style: { display: "flex", flexDirection: "column", gap: "3px", fontSize: "11px", color: V.faint } }, [
                labelFor(label, lang),
                type === "textarea"
                  ? h("textarea", Object.assign({}, common, { rows: 2, style: Object.assign({}, inputStyle, { minWidth: "320px" }) }))
                  : type === "select"
                    ? h("select", common, [
                        h("option", { key: "GET", value: "GET" }, "GET"),
                        h("option", { key: "POST", value: "POST" }, "POST"),
                      ])
                    : h("input", Object.assign({}, common, { type: type === "number" ? "number" : "text" })),
              ]);
            }),
          ),
          engine.needsKey
            ? h("div", { key: "key", style: { display: "flex", alignItems: "center", gap: "8px", padding: "0 14px 10px", flexWrap: "wrap" } }, [
                h("span", { key: "l", style: { fontSize: "11px", color: V.faint } }, `${t.key}（${t.keyHint}）`),
                h("input", {
                  key: "i",
                  type: "password",
                  value: keyInput,
                  placeholder: engine.keyConfigured ? "●●●●●●●●" : t.writeKey,
                  autocomplete: "off",
                  onChange: (event) => onKey(event.target.value),
                  style: Object.assign({}, inputStyle, { minWidth: "240px" }),
                }),
                keyInput !== "" ? h("button", { key: "c", type: "button", style: buttonStyle(false), onClick: () => onKey("") }, t.clearKey) : null,
              ])
            : null,
          h("div", { key: "urlhint", style: { padding: "0 14px 10px", fontSize: "11px", color: V.faint, lineHeight: 1.6 } }, engine.urlHint),
          h("div", { key: "actions", style: { display: "flex", alignItems: "center", gap: "8px", padding: "9px 14px", borderTop: V.borderSoft, background: V.inner, flexWrap: "wrap" } }, [
            h(
              "button",
              { key: "test", type: "button", style: buttonStyle(true), disabled: busy, onClick: runTest },
              busy ? t.testing : t.test,
            ),
            h("span", { key: "q", style: { fontSize: "11px", color: V.faint } }, `${t.testQuery}：${props.query}`),
          ]),
          result
            ? h(
                "div",
                { key: "res", style: { padding: "8px 14px 10px", fontSize: "11px", lineHeight: 1.7, color: result.ok ? V.text : V.bad, borderTop: V.borderSoft } },
                [
                  h("div", { key: "m" }, `${result.ok ? t.ok : t.failed}：${result.message || ""}`),
                  result.endpoint
                    ? h("div", { key: "e", style: { color: V.faint, wordBreak: "break-all" } }, `${t.endpoint}：${result.endpoint}`)
                    : null,
                  result.count !== undefined
                    ? h("div", { key: "c", style: { color: V.dim } }, `${t.got} ${result.count}${result.first ? ` · ${t.first}：${result.first}` : ""}`)
                    : null,
                ],
              )
            : h("div", { key: "res0", style: { padding: "8px 14px 10px", fontSize: "11px", color: V.faint, borderTop: V.borderSoft } }, t.notTested),
        ],
      );
    }

    function GlobalBar(props) {
      const { t, global, onChange } = props;
      const rows = [
        ["timeoutMs", t.timeout, "number"],
        ["maxResults", t.maxResults, "number"],
        ["proxy", t.proxy, "text"],
      ];
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "12px", border: V.borderSoft, background: V.card } },
        [
          h("strong", { key: "t", style: { fontSize: "12px", color: V.text } }, t.global),
          h(
            "div",
            { key: "f", style: { display: "flex", flexWrap: "wrap", gap: "8px 14px" } },
            rows.map(([field, label, type]) =>
              h("label", { key: field, style: { display: "flex", flexDirection: "column", gap: "3px", fontSize: "11px", color: V.faint } }, [
                label,
                h("input", {
                  type: type,
                  value: global[field] === undefined || global[field] === null ? "" : String(global[field]),
                  onChange: (event) =>
                    onChange({
                      [field]: type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value,
                    }),
                  style: Object.assign({}, inputStyle, { minWidth: field === "proxy" ? "260px" : "120px" }),
                }),
              ]),
            ),
          ),
          h("span", { key: "ph", style: { fontSize: "11px", color: V.faint } }, t.proxyHint),
        ],
      );
    }

    function SearchEnginesPage(props) {
      const lang = props.lang === "en" ? "en" : "zh";
      const t = COPY[lang];
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState({});
      const [order, setOrder] = useState([]);
      const [global, setGlobal] = useState({});
      const [keys, setKeys] = useState({});
      const [message, setMessage] = useState("");
      const [busy, setBusy] = useState(false);
      const query = "DeepSeek Harness";

      const load = useCallback(async () => {
        try {
          const incoming = await get(URLS.state);
          if (!incoming || incoming.error) {
            setMessage(String((incoming && incoming.error) || "读取失败"));
            return;
          }
          setState(incoming);
          const nextDraft = {};
          for (const engine of incoming.engines || []) nextDraft[engine.kind] = Object.assign({}, engine.config);
          setDraft(nextDraft);
          setOrder((incoming.order || []).slice());
          setGlobal(Object.assign({}, incoming.global || {}));
        } catch (error) {
          setMessage(String((error && error.message) || error));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const patchEngine = useCallback((kind, patch) => {
        setDraft((current) => Object.assign({}, current, { [kind]: Object.assign({}, current[kind], patch) }));
        setOrder((current) => {
          const enabled = patch.enabled;
          if (enabled === true && !current.includes(kind)) return current.concat([kind]);
          if (enabled === false) return current.filter((entry) => entry !== kind);
          return current;
        });
      }, []);

      const move = useCallback((index, delta) => {
        setOrder((current) => {
          const next = current.slice();
          const target = index + delta;
          if (target < 0 || target >= next.length) return current;
          const tmp = next[index];
          next[index] = next[target];
          next[target] = tmp;
          return next;
        });
      }, []);

      const save = useCallback(async () => {
        setBusy(true);
        try {
          // Keys typed here go straight to the credentials service under each
          // card's own reference; a blank field means "leave the stored key alone".
          const secrets = {};
          for (const engine of (state && state.engines) || []) {
            const typed = String(keys[engine.kind] || "").trim();
            if (typed !== "" && engine.keyRef) secrets[engine.keyRef] = typed;
          }
          const outcome = await post(URLS.save, { engines: draft, order: order, global: global, secrets: secrets });
          if (outcome.ok) setKeys({});
          setMessage(outcome.ok ? `${t.saved}：${outcome.message || ""}` : `失败：${outcome.message || ""}`);
          if (outcome.ok) await load();
        } catch (error) {
          setMessage(`失败：${String((error && error.message) || error)}`);
        } finally {
          setBusy(false);
        }
      }, [draft, order, global, keys, state, load, t]);

      const ordered = (state && state.engines ? state.engines.slice() : []).sort((a, b) => {
        const ai = order.indexOf(a.kind);
        const bi = order.indexOf(b.kind);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "12px", padding: "4px 2px 20px", color: V.text } }, [
        h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
          h("strong", { key: "t", style: { fontSize: "15px" } }, t.title),
          h("span", { key: "s", style: { fontSize: "12px", color: V.dim, lineHeight: 1.7 } }, t.subtitle),
        ]),
        h(
          "div",
          { key: "bar", style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "10px 14px", borderRadius: "12px", border: V.borderSoft, background: V.card } },
          [
            h(
              "span",
              { key: "a", style: { fontSize: "12px", color: state && state.anyEnabled ? V.text : V.bad } },
              state
                ? state.anyEnabled
                  ? `${t.active}：${(ordered.find((engine) => engine.kind === state.active) || {}).label || state.active}`
                  : t.none
                : t.loading,
            ),
            h("span", { key: "h", style: { fontSize: "11px", color: V.faint } }, t.hint),
            h("div", { key: "sp", style: { marginLeft: "auto", display: "flex", gap: "8px" } }, [
              h("button", { key: "r", type: "button", style: buttonStyle(false), onClick: load }, t.reload),
              h("button", { key: "s", type: "button", style: buttonStyle(true), disabled: busy, onClick: save }, busy ? t.saving : t.save),
            ]),
          ],
        ),
        message ? h("div", { key: "msg", style: { fontSize: "12px", color: V.dim } }, message) : null,
        h(GlobalBar, { key: "g", t: t, global: global, onChange: (patch) => setGlobal((current) => Object.assign({}, current, patch)) }),
        h(
          "div",
          { key: "cards", style: { display: "flex", flexDirection: "column", gap: "10px" } },
          ordered.map((engine, index) =>
            h(EngineCard, {
              key: engine.kind,
              engine: engine,
              t: t,
              lang: lang,
              index: index,
              total: ordered.length,
              draft: draft,
              query: query,
              keyInput: keys[engine.kind] || "",
              onKey: (value) => setKeys((current) => Object.assign({}, current, { [engine.kind]: value })),
              onPatch: patchEngine,
              onMove: move,
            }),
          ),
        ),
        h("span", { key: "ph2", style: { fontSize: "11px", color: V.faint, lineHeight: 1.7 } }, t.priorityHint),
      ]);
    }

    function apply(ctx) {
      const lang = activeLanguage(ctx);
      try {
        ctx.slots.inject("settings.section", () => {
          ctx.slots.register(
            {
              name: "settings.section",
              id: "search-engines",
              order: 21,
              label: () => COPY[lang].nav,
              locale: "dsh-search-engines",
              inject: () => ({ lang: lang }),
            },
            SearchEnginesPage,
          );
          post(URLS.seat, { stage: "seated", lang: lang }).catch(() => undefined);
        });
      } catch (error) {
        if (typeof console !== "undefined") console.warn("dsh-search-engines: settings seat unavailable", error);
        post(URLS.seat, { stage: "failed", failure: String((error && error.message) || error) }).catch(() => undefined);
      }
    }

    return {
      name: "dsh-search-engines",
      inject: ["slots", "locale"],
      apply: apply,
      SearchEnginesPage: SearchEnginesPage,
      COPY: COPY,
    };
  },
});
