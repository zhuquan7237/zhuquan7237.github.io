/*!
 * dsh.zhuquan.xyz -- 双语切换 (zh-CN <-> en)
 * 中文原文留在 HTML 里（无 JS 也能读中文）；切到 en 时用 i18n/locales/<page>.json 覆盖。
 * 词条缺失时保持中文，绝不出现空白。首帧由 <head> 内联脚本做属性标记，本脚本负责替换与按钮。
 */
(function () {
  var KEY = "dsh.lang";
  var LS = (function () {
    try { var t = "__dsh"; localStorage.setItem(t, "1"); localStorage.removeItem(t); return localStorage; }
    catch (e) {
      var m = {};
      return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); } };
    }
  })();

  function current() { return LS.getItem(KEY) === "en" ? "en" : "zh"; }
  function norm(s) { return String(s).replace(/[\s\u00a0]+/g, " ").trim(); }

  var cache = {};
  var pageFile = "home";
  var snapshot = null;

  function detectPage() {
    var path = location.pathname.replace(/\/+$/, "");
    var base = path.split("/").pop() || "";
    /* 子目录首页按目录名取词条：/dl/ → dl；站点根 → home */
    if (!base || base === "index.html" || base === "index") {
      var dir = path.split("/").filter(Boolean).pop() || "";
      return dir === "dl" ? "dl" : "home";
    }
    return base.replace(/\.html$/, "");
  }

  function takeSnapshot() {
    var nodes = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var p = node.parentNode;
      if (!p) continue;
      if (p.nodeName === "SCRIPT" || p.nodeName === "STYLE" || p.nodeName === "NOSCRIPT") continue;
      nodes.push([node, node.nodeValue]);
    }
    var attrs = [];
    document.querySelectorAll("*").forEach(function (el) {
      ["aria-label", "title", "placeholder", "alt", "content"].forEach(function (a) {
        var v = el.getAttribute && el.getAttribute(a);
        if (v) attrs.push([el, a, v]);
      });
    });
    snapshot = { nodes: nodes, attrs: attrs, title: document.title };
  }

  function restore() {
    if (!snapshot) return;
    snapshot.nodes.forEach(function (pair) { pair[0].nodeValue = pair[1]; });
    snapshot.attrs.forEach(function (t) { t[0].setAttribute(t[1], t[2]); });
    document.title = snapshot.title;
    snapshot = null;
  }

  function applyTextRules(rules) {
    var map = {};
    rules.forEach(function (r) { map[norm(r[0])] = r[1]; });
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node, hit = 0;
    var todo = [];
    while ((node = walker.nextNode())) {
      var p = node.parentNode;
      if (!p) continue;
      if (p.nodeName === "SCRIPT" || p.nodeName === "STYLE" || p.nodeName === "NOSCRIPT") continue;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      todo.push(node);
    }
    todo.forEach(function (tn) {
      var k = norm(tn.nodeValue);
      if (Object.prototype.hasOwnProperty.call(map, k)) { tn.nodeValue = map[k]; hit++; }
    });
    /* 属性值：同样按原文精确匹配 */
    var ATTRS = ["aria-label", "title", "placeholder", "alt"];
    document.querySelectorAll("*").forEach(function (el) {
      ATTRS.forEach(function (a) {
        var v = el.getAttribute && el.getAttribute(a);
        if (!v) return;
        var k = norm(v);
        if (Object.prototype.hasOwnProperty.call(map, k)) { el.setAttribute(a, map[k]); hit++; }
      });
    });
    return hit;
  }

  function applySelectors(spec, prop) {
    if (!spec) return 0;
    var hit = 0;
    Object.keys(spec).forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (prop === "html") el.innerHTML = spec[sel];
          else el.textContent = spec[sel];
          hit++;
        });
      } catch (e) {}
    });
    return hit;
  }

  function applyAttrs(spec) {
    if (!spec) return 0;
    var hit = 0;
    Object.keys(spec).forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          var o = spec[sel];
          Object.keys(o).forEach(function (a) { el.setAttribute(a, o[a]); });
          hit++;
        });
      } catch (e) {}
    });
    return hit;
  }

  function mark(lang) {
    document.documentElement.setAttribute("data-lang", lang);
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-lang-switch]").forEach(function (el) {
      el.setAttribute("aria-pressed", lang === "en" ? "true" : "false");
      var zh = el.querySelector("[data-lang-zh]");
      var en = el.querySelector("[data-lang-en]");
      if (zh) zh.setAttribute("aria-current", lang === "zh" ? "true" : "false");
      if (en) en.setAttribute("aria-current", lang === "en" ? "true" : "false");
    });
  }

  function relabel() {
    try { if (typeof window.__dshRelabel === "function") window.__dshRelabel(); } catch (e) {}
  }

  function translate(lang) {
    if (lang !== "en") {
      restore();
      mark("zh");
      relabel();
      return;
    }
    if (!snapshot) takeSnapshot();
    var d = cache[pageFile] || {};
    var n = 0;
    if (d.text) n += applyTextRules(d.text);
    if (d.sel) n += applySelectors(d.sel, "text");
    if (d.html) n += applySelectors(d.html, "html");
    if (d.attrs) n += applyAttrs(d.attrs);
    if (d.title) document.title = d.title;
    mark("en");
    relabel();
    return n;
  }

  /* 词条目录：直接由本脚本自身 src 推导，永远站得住（/dl/ 页、根页都不用改） */
  function dictBase() {
    var src = "";
    var ss = document.getElementsByTagName("script");
    for (var i = 0; i < ss.length; i++) {
      if (ss[i].src && /\/i18n\.js(\?|$)/.test(ss[i].src)) { src = ss[i].src; break; }
    }
    if (src) return src.replace(/i18n\.js(\?.*)?$/, "locales/");
    return "i18n/locales/";
  }

  function loadDict(file, cb) {
    if (cache[file]) return cb(null, cache[file]);
    var xhr = new XMLHttpRequest();
    xhr.open("GET", dictBase() + file + ".json", true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cache[file] = JSON.parse(xhr.responseText); return cb(null, cache[file]); }
        catch (e) { return cb(e); }
      }
      cb(new Error("http " + xhr.status));
    };
    xhr.onerror = function () { cb(new Error("network")); };
    xhr.send();
  }

  function setLang(lang, persist) {
    if (persist !== false) LS.setItem(KEY, lang);
    if (lang === "en" && !cache[pageFile]) {
      loadDict(pageFile, function (err) {
        if (err) { console.warn("[i18n] dictionary failed:", err.message); mark("zh"); return; }
        translate("en");
        document.dispatchEvent(new CustomEvent("dsh:lang", { detail: { lang: "en" } }));
      });
      return;
    }
    translate(lang);
    document.dispatchEvent(new CustomEvent("dsh:lang", { detail: { lang: lang } }));
  }

  function init() {
    pageFile = detectPage();
    document.querySelectorAll("[data-lang-switch]").forEach(function (el) {
      el.addEventListener("click", function (ev) {
        ev.preventDefault();
        setLang(current() === "en" ? "zh" : "en");
      });
    });
    var lang = current();
    mark(lang);
    if (lang !== "en") return;
    loadDict(pageFile, function (err) {
      if (err) { console.warn("[i18n] dictionary failed:", err.message); mark("zh"); return; }
      translate("en");
    });
  }

  window.DSH_I18N = {
    lang: current,
    set: setLang,
    reload: function () { setLang(current(), false); },
    t: function (zh, en) { return current() === "en" ? en : zh; },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
