/**
 * `@dsh-desktop/dsh-model-vision` browser half — the 「模型能力」 settings page.
 *
 * Hand-written in the loader's bundle format (`window.__ModuleLoader__.load`),
 * like the desktop panel's: the body needs React from the host's module table and
 * nothing else.
 *
 * It renders one settings section: catalogue status, a fleet summary, a queue of
 * corrections waiting for confirmation, and one card per provider route whose
 * models carry capability chips (图片 / 上下文 / 输出上限) with the source each
 * value came from. Anything the resolver could not state shows as 未知 instead of
 * a guess, and every value can be overridden by hand.
 *
 * Styling uses only theme variables the dsh client actually defines, always with
 * theme-neutral fallbacks: naming a variable that does not exist is how the
 * desktop panel once painted black on light themes.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-model-vision",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    const URLS = {
      overview: "/dsh-model-vision/overview",
      plan: "/dsh-model-vision/plan",
      apply: "/dsh-model-vision/apply",
      sync: "/dsh-model-vision/sync",
      override: "/dsh-model-vision/override",
      catalogue: "/dsh-model-vision/catalogue",
      seat: "/dsh-model-vision/seat",
    };

    const COPY = {
      zh: {
        nav: "模型能力",
        title: "模型能力",
        subtitle:
          "上游网关基本不公布模型能力（你 6 条路由里只有 1 条会给出上下文长度，1 条什么都不返回），所以这里用「上游元数据 + 跨厂商能力目录 + 家族规则」三层解析，目录每日自动更新。新出现的模型自动写入；要修正已有值前，先把差异列给你确认。",
        refreshCatalogue: "刷新能力目录",
        identifyAll: "一键识别全部",
        catalogue: "能力目录",
        entries: "条",
        fromNetwork: "网络",
        fromCache: "本地缓存",
        fromBundled: "内置快照",
        never: "从未识别",
        stale: "已过期·后台刷新中",
        fresh: "最新",
        routes: "路由",
        models: "个模型",
        visionCount: "支持图片",
        unknownCount: "无法判定",
        pending: "待确认",
        pendingTitle: "待确认的能力修正",
        pendingHint: "这些模型配置里已经有值，但解析结果不同 —— 只有你知道原来的值是不是有意写的。",
        applyAll: "全部应用",
        ignore: "忽略",
        applyRoute: "识别这条路由",
        collapse: "收起",
        expand: "展开",
        search: "筛选模型…",
        all: "全部",
        onlyVision: "支持图片",
        onlyUnknown: "未知",
        onlyManual: "手动改过",
        images: "图片",
        context: "上下文",
        output: "输出上限",
        reasoning: "推理",
        noReasoning: "无推理",
        reasoningToggle: "开关",
        sourceLabel: "来源",
        srcManual: "手动",
        srcUpstream: "上游",
        srcCatalogue: "目录",
        srcRule: "推断",
        srcDeclared: "已有声明",
        srcUnknown: "未知",
        noModels: "这条路由还没有模型",
        loading: "读取中…",
        saving: "写入中…",
        edit: "改数值",
        save: "保存",
        cancel: "取消",
        reset: "清除",
        manualHint: "手动值优先，之后不再被自动同步改动。",
        applied: "已应用",
        refreshed: "能力目录已更新",
        error: "失败",
        empty: "还没有配置任何 provider 路由",
      },
      en: {
        nav: "Capabilities",
        title: "Model capabilities",
        subtitle:
          "Gateways barely publish capabilities (only one of your six routes reports a context length, one reports nothing at all), so this resolves them from upstream metadata, a cross-vendor catalogue refreshed daily, and family rules. New models are written automatically; corrections to existing values are listed as a diff first.",
        refreshCatalogue: "Refresh catalogue",
        identifyAll: "Resolve everything",
        catalogue: "Catalogue",
        entries: "entries",
        fromNetwork: "network",
        fromCache: "cache",
        fromBundled: "bundled",
        never: "never resolved",
        stale: "stale · refreshing",
        fresh: "fresh",
        routes: "routes",
        models: "models",
        visionCount: "accept images",
        unknownCount: "unknown",
        pending: "to confirm",
        pendingTitle: "Capability corrections to confirm",
        pendingHint: "These models already carry a value the resolver disagrees with — only you know whether it was deliberate.",
        applyAll: "Apply all",
        ignore: "Ignore",
        applyRoute: "Resolve this route",
        collapse: "Collapse",
        expand: "Expand",
        search: "Filter models…",
        all: "All",
        onlyVision: "Accept images",
        onlyUnknown: "Unknown",
        onlyManual: "Hand-set",
        images: "images",
        context: "context",
        output: "output",
        reasoning: "reasoning",
        noReasoning: "none",
        reasoningToggle: "on/off",
        sourceLabel: "source",
        srcManual: "manual",
        srcUpstream: "upstream",
        srcCatalogue: "catalogue",
        srcRule: "rule",
        srcDeclared: "declared",
        srcUnknown: "unknown",
        noModels: "This route has no models yet",
        loading: "Loading…",
        saving: "Saving…",
        edit: "Edit",
        save: "Save",
        cancel: "Cancel",
        reset: "Reset",
        manualHint: "A hand-set value wins and is no longer touched by sync.",
        applied: "applied",
        refreshed: "Catalogue updated",
        error: "Failed",
        empty: "No provider route is configured yet",
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

    async function api(url, init) {
      const response = await fetch(url, init);
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok || !body || body.ok !== true) {
        throw new Error((body && body.message) || `HTTP ${response.status}`);
      }
      return body;
    }

    function post(url, payload) {
      return api(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    }

    function formatTokens(value) {
      if (typeof value !== "number" || value <= 0) return "";
      if (value >= 1000000) return `${Math.round((value / 1000000) * 100) / 100}M`;
      if (value >= 1000) return `${Math.round(value / 1000)}k`;
      return String(value);
    }

    function sourceText(t, source) {
      if (source === "manual") return t.srcManual;
      if (source === "upstream") return t.srcUpstream;
      if (source === "catalogue") return t.srcCatalogue;
      if (source === "rule") return t.srcRule;
      if (source === "declared") return t.srcDeclared;
      return t.srcUnknown;
    }

    function sourceColor(source) {
      if (source === "manual" || source === "upstream") return V.good;
      if (source === "catalogue") return V.dim;
      if (source === "rule") return V.faint;
      return V.bad;
    }

    const chip = (key, text, color) =>
      h(
        "span",
        {
          key,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "1px 8px",
            borderRadius: "999px",
            fontSize: "11px",
            lineHeight: "16px",
            border: V.borderSoft,
            background: V.inner,
            color: color || V.dim,
            whiteSpace: "nowrap",
          },
        },
        text,
      );

    const button = (key, text, onClick, options) =>
      h(
        "button",
        {
          key,
          type: "button",
          onClick: onClick,
          disabled: !!(options && options.disabled),
          style: {
            padding: "4px 10px",
            fontSize: "12px",
            borderRadius: "8px",
            cursor: options && options.disabled ? "not-allowed" : "pointer",
            opacity: options && options.disabled ? 0.55 : 1,
            border: V.border,
            background: options && options.primary ? V.inner : "transparent",
            color: options && options.danger ? V.bad : V.text,
          },
        },
        text,
      );

    const stat = (key, label, value, tone) =>
      h(
        "div",
        {
          key,
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            padding: "8px 14px",
            minWidth: "84px",
            borderRadius: "10px",
            border: V.borderSoft,
            background: V.inner,
          },
        },
        [
          h("span", { key: "v", style: { fontSize: "18px", fontWeight: 600, color: tone || V.text } }, String(value)),
          h("span", { key: "l", style: { fontSize: "11px", color: V.faint } }, label),
        ],
      );

    const reasoningText = (t, cap) =>
      !cap || !cap.value
        ? t.srcUnknown
        : cap.value.kind === "efforts"
          ? cap.value.levels.join("/")
          : cap.value.kind === "none"
            ? t.noReasoning
            : t.reasoningToggle;

    function ModelRow(props) {
      const t = props.t;
      const route = props.route;
      const model = props.model;
      const [editing, setEditing] = useState(false);
      const [context, setContext] = useState("");
      const [output, setOutput] = useState("");
      const [busy, setBusy] = useState(false);
      const caps = model.capabilities || {};
      const input = caps.input || { source: "unknown" };
      const acceptsImage = (input.value || ["text"]).indexOf("image") >= 0;

      const override = async (field, value) => {
        setBusy(true);
        try {
          await post(URLS.override, { provider: route, model: model.id, field: field, value: value });
          props.onMessage(`${model.id} · ${field}`);
          await props.onChanged();
        } catch (error) {
          props.onMessage(`${t.error}: ${String((error && error.message) || error)}`);
        }
        setBusy(false);
      };

      const saveNumbers = async () => {
        const ctxValue = context.trim() === "" ? null : Number(context);
        const outValue = output.trim() === "" ? null : Number(output);
        if (ctxValue !== null) await override("contextWindow", ctxValue);
        if (outValue !== null) await override("maxTokens", outValue);
        setEditing(false);
      };

      return h("div", { style: { display: "flex", flexDirection: "column", borderBottom: V.borderSoft } }, [
        h(
          "div",
          { key: "main", style: { display: "flex", alignItems: "center", gap: "10px", padding: "7px 12px", flexWrap: "wrap" } },
          [
            h("div", { key: "name", style: { display: "flex", flexDirection: "column", minWidth: "170px", flex: "1 1 200px" } }, [
              h("span", { key: "n", style: { fontSize: "13px", color: V.text } }, model.name || model.id),
              h("code", { key: "i", style: { fontSize: "11px", color: V.faint } }, model.id),
            ]),
            h("div", { key: "caps", style: { display: "flex", gap: "6px", flexWrap: "wrap", flex: "2 1 300px" } }, [
              chip("img", acceptsImage ? t.images : "text", acceptsImage ? V.good : V.dim),
              caps.contextWindow && caps.contextWindow.value
                ? chip("ctx", `${t.context} ${formatTokens(caps.contextWindow.value)}`, V.dim)
                : chip("ctx", `${t.context} ${t.srcUnknown}`, V.bad),
              caps.maxTokens && caps.maxTokens.value ? chip("out", `${t.output} ${formatTokens(caps.maxTokens.value)}`, V.dim) : null,
              caps.reasoning && caps.reasoning.value
                ? chip("eff", `${t.reasoning} ${reasoningText(t, caps.reasoning)}`, caps.reasoning.value.kind === "efforts" ? V.good : V.dim)
                : null,
              chip("src", `${t.sourceLabel} · ${sourceText(t, input.source)}`, sourceColor(input.source)),
              model.present ? null : chip("new", "new", V.good),
            ]),
            h("div", { key: "act", style: { display: "flex", gap: "6px", alignItems: "center", marginLeft: "auto" } }, [
              button("toggle", acceptsImage ? `${t.images} ✓` : t.images, () => override("input", acceptsImage ? ["text"] : ["text", "image"]), { disabled: busy }),
              button("edit", t.edit, () => {
                setContext(caps.contextWindow && caps.contextWindow.value ? String(caps.contextWindow.value) : "");
                setOutput(caps.maxTokens && caps.maxTokens.value ? String(caps.maxTokens.value) : "");
                setEditing(!editing);
              }),
            ]),
          ],
        ),
        editing
          ? h(
              "div",
              {
                key: "editor",
                style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "8px 12px", background: V.inner, borderTop: V.borderSoft },
              },
              [
                h("span", { key: "l1", style: { fontSize: "11px", color: V.faint } }, t.context),
                h("input", {
                  key: "ctx",
                  type: "text",
                  value: context,
                  placeholder: "1000000",
                  onChange: (event) => setContext(event.target.value),
                  style: { width: "110px", padding: "3px 8px", fontSize: "12px", borderRadius: "6px", border: V.border, background: "transparent", color: V.text },
                }),
                h("span", { key: "l2", style: { fontSize: "11px", color: V.faint } }, t.output),
                h("input", {
                  key: "out",
                  type: "text",
                  value: output,
                  placeholder: "65536",
                  onChange: (event) => setOutput(event.target.value),
                  style: { width: "100px", padding: "3px 8px", fontSize: "12px", borderRadius: "6px", border: V.border, background: "transparent", color: V.text },
                }),
                button("save", t.save, saveNumbers, { primary: true }),
                button("resetctx", t.reset, () => override("contextWindow", null)),
                button("cancel", t.cancel, () => setEditing(false)),
                h("span", { key: "hint", style: { fontSize: "11px", color: V.faint } }, t.manualHint),
              ],
            )
          : null,
      ]);
    }

    function RouteCard(props) {
      const t = props.t;
      const route = props.route;
      const [open, setOpen] = useState(false);
      const [plan, setPlan] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState("");
      const [filter, setFilter] = useState("all");

      const loadPlan = useCallback(async () => {
        setError("");
        try {
          const body = await api(`${URLS.plan}?provider=${encodeURIComponent(route.route)}`);
          setPlan(body.plan);
        } catch (problem) {
          setError(String((problem && problem.message) || problem));
        }
      }, [route.route]);

      useEffect(() => {
        if (open && plan === null) loadPlan();
      }, [open, plan, loadPlan]);

      const identify = async () => {
        setBusy(true);
        try {
          const body = await post(URLS.apply, { provider: route.route, accepted: [] });
          await loadPlan();
          await props.reloadOverview();
          props.onMessage(`${route.route}: ${t.applied} ${body.applied} ${t.models || ""}`.trim());
        } catch (problem) {
          props.onMessage(`${t.error}: ${String((problem && problem.message) || problem)}`);
        }
        setBusy(false);
      };

      const acceptCorrections = async () => {
        const ids = (plan ? plan.models : []).filter((m) => m.changes.some((c) => c.verdict === "correct")).map((m) => m.id);
        if (ids.length === 0) return;
        setBusy(true);
        try {
          const body = await post(URLS.apply, { provider: route.route, accepted: ids });
          await loadPlan();
          await props.reloadOverview();
          props.onMessage(`${route.route}: ${t.applied} ${body.applied}`);
        } catch (problem) {
          props.onMessage(`${t.error}: ${String((problem && problem.message) || problem)}`);
        }
        setBusy(false);
      };

      const models = plan ? plan.models : [];
      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return models.filter((model) => {
          if (needle && `${model.id} ${model.name}`.toLowerCase().indexOf(needle) < 0) return false;
          const input = (model.capabilities || {}).input || {};
          const accepts = (input.value || ["text"]).indexOf("image") >= 0;
          if (filter === "vision") return accepts;
          if (filter === "unknown") return model.unknown;
          if (filter === "manual") return input.source === "manual";
          return true;
        });
      }, [models, query, filter]);

      const filters = [["all", t.all], ["vision", t.onlyVision], ["unknown", t.onlyUnknown], ["manual", t.onlyManual]];

      return h("div", { style: { display: "flex", flexDirection: "column", borderRadius: "12px", border: V.border, background: V.card, overflow: "hidden" } }, [
        h(
          "div",
          {
            key: "head",
            style: { display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", flexWrap: "wrap", cursor: "pointer" },
            onClick: () => setOpen(!open),
          },
          [
            h("strong", { key: "n", style: { fontSize: "13px" } }, route.displayName || route.route),
            route.baseURL ? h("code", { key: "r", style: { fontSize: "11px", color: V.faint } }, route.baseURL) : null,
            chip("total", `${route.total} ${t.models}`, V.dim),
            route.vision > 0 ? chip("vision", `${t.visionCount} ${route.vision}`, V.good) : null,
            route.unknown > 0 ? chip("unknown", `${t.unknownCount} ${route.unknown}`, V.bad) : null,
            route.pendingCorrections > 0 ? chip("pending", `${t.pending} ${route.pendingCorrections}`, V.bad) : null,
            h("span", { key: "sum", style: { fontSize: "11px", color: V.faint, marginLeft: "auto" } },
              route.lastSync ? `${route.lastSync.at.slice(5, 16)} · ${route.lastSync.summary}` : t.never),
            button("open", open ? t.collapse : t.expand, (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              setOpen(!open);
            }),
            button("go", t.applyRoute, (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              identify();
            }, { disabled: busy, primary: true }),
          ],
        ),
        open
          ? h("div", { key: "body", style: { borderTop: V.borderSoft, display: "flex", flexDirection: "column" } }, [
              h("div", { key: "tools", style: { display: "flex", gap: "8px", alignItems: "center", padding: "8px 12px", flexWrap: "wrap" } }, [
                models.length > 8
                  ? h("input", {
                      key: "q",
                      type: "text",
                      value: query,
                      placeholder: t.search,
                      onChange: (event) => setQuery(event.target.value),
                      style: { flex: "1 1 180px", padding: "4px 10px", fontSize: "12px", borderRadius: "8px", border: V.border, background: V.inner, color: V.text },
                    })
                  : null,
                h("div", { key: "filters", style: { display: "flex", gap: "4px", cursor: "pointer" } },
                  filters.map((pair) => h("span", { key: pair[0], onClick: () => setFilter(pair[0]) }, chip(`f-${pair[0]}`, pair[1], filter === pair[0] ? V.good : V.dim)))),
                route.pendingCorrections > 0 ? button("applycorr", `${t.applyAll} (${route.pendingCorrections})`, acceptCorrections, { primary: true }) : null,
                h("span", { key: "shown", style: { fontSize: "11px", color: V.faint, marginLeft: "auto" } }, `${visible.length}/${models.length}`),
              ]),
              error ? h("div", { key: "err", style: { padding: "6px 12px", color: V.bad, fontSize: "12px" } }, error) : null,
              plan === null
                ? h("div", { key: "loading", style: { padding: "12px", fontSize: "12px", color: V.dim } }, t.loading)
                : models.length === 0
                  ? h("div", { key: "empty", style: { padding: "12px", fontSize: "12px", color: V.dim } }, t.noModels)
                  : h(
                      "div",
                      { key: "list", "data-dsh-block": "models", style: { maxHeight: "420px", overflowY: "auto", background: V.inner } },
                      visible.map((model) =>
                        h(ModelRow, { key: model.id, t: t, route: route.route, model: model, onChanged: loadPlan, onMessage: props.onMessage }),
                      ),
                    ),
            ])
          : null,
      ]);
    }

    function PendingQueue(props) {
      const t = props.t;
      const pending = props.routes.filter((route) => route.pendingCorrections > 0);
      if (pending.length === 0) return null;
      const total = pending.reduce((sum, route) => sum + route.pendingCorrections, 0);
      return h(
        "div",
        {
          style: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "12px", border: `1px solid ${V.bad}`, background: V.inner },
        },
        [
          h("strong", { key: "t", style: { fontSize: "13px", color: V.bad } }, `${t.pendingTitle} (${total})`),
          h("span", { key: "h", style: { fontSize: "11px", color: V.faint } }, t.pendingHint),
          h("div", { key: "rows", style: { display: "flex", flexDirection: "column", gap: "6px" } },
            pending.map((route) =>
              h("div", { key: route.route, style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", flexWrap: "wrap" } }, [
                h("code", { key: "r", style: { color: V.text } }, route.route),
                h("span", { key: "c", style: { color: V.dim } }, `${route.pendingCorrections} ${t.pending}`),
                button("apply", t.applyAll, () => props.onApply(route.route), { primary: true }),
                button("ignore", t.ignore, () => props.onMessage(`${route.route}: ${t.ignore}`)),
              ]),
            )),
        ],
      );
    }

    function CapabilitiesPage(props) {
      const t = COPY[props && props.lang === "en" ? "en" : "zh"];
      const [overview, setOverview] = useState(null);
      const [message, setMessage] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        try {
          const body = await api(URLS.overview);
          setOverview(body);
          setError("");
        } catch (problem) {
          setError(String((problem && problem.message) || problem));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      useEffect(() => {
        post(URLS.seat, { stage: "seated", page: "model-capabilities" }).catch(() => undefined);
      }, []);

      const syncAll = async () => {
        setBusy(true);
        setMessage("");
        try {
          const body = await post(URLS.sync, {});
          await load();
          const applied = (body.results || []).reduce((sum, row) => sum + (row.applied || 0), 0);
          setMessage(`${t.refreshed}: ${(body.refresh && body.refresh.message) || ""} · ${t.applied} ${applied}`);
        } catch (problem) {
          setError(`${t.error}: ${String((problem && problem.message) || problem)}`);
        }
        setBusy(false);
      };

      const refreshCatalogue = async () => {
        setBusy(true);
        try {
          const body = await post(URLS.catalogue, {});
          await load();
          setMessage(`${t.refreshed}: ${body.message || ""}`);
        } catch (problem) {
          setError(`${t.error}: ${String((problem && problem.message) || problem)}`);
        }
        setBusy(false);
      };

      const applyRoute = async (route) => {
        try {
          const body = await post(URLS.apply, { provider: route, accepted: [] });
          await load();
          setMessage(`${route}: ${t.applied} ${body.applied}`);
        } catch (problem) {
          setError(`${t.error}: ${String((problem && problem.message) || problem)}`);
        }
      };

      const routes = overview ? overview.routes : [];
      const catalogue = overview ? overview.catalogue : null;
      const totals = routes.reduce(
        (acc, route) => ({
          total: acc.total + route.total,
          vision: acc.vision + route.vision,
          unknown: acc.unknown + route.unknown,
          pending: acc.pending + route.pendingCorrections,
        }),
        { total: 0, vision: 0, unknown: 0, pending: 0 },
      );

      return h(
        "div",
        {
          "data-dsh-model-vision": "page",
          style: { display: "flex", flexDirection: "column", gap: "14px", width: "100%", maxWidth: "1080px", color: V.text, paddingBottom: "24px" },
        },
        [
          h("div", { key: "head", style: { display: "flex", flexDirection: "column", gap: "4px" } }, [
            h("h3", { key: "t", style: { margin: 0, fontSize: "16px" } }, t.title),
            h("p", { key: "s", style: { margin: 0, fontSize: "12px", color: V.dim, lineHeight: "18px" } }, t.subtitle),
          ]),
          h("div", { key: "bar", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
            catalogue
              ? chip(
                  "cat",
                  `${t.catalogue} ${catalogue.count} ${t.entries} · ${catalogue.origin === "network" ? t.fromNetwork : catalogue.origin === "cache" ? t.fromCache : t.fromBundled} · ${catalogue.stale ? t.stale : t.fresh}`,
                  catalogue.stale ? V.bad : V.dim,
                )
              : null,
            h("span", { key: "flex", style: { flex: "1 1 auto" } }),
            button("refresh", t.refreshCatalogue, refreshCatalogue, { disabled: busy || !!(catalogue && catalogue.refreshing) }),
            button("sync", t.identifyAll, syncAll, { disabled: busy, primary: true }),
          ]),
          h("div", { key: "stats", style: { display: "flex", gap: "10px", flexWrap: "wrap" } }, [
            stat("r", t.routes, routes.length),
            stat("m", t.models, totals.total),
            stat("v", t.visionCount, totals.vision, V.good),
            stat("p", t.pending, totals.pending, totals.pending > 0 ? V.bad : undefined),
            stat("u", t.unknownCount, totals.unknown, totals.unknown > 0 ? V.dim : undefined),
          ]),
          message ? h("div", { key: "msg", style: { fontSize: "12px", color: V.good } }, message) : null,
          error ? h("div", { key: "err", style: { fontSize: "12px", color: V.bad } }, error) : null,
          overview === null ? h("div", { key: "loading", style: { fontSize: "12px", color: V.dim } }, t.loading) : null,
          routes.length === 0 && overview !== null ? h("div", { key: "empty", style: { fontSize: "12px", color: V.dim } }, t.empty) : null,
          h(PendingQueue, { key: "pending", t: t, routes: routes, onApply: applyRoute, onMessage: setMessage }),
          h("div", { key: "routes", style: { display: "flex", flexDirection: "column", gap: "10px" } },
            routes.map((route) => h(RouteCard, { key: route.route, t: t, route: route, onMessage: setMessage, reloadOverview: load }))),
        ],
      );
    }

    function apply(ctx) {
      const lang = activeLanguage(ctx);
      try {
        ctx.slots.inject("settings.section", () => {
          ctx.slots.register(
            {
              name: "settings.section",
              id: "model-capabilities",
              order: 20,
              label: () => COPY[lang].nav,
              locale: "dsh-model-vision",
              inject: () => ({ lang: lang }),
            },
            CapabilitiesPage,
          );
          post(URLS.seat, { stage: "seated", lang: lang }).catch(() => undefined);
        });
      } catch (error) {
        if (typeof console !== "undefined") console.warn("dsh-model-vision: settings seat unavailable", error);
        post(URLS.seat, { stage: "failed", failure: String((error && error.message) || error) }).catch(() => undefined);
      }
    }

    return {
      name: "dsh-model-vision",
      inject: ["slots", "locale"],
      apply: apply,
      CapabilitiesPage: CapabilitiesPage,
      COPY: COPY,
      formatTokens: formatTokens,
    };
  },
});
