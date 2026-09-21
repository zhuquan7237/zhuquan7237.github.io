/**
 * `@dsh-desktop/dsh-model-vision` browser half.
 *
 * Hand-written in the loader's bundle format (`window.__ModuleLoader__.load`),
 * like the desktop panel's: the module body needs React from the host's module
 * table and nothing else, so a bundler would add toolchain risk without adding
 * capability.
 *
 * It registers one entry under the Models page's keyed `settings.models.provider-card`
 * seat, keyed by the pi-ai settings namespace, so it lands on every pi-ai
 * provider card — shipped, added, and hand-declared alike — and renders the
 * per-model 「支持图片输入」 toggle the shipped editor does not offer. All reads
 * and writes go through the host half's routes; a failure is rendered as text,
 * never as a blank card.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-model-vision",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const PROVIDER_CARD_KEY = "llm-pi-ai";
    const STATE_URL = "/dsh-model-vision/state";
    const SET_URL = "/dsh-model-vision/set";
    const SEAT_URL = "/dsh-model-vision/seat";

    const COPY = {
      zh: {
        title: "支持图片输入",
        subtitle: "勾选后端点上真正接受图片的模型（手写路由必须勾，否则引擎会拦下图片）",
        declared: "已声明",
        undeclared: "未声明",
        engineYes: "引擎已识别图片",
        engineNo: "引擎判定纯文本",
        on: "能收图",
        off: "仅文本",
        loading: "读取模型列表…",
        empty: "这条路由还没有模型",
        saving: "保存中…",
        refresh: "刷新",
        filter: "筛选模型…",
        note: "提示：勾选代表“这个端点确实收图”；勾错了上游会在回合中途拒绝。",
      },
      en: {
        title: "Image input",
        subtitle: "Tick the models this endpoint really accepts images for — a hand-declared route must declare one, or the engine refuses images",
        declared: "declared",
        undeclared: "not declared",
        engineYes: "engine accepts images",
        engineNo: "engine reads text only",
        on: "images",
        off: "text only",
        loading: "Reading the model list…",
        empty: "This route has no models yet",
        saving: "Saving…",
        refresh: "Refresh",
        filter: "Filter models…",
        note: "Declaring images is a claim about the endpoint; an over-claim is refused by the provider mid-turn.",
      },
    };

    function activeLanguage(ctx) {
      try {
        const active = ctx && ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : "";
        if (active) return String(active).toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch (error) {
        /* fall through to the browser */
      }
      return String(typeof navigator !== "undefined" ? navigator.language : "").toLowerCase().startsWith("zh") ? "zh" : "en";
    }

    function pickCopy(lang) {
      return lang === "en" ? COPY.en : COPY.zh;
    }

    function report(ctx, payload) {
      try {
        fetch(SEAT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch (error) {
        /* a missing host route must not break the page */
      }
    }

    async function readJson(response) {
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok || !body || body.ok !== true) {
        const message = (body && body.message) || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return body;
    }

    const dim = { color: "var(--dsw-alias-label-secondary, rgba(127,127,127,1))", fontSize: "12px" };
    const faint = { color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))", fontSize: "12px" };

    function Panel(props) {
      const lang = props && props.lang === "en" ? "en" : "zh";
      const t = pickCopy(lang);
      const route = props && props.provider && props.provider.provider ? props.provider.provider : "";
      const [state, setState] = React.useState({ status: "loading", models: [], error: "", saving: "", note: "" });
      const [query, setQuery] = React.useState("");

      const load = React.useCallback(async () => {
        if (!route) {
          setState({ status: "error", models: [], error: "缺少 provider 标识", saving: "", note: "" });
          return;
        }
        setState((prev) => Object.assign({}, prev, { status: "loading", error: "" }));
        try {
          const body = await readJson(await fetch(`${STATE_URL}?provider=${encodeURIComponent(route)}`));
          setState({ status: "ready", models: body.models || [], error: "", saving: "", note: body.note || "" });
          report(props && props.ctx, { provider: route, rendered: (body.models || []).length, failure: "" });
        } catch (error) {
          const message = String((error && error.message) || error);
          setState({ status: "error", models: [], error: message, saving: "", note: "" });
          report(props && props.ctx, { provider: route, rendered: -1, failure: message });
        }
      }, [route]);

      React.useEffect(() => {
        load();
      }, [load]);

      const toggle = React.useCallback(
        async (model, next) => {
          setState((prev) => Object.assign({}, prev, { saving: model.id, error: "" }));
          try {
            const body = await readJson(
              await fetch(SET_URL, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ provider: route, model: model.id, image: next }),
              }),
            );
            setState({ status: "ready", models: body.models || [], error: "", saving: "", note: body.note || "" });
          } catch (error) {
            setState((prev) => Object.assign({}, prev, { saving: "", error: String((error && error.message) || error) }));
          }
        },
        [route],
      );

      const enabled = state.models.filter((model) => model.supportsImage).length;
      const needle = query.trim().toLowerCase();
      const visible = needle === ""
        ? state.models
        : state.models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(needle));

      return h(
        "div",
        {
          "data-dsh-model-vision": route,
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            width: "100%",
            marginTop: "10px",
            padding: "12px",
            borderRadius: "10px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
            background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))",
            color: "var(--dsw-alias-label-primary, currentColor)",
          },
        },
        [
          h("div", { key: "head", style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" } }, [
            h("strong", { key: "title" }, t.title),
            h("span", { key: "count", style: faint }, `${enabled}/${state.models.length || 0}`),
            h(
              "button",
              {
                key: "refresh",
                type: "button",
                onClick: load,
                style: {
                  marginLeft: "auto",
                  fontSize: "12px",
                  padding: "2px 8px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
                  background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))",
                  color: "inherit",
                },
              },
              t.refresh,
            ),
          ]),
          h("div", { key: "sub", style: faint }, t.subtitle),
          state.note ? h("div", { key: "note", style: { ...dim, color: "var(--dsw-alias-state-business-primary, inherit)" } }, state.note) : null,
          state.error
            ? h("div", { key: "err", style: { color: "var(--dsw-alias-state-error-primary, #e2635f)", fontSize: "12px" } }, state.error)
            : null,
          state.status === "loading"
            ? h("div", { key: "loading", style: dim }, t.loading)
            : state.models.length === 0
              ? h("div", { key: "empty", style: dim }, t.empty)
              : h(
                  "div",
                  { key: "listwrap", style: { display: "flex", flexDirection: "column", gap: "6px" } },
                  [
                    state.models.length > 12
                      ? h("input", {
                          key: "filter",
                          type: "text",
                          value: query,
                          placeholder: t.filter,
                          onChange: (event) => setQuery(event.target.value),
                          style: {
                            padding: "4px 8px",
                            fontSize: "12px",
                            borderRadius: "6px",
                            border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
                            background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                            color: "inherit",
                          },
                        })
                      : null,
                    needle === "" ? null : h("div", { key: "count", style: faint }, `${visible.length}/${state.models.length}`),
                    h(
                      "div",
                      {
                        key: "list",
                        "data-dsh-block": "models",
                        style: {
                          display: "flex",
                          flexDirection: "column",
                          maxHeight: "260px",
                          overflowY: "auto",
                          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24))",
                          borderRadius: "8px",
                          background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))",
                        },
                      },
                      visible.map((model) =>
                        h(
                          "label",
                          {
                            key: model.id,
                            style: {
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              padding: "6px 10px",
                              cursor: state.saving === model.id ? "progress" : "pointer",
                              borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))",
                            },
                          },
                          [
                            h("input", {
                              key: "box",
                              type: "checkbox",
                              checked: model.supportsImage === true,
                              disabled: state.saving !== "",
                              onChange: (event) => toggle(model, event.target.checked),
                              style: { cursor: "inherit" },
                            }),
                            h("span", { key: "name", style: { flex: "0 0 auto" } }, model.name || model.id),
                            h("code", { key: "id", style: { ...faint, marginLeft: "auto" } }, model.id),
                            h("span", { key: "chip", style: { ...faint, minWidth: "92px", textAlign: "right" } },
                              model.supportsImage ? t.engineYes : t.engineNo),
                            h("span", { key: "decl", style: { ...faint, minWidth: "58px", textAlign: "right" } },
                              model.declared === null ? t.undeclared : t.declared),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
          h("div", { key: "hint", style: faint }, t.note),
          state.saving ? h("div", { key: "saving", style: dim }, t.saving) : null,
        ],
      );
    }

    function apply(ctx) {
      const lang = activeLanguage(ctx);
      report(ctx, { provider: "", rendered: -1, failure: "apply", lang });
      try {
        ctx.slots.inject("settings.models.provider-card", () => {
          ctx.slots.register(
            {
              name: "settings.models.provider-card",
              id: "model-vision",
              key: PROVIDER_CARD_KEY,
              order: 120,
              label: () => pickCopy(lang).title,
              locale: "dsh-model-vision",
              inject: () => ({ lang }),
            },
            Panel,
          );
          report(ctx, { provider: PROVIDER_CARD_KEY, rendered: -1, failure: "", lang });
        });
      } catch (error) {
        /* A taken seat must not take the whole client down. */
        if (typeof console !== "undefined") console.warn("dsh-model-vision: provider-card seat unavailable", error);
        report(ctx, { provider: PROVIDER_CARD_KEY, rendered: -1, failure: String((error && error.message) || error), lang });
      }
    }

    return {
      name: "dsh-model-vision",
      inject: ["slots", "locale"],
      apply,
      Panel,
      COPY,
    };
  },
});
