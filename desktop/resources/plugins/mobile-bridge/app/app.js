/**
 * The phone half: a control surface for the desktop harness.
 *
 * No model runs here. Every conversation, task, message and model configuration
 * lives on the computer; this app lists them, drives them and reflects their
 * state. It talks to the desktop bridge over the tunnel, holds its device token
 * in IndexedDB (never localStorage), and streams live events over one WebSocket
 * it reconnects with the last sequence it saw.
 *
 * Structure is deliberately flat: one router, one render per view, one event
 * reducer. Mobile-first layout, and every colour comes from the engine's own
 * theme tokens in theme.css.
 */
(() => {
  const API = { pair: '/mobile/pair', meta: '/mobile/meta', sessions: '/mobile/sessions', models: '/mobile/models', credentials: '/mobile/credentials', devices: '/mobile/devices', rpc: '/mobile/rpc' };
  const WS_URL = (token) => `${location.origin.replace(/^http/, 'ws')}/mobile/events?token=${encodeURIComponent(token)}`;

  const state = {
    token: null, device: null, server: null,
    view: 'sessions', session: null, sessions: [], search: '', searching: false,
    history: [], live: {}, running: false, doc: null, devices: [],
    ws: null, seq: 0, connected: false, retry: 0, theme: localStorage.getItem('theme') || 'dark',   // 外壳是固定深色，默认必须深色，否则浅色系统下深色字压深色底
    draft: '', busy: false, thinking: false, openThink: {},
  };
  const el = (id) => document.getElementById(id);

  // ----------------------------------------------------------------- IndexedDB
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('dsh-mobile', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    },
    async get(key) {
      const db = await idb.open();
      return new Promise((resolve) => {
        const request = db.transaction('kv').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      });
    },
    async set(key, value) {
      const db = await idb.open();
      return new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    },
    async del(key) {
      const db = await idb.open();
      return new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => resolve(true);
      });
    },
  };

  // --------------------------------------------------------------------- fetch
  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 401) {
      await forget();
      throw new Error('令牌已失效，请重新配对');
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, message: text.slice(0, 200) }; }
    if (data && data.ok === false) { const error = new Error(data.message || '请求失败'); error.code = data.code; error.payload = data; throw error; }
    return data;
  }

  function toast(message, ms = 2600) {
    const node = el('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, ms);
  }

  const timeText = (value) => {
    const ms = Number(value) || 0;
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };

  // ------------------------------------------------------------------ pairing
  function renderPairing(message) {
    el('composer').hidden = true;
    el('back').hidden = true;
    el('action').hidden = true;
    el('title').textContent = '配对这台手机';
    el('subtitle').textContent = state.server?.publicUrl ? location.host : '和电脑端建立连接';
    el('view').innerHTML = `
      <div class="card">
        <img class="whale" src="/mobile/whale_wave.webp" alt="" />
        <h2>第一步：在电脑上打开配对页</h2>
        <p>电脑端设置里的「移动端」页会显示一串配对码（5 分钟内有效）。手机和电脑在同一个网络时也可以直接访问电脑的局域网地址。</p>
        <h2>第二步：把配对码填在这里</h2>
        <label class="field">配对码<input id="pair-code" placeholder="XXXX-XXXX" autocapitalize="characters" autocomplete="off" /></label>
        <label class="field">设备名称<input id="pair-name" value="我的手机" /></label>
        <p class="meta">默认授予「查看 + 发消息」。要在这台手机上改模型配置，请在电脑端更严格地授权。</p>
        <button class="primary" id="pair-go">配对</button>
        ${message ? `<p style="color:var(--dsw-alias-state-error-primary)">${message}</p>` : ''}
      </div>`;
    el('pair-go').onclick = async () => {
      const code = el('pair-code').value.trim();
      if (!code) return toast('请填配对码');
      try {
        const result = await fetch(API.pair, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, deviceName: el('pair-name').value.trim() || '我的手机', platform: navigator.platform || '', scopes: ['read', 'prompt'] }),
        }).then((r) => r.json());
        if (!result.ok) return toast(result.message || '配对失败');
        state.token = result.token;
        await idb.set('token', result.token);
        await idb.set('device', result.device);
        toast('配对成功');
        await boot();
      } catch (error) {
        toast(String(error.message || error));
      }
    };
  }

  async function forget() {
    state.token = null; state.device = null;
    await idb.del('token'); await idb.del('device');
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  }

  // ------------------------------------------------------------------- events
  function applyEvent(frame) {
    state.seq = Math.max(state.seq, Number(frame.seq) || 0);
    if (frame.kind === 'notify') {
      toast(`${frame.title || ''}${frame.body ? ' · ' + frame.body : ''}`);
      if (state.view === 'sessions') void loadSessions();
      return;
    }
    if (frame.kind !== 'event') return;
    if (state.session && frame.sessionId && frame.sessionId !== state.session.sessionId) return;
    if (frame.type === 'turn/start') { state.running = true; state.live = {}; state.thinking = false; renderComposer(); }
    if (frame.type === 'turn/end') { state.running = false; state.thinking = false; renderComposer(); }
    if (frame.type === 'assistant/chunk') {
      // An adapter may stream its thinking before the answer; that belongs in
      // the running line, never pasted into the reply bubble.
      if (chunkIsReasoning(frame.data)) {
        if (!state.thinking) { state.thinking = true; renderChat(true); }
      } else {
        const text = chunkText(frame.data);
        if (text) {
          if (state.thinking) state.thinking = false;
          const key = `${frame.data && frame.data.turn}:${frame.data && frame.data.step}`;
          state.live[key] = (state.live[key] || '') + text;
          renderChat();
        }
      }
    }
    if (frame.type === 'assistant/message' || frame.type === 'tool/call' || frame.type === 'tool/result' || frame.type === 'user/message') {
      if (state.session) void loadHistory(state.session.sessionId, { keepScroll: true });
    }
  }

  /** Pull display text out of a stream chunk, whatever shape the engine used. */
  function chunkText(data) {
    const chunk = data && data.chunk;
    if (typeof chunk === 'string') return chunk;
    if (chunk && typeof chunk === 'object') {
      if (typeof chunk.text === 'string') return chunk.text;
      if (typeof chunk.delta === 'string') return chunk.delta;
      if (chunk.delta && typeof chunk.delta.text === 'string') return chunk.delta.text;
    }
    return '';
  }

  /** Is this chunk the model thinking out loud? */
  function chunkIsReasoning(data) {
    const chunk = data && data.chunk;
    if (!chunk || typeof chunk !== 'object') return false;
    if (chunk.type === 'reasoning') return true;
    return !!(chunk.delta && typeof chunk.delta === 'object' && chunk.delta.type === 'reasoning');
  }

  function connect() {
    if (!state.token) return;
    if (state.ws) { try { state.ws.close(); } catch {} }
    const socket = new WebSocket(WS_URL(state.token));
    state.ws = socket;
    socket.onopen = () => { state.connected = true; state.retry = 0; renderHeader(); socket.send(JSON.stringify({ type: 'hello', since: state.seq })); };
    socket.onmessage = (event) => { try { applyEvent(JSON.parse(event.data)); } catch {} };
    socket.onclose = () => {
      state.connected = false; renderHeader();
      if (!state.token) return;
      const delay = Math.min(15000, 800 * Math.pow(1.6, state.retry++));
      setTimeout(connect, delay);
    };
    socket.onerror = () => {};
  }

  // ------------------------------------------------------------------ sessions
  async function loadSessions() {
    try {
      const data = await api(state.search ? `${API.sessions}?query=${encodeURIComponent(state.search)}` : API.sessions);
      state.sessions = Array.isArray(data.items) ? data.items : [];
      state.searching = !!data.search;
      if (state.view === 'sessions') renderSessions();
    } catch (error) { toast(String(error.message || error)); }
  }

  function sessionTitle(session) {
    const values = session.projections && session.projections.values;
    if (values && typeof values === 'object') {
      for (const [key, value] of Object.entries(values)) {
        if (/title|name/i.test(key) && typeof value === 'string' && value.trim()) return value.trim();
        if (value && typeof value === 'object' && typeof value.title === 'string' && value.title.trim()) return value.title.trim();
      }
    }
    return session.sessionId ? session.sessionId.slice(0, 8) : '会话';
  }

  function renderSessions() {
    el('composer').hidden = true;
    el('back').hidden = true;
    el('action').hidden = false;
    el('title').textContent = '会话';
    renderHeader();
    const rows = state.sessions.map((session) => {
      const title = sessionTitle(session);
      return `<div class="row" data-session="${session.sessionId}">
        <div class="grow">
          <div class="name">${escapeHtml(title)}</div>
          <div class="meta"><span>${timeText(session.updatedAt)}</span>${session.running ? '<span class="pill live">正在生成</span>' : ''}${session.cwd ? `<span>${escapeHtml(String(session.cwd).split(/[\\/]/).pop())}</span>` : ''}</div>
        </div>
        <span>›</span>
      </div>`;
    }).join('');
    el('view').innerHTML = `
      <div class="search"><input id="q" placeholder="搜索历史会话…" value="${escapeHtml(state.search)}" /></div>
      ${rows || `<div class="empty">${state.search ? '没有匹配的会话' : '<img class="whale" src="/mobile/whale_wave.webp" alt="" />还没有会话。点右下角新建一个，或在下面直接对当前会话说话。'}</div>`}
      <div style="height:22px"></div>`;
    const input = el('q');
    input.oninput = () => {
      state.search = input.value.trim();
      clearTimeout(renderSessions.timer);
      renderSessions.timer = setTimeout(() => { void loadSessions(); }, 320);
    };
    el('view').querySelectorAll('.row[data-session]').forEach((row) => {
      row.onclick = () => { void openSession(row.dataset.session); };
    });
  }

  async function openSession(sessionId) {
    state.session = { sessionId };
    state.view = 'chat';
    state.history = []; state.live = {};
    try {
      const listed = state.sessions.find((item) => item.sessionId === sessionId);
      if (listed) state.session = listed;
    } catch {}
    await loadHistory(sessionId);
    window.history.pushState({ sessionId }, '', `#s=${sessionId}`);
  }

  async function loadHistory(sessionId, options = {}) {
    try {
      const data = await api(`${API.sessions}/${encodeURIComponent(sessionId)}/history?maxMessages=100`);
      const items = data.items || data.entries || data.history || [];
      state.history = items;
      state.running = items.some((item) => item && item.event && item.event.type === 'turn/start') && !items.some((item) => item && item.event && item.event.type === 'turn/end');
      if (state.view === 'chat') renderChat(options.keepScroll);
    } catch (error) { toast(String(error.message || error)); }
  }

  /**
   * One row per thing that happened. An assistant turn arrives with three kinds
   * of block - reasoning, the answer, and tool calls - and the thinking is
   * folded into its own one-line row instead of being flattened into the reply.
   */
  function messageRows() {
    const rows = [];
    const seenCalls = new Set();
    let stepStart = 0;
    for (const item of state.history) {
      const event = item && item.event ? item.event : item;
      if (!event || typeof event !== 'object') continue;
      const data = event.data || {};
      const time = Number(event.time) || 0;
      if (event.type === 'step/start') { stepStart = time; continue; }
      if (event.type === 'user/message') {
        const text = extractText(data);
        if (text) rows.push({ who: 'user', text });
      } else if (event.type === 'assistant/message') {
        const parts = contentParts(data.message || data);
        const thinking = parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('\n\n').trim();
        const answer = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n').trim();
        if (thinking) {
          const seconds = stepStart && time > stepStart ? Math.round((time - stepStart) / 1000) : 0;
          rows.push({ who: 'think', text: thinking, label: seconds > 0 ? `思考 ${seconds} 秒` : '思考过程' });
        }
        if (answer) rows.push({ who: 'assistant', text: answer });
        for (const call of parts.filter((part) => part.type === 'tool-call')) {
          const id = call.id || '';
          if (id && seenCalls.has(id)) continue;
          if (id) seenCalls.add(id);
          const args = decodeArgs(call.arguments || '');
          rows.push({ who: 'tool', text: `调用 ${call.name || '工具'}`, detail: hint(args), raw: args });
        }
      } else if (event.type === 'tool/call') {
        const id = data.callId || data.id || '';
        if (id && seenCalls.has(id)) continue;
        if (id) seenCalls.add(id);
        const args = decodeArgs(data.arguments || '');
        rows.push({ who: 'tool', text: `调用 ${data.name || '工具'}`, detail: hint(args), raw: args });
      } else if (event.type === 'tool/result') {
        const text = extractText(data.message || data);
        rows.push({ who: 'tool', text: `工具返回${isFailedResult(data) ? '（失败）' : ''}`, detail: hint(text, 100), raw: text });
      }
    }
    return rows;
  }

  /** Content blocks of a message, tolerating plain-string content. */
  function contentParts(node) {
    if (!node || typeof node !== 'object') return [];
    if (!Array.isArray(node.content)) {
      const text = extractText(node);
      return text ? [{ type: 'text', text }] : [];
    }
    return node.content.filter((part) => part && typeof part === 'object').map((part) => ({
      type: String(part.type || ''),
      text: typeof part.text === 'string' ? part.text : '',
      id: part.id || part.callId || '',
      name: part.name || '',
      arguments: typeof part.arguments === 'string' ? part.arguments : '',
    }));
  }

  /** Did the tool fail? The flag rides on the result block, not the event. */
  function isFailedResult(data) {
    for (const container of [data, data && data.message]) {
      if (!container || typeof container !== 'object') continue;
      if (container.isError === true) return true;
      if (Array.isArray(container.content)) {
        for (const part of container.content) if (part && part.isError === true) return true;
      }
    }
    return false;
  }

  /** Tool arguments arrive as a JSON string of a JSON object. */
  function decodeArgs(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
    const out = [];
    const walk = (node) => {
      if (typeof node === 'string') out.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(parsed);
    return out.join('\n');
  }

  function hint(text, limit = 80) {
    const line = String(text == null ? '' : text).split('\n').find((entry) => entry.trim()) || '';
    const trimmed = line.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
  }

  /** A drawing or page the phone can render itself. */
  function findArtifact(text) {
    const value = String(text == null ? '' : text);
    if (!value) return null;
    const fence = value.match(/```(svg|html)\s*\n([\s\S]*?)```/i);
    if (fence) return { kind: fence[1].toLowerCase(), markup: fence[2].trim() };
    const svg = value.match(/<svg[\s\S]*?<\/svg>/i);
    if (svg) return { kind: 'svg', markup: svg[0].trim() };
    const html = value.match(/<!doctype html[\s\S]*?<\/html>|<html[\s\S]*?<\/html>/i);
    if (html) return { kind: 'html', markup: html[0].trim() };
    return null;
  }

  /** Stable key for a folded thinking row, so re-renders keep it open/closed. */
  function thinkKey(row) {
    const text = String(row.text || '');
    return `${text.length}:${text.slice(0, 32)}`;
  }

  /** SVG needs a page around it before a browser will scale it nicely. */
  function artifactPage(artifact) {
    if (artifact.kind !== 'svg') return artifact.markup;
    return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />`
      + '<style>html,body{margin:0;padding:12px;background:#fff}svg{max-width:100%;height:auto;display:block;margin:0 auto}</style></head><body>'
      + `${artifact.markup}</body></html>`;
  }

  function openPreview(artifact) {
    if (!artifact) return;
    showSheet(
      `<h2>${artifact.kind === 'svg' ? '图形预览' : '网页预览'}</h2>
       <div class="preview-frame"><iframe sandbox="allow-scripts" srcdoc="${escapeHtml(artifactPage(artifact))}"></iframe></div>
       <div class="sheet-actions"><button class="primary" id="preview-copy">复制源码</button><button id="preview-close">关闭</button></div>`,
      () => {
        const copy = el('preview-copy');
        if (copy) copy.onclick = async () => {
          try { await navigator.clipboard.writeText(artifact.markup); toast('源码已复制'); }
          catch { toast('复制失败，请长按选择'); }
        };
        const close = el('preview-close');
        if (close) close.onclick = () => hideSheet();
      },
    );
  }

  function extractText(node) {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    if (typeof node.text === 'string') return node.text;
    if (Array.isArray(node.content)) return node.content.map(extractText).filter(Boolean).join('\n');
    if (Array.isArray(node.parts)) return node.parts.map(extractText).filter(Boolean).join('\n');
    if (node.message) return extractText(node.message);
    return '';
  }

  function renderChat(keepScroll) {
    el('composer').hidden = false;
    el('back').hidden = false;
    el('action').hidden = false;
    el('title').textContent = state.session ? sessionTitle(state.session) : '会话';
    renderHeader();
    const chips = {};
    const bubbles = messageRows().map((row) => {
      if (row.who === 'think') {
        const key = thinkKey(row);
        const open = state.openThink[key] === true;
        return `<div class="msg think"><button class="think-line${open ? ' open' : ''}" type="button" data-think="${escapeHtml(key)}">`
          + `<span class="glyph">✦</span><span class="label">${escapeHtml(row.label || '思考过程')}</span><span class="chev">${open ? '⌃' : '⌄'}</span></button>`
          + `<div class="think-body bubble"${open ? '' : ' hidden'}>${escapeHtml(row.text)}</div></div>`;
      }
      const artifact = findArtifact(row.raw) || findArtifact(row.text);
      let chip = '';
      if (artifact) {
        const key = `p${Object.keys(chips).length}`;
        chips[key] = artifact;
        chip = `<button class="preview-chip" type="button" data-preview="${key}">预览${artifact.kind === 'svg' ? '图形' : '网页'}</button>`;
      }
      const detail = row.detail ? `<span class="detail">${escapeHtml(row.detail)}</span>` : '';
      return `<div class="msg ${escapeHtml(row.who)}"><span class="who">${row.who === 'user' ? '我' : row.who === 'tool' ? '工具' : '电脑端'}</span>`
        + `<div class="bubble">${escapeHtml(row.text)}${detail}${chip}</div></div>`;
    }).join('');
    const live = Object.entries(state.live).map(([key, text]) => `<div class="msg assistant"><span class="who">电脑端 · 正在生成 ${key}</span><div class="bubble">${escapeHtml(text)}</div></div>`).join('');
    const running = state.thinking && !Object.keys(state.live).length
      ? '<div class="msg think running"><span class="who">电脑端</span><div class="bubble"><span class="dot"></span>正在思考…</div></div>'
      : '';
    el('view').innerHTML = bubbles + running + live + '<div style="height:16px"></div><div id="anchor"></div>';
    el('view').querySelectorAll('.think-line').forEach((button) => {
      button.onclick = () => {
        const body = button.nextElementSibling;
        const open = !(body && !body.hidden);
        state.openThink[button.dataset.think] = open;
        if (body) body.hidden = !open;
        button.classList.toggle('open', open);
        const chev = button.querySelector('.chev');
        if (chev) chev.textContent = open ? '⌃' : '⌄';
      };
    });
    el('view').querySelectorAll('.preview-chip').forEach((button) => {
      button.onclick = () => openPreview(chips[button.dataset.preview]);
    });
    if (!keepScroll) el('view').scrollTop = el('view').scrollHeight;
    renderComposer();
  }

  function renderComposer() {
    el('send').hidden = state.running;
    el('stop').hidden = !state.running;
  }

  async function send() {
    const text = el('input').value.trim();
    if (!text || !state.session) return;
    el('input').value = ''; state.draft = '';
    el('view').insertAdjacentHTML('beforeend', `<div class="msg user"><span class="who">我</span><div class="bubble">${escapeHtml(text)}</div></div>`);
    el('view').scrollTop = el('view').scrollHeight;
    try {
      await api(`${API.sessions}/${encodeURIComponent(state.session.sessionId)}/prompt`, { method: 'POST', body: { text, mode: 'queue' } });
      state.running = true; renderComposer();
    } catch (error) {
      toast(String(error.message || error));
      el('input').value = text;
    }
  }

  // ------------------------------------------------------------------- settings
  async function openSettings() {
    el('composer').hidden = true;
    el('view').innerHTML = `<div class="empty">读取中…</div>`;
    let doc = null;
    try { doc = (await api(API.models)).doc; } catch {}
    let devices = [];
    try { devices = (await api(API.devices)).devices || []; } catch {}
    state.doc = doc; state.devices = devices;
    const provider = (doc && doc.providers) || [];
    const items = (doc && doc.items) || [];
    el('view').innerHTML = `
      <div class="group-title">连接</div>
      <div class="card">
        <h2>${escapeHtml((state.device && state.device.name) || '这台手机')}</h2>
        <p>${state.connected ? '已连接' : '未连接'} · ${escapeHtml((state.device && (state.device.scopes || []).join('/')) || '')} · 权限由电脑端授予</p>
        <p>事件游标 ${state.seq}${doc ? ` · 模型配置修订 ${doc.revision}.${doc.overlayRevision}` : ''}</p>
        <button class="ghost" id="theme">主题：${state.theme === 'auto' ? '跟随系统' : state.theme === 'dark' ? '深色' : '浅色'}</button>
        <button class="danger" id="unpair" style="margin-left:8px">解除本机绑定</button>
      </div>
      <div class="group-title">模型配置（${items.length} 个，来自电脑端）</div>
      ${provider.map((row) => `<div class="card"><h2>${escapeHtml(row.name || row.id)}</h2><p>${escapeHtml(row.baseURL || '')} · ${escapeHtml(row.apiMode || '')} · ${row.apiKeyConfigured ? 'Key 已配置' : 'Key 未配置'}</p></div>`).join('')}
      ${items.length ? `<div class="card"><h2>逐模型开关</h2><p>启用状态与标签是手机端的标记，保存在电脑端桥接里；引擎本身没有「停用某个模型」这个字段。</p>${items.map((item) => `<label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" data-model="${escapeHtml(item.id)}" ${item.enabled ? 'checked' : ''}/><span>${escapeHtml(item.name || item.modelId)}<br><span class="meta">${escapeHtml(item.provider)} · 图片 ${(item.params && item.params.input || []).includes('image') ? '是' : '否'} · 上下文 ${(item.params && item.params.contextWindow) || '—'}</span></span></label>`).join('')}<button class="primary" id="save-models">保存模型开关</button></div>` : ''}
      <div class="group-title">已绑定的设备（${devices.length}）</div>
      <div class="card">${devices.map((row) => `<div class="row" style="padding:8px 0"><div class="grow"><div class="name">${escapeHtml(row.name || '未命名')}</div><div class="meta"><span>${(row.scopes || []).join('/')}</span><span>${timeText(row.lastSeenAt)}</span>${row.id === (state.device && state.device.id) ? '<span class="pill live">本机</span>' : ''}</div></div>${row.id === (state.device && state.device.id) ? '' : `<button class="ghost danger" data-revoke="${row.id}">解除</button>`}</div>`).join('') || '<p>还没有设备</p>'}</div>
      <div style="height:24px"></div>`;
    el('action').hidden = false;
    el('title').textContent = '设置';
    el('subtitle').textContent = state.server ? `${state.server.product || 'Harness'} · 桥接 v${state.server.version}` : '';
    el('theme').onclick = () => {
      const order = ['auto', 'dark', 'light'];
      state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
      localStorage.setItem('theme', state.theme);
      applyTheme(); openSettings();
    };
    el('unpair').onclick = async () => {
      if (!confirm('解除这台手机的绑定？可以随时重新配对。')) return;
      await forget(); location.reload();
    };
    const save = el('save-models');
    if (save) save.onclick = async () => {
      const boxes = [...document.querySelectorAll('[data-model]')];
      const disabled = boxes.filter((box) => !box.checked).map((box) => box.dataset.model);
      const items2 = state.doc.items.map((item) => Object.assign({}, item, { enabled: !disabled.includes(item.id) }));
      try {
        const result = await api(API.models, { method: 'PUT', body: { baseRevision: state.doc.revision, overlayRevision: state.doc.overlayRevision, items: items2, base: state.doc.items } });
        state.doc = result.doc;
        toast('已保存');
      } catch (error) {
        if (error.code === 'E_REVISION' && error.payload) {
          const conflicts = (error.payload.conflicts || []).slice(0, 5).map((c) => `${c.id} 的 ${c.field}`).join('、');
          toast(`电脑端也改过：${conflicts || '配置已更新'}。已刷新，请再确认一次。`, 5200);
          state.doc = error.payload.doc;
          openSettings();
          return;
        }
        toast(String(error.message || error));
      }
    };
    document.querySelectorAll('[data-revoke]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('解除这台设备的绑定？')) return;
        await api(`${API.devices}/${button.dataset.revoke}`, { method: 'DELETE' });
        openSettings();
      };
    });
  }

  // -------------------------------------------------------------------- render
  function renderHeader() {
    const state_ = !state.connected ? '<span class="dot bad"></span>离线' : '<span class="dot live"></span>已连接';
    el('subtitle').innerHTML = state.view === 'sessions' ? `${state_} · ${state.sessions.length} 个会话` : state.view === 'chat' ? `${state_}${state.running ? ' · 正在生成' : ''}` : '';
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : state.theme;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------- boot
  async function boot() {
    applyTheme();
    if (!state.token) { renderPairing(''); return; }
    try {
      const meta = await api(API.meta);
      state.device = meta.device; state.server = meta.server;
    } catch (error) {
      if (/失效|配对/.test(String(error.message))) { renderPairing(String(error.message)); return; }
    }
    connect();
    state.view = 'sessions';
    const hash = location.hash.match(/^#s=(.+)$/);
    await loadSessions();
    if (hash) await openSession(decodeURIComponent(hash[1]));
  }

  el('send').onclick = send;
  el('stop').onclick = async () => {
    if (!state.session) return;
    try { await api(`${API.sessions}/${encodeURIComponent(state.session.sessionId)}/cancel`, { method: 'POST', body: {} }); toast('已请求停止'); } catch (error) { toast(String(error.message || error)); }
  };
  el('input').oninput = () => {
    const node = el('input');
    node.style.height = 'auto';
    node.style.height = `${Math.min(132, node.scrollHeight)}px`;
  };
  el('input').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  el('back').onclick = () => { state.view = 'sessions'; state.session = null; location.hash = ''; void loadSessions(); };
  el('action').onclick = async () => {
    if (state.view === 'chat' && state.session) {
      const doc = state.doc;
      void doc;
      showSheet(`<h2 style="margin:0 0 10px;font-size:14px">这个会话的动作</h2>
        <button class="ghost" id="sh-regen">重新生成</button>
        <button class="ghost" id="sh-model" style="margin-left:8px">切换模型</button>
        <button class="ghost danger" id="sh-cancel" style="margin-left:8px">停止生成</button>`,
        () => {
          el('sh-cancel').onclick = () => { hideSheet(); el('stop').click(); };
          el('sh-regen').onclick = async () => {
            hideSheet();
            try {
              const result = await api(`${API.sessions}/${encodeURIComponent(state.session.sessionId)}/prompt`, { method: 'POST', body: { text: '继续', mode: 'queue' } });
              void result; state.running = true; renderComposer();
            } catch (error) { toast(String(error.message || error)); }
          };
          el('sh-model').onclick = async () => {
            hideSheet();
            let doc = state.doc;
            if (!doc) { try { doc = (await api(API.models)).doc; state.doc = doc; } catch {} }
            if (!doc || !doc.items.length) { toast('没有读到模型列表'); return; }
            const rows = doc.items.slice(0, 60).map((item) => `<div class="row" data-pick="${escapeHtml(item.provider)}|${escapeHtml(item.modelId)}"><div class="grow"><div class="name">${escapeHtml(item.name || item.modelId)}</div><div class="meta"><span>${escapeHtml(item.provider)}</span>${item.enabled ? '' : '<span class="pill">已停用</span>'}</div></div></div>`).join('');
            showSheet(`<h2 style="margin:0 0 10px;font-size:14px">切换这个会话使用的模型</h2>${rows}`, () => {
              document.querySelectorAll('[data-pick]').forEach((row) => {
                row.onclick = async () => {
                  const [provider, model] = row.dataset.pick.split('|');
                  hideSheet();
                  try {
                    await api(`${API.sessions}/${encodeURIComponent(state.session.sessionId)}/model`, { method: 'POST', body: { selection: { provider, model } } });
                    toast(`已切到 ${model}`);
                  } catch (error) { toast(String(error.message || error)); }
                };
              });
            });
          };
        });
      return;
    }
    openSettings();
  };
  el('sheet').onclick = (event) => { if (event.target.id === 'sheet') hideSheet(); };
  function showSheet(html, wire) { el('sheet-body').innerHTML = html; el('sheet').hidden = false; if (wire) wire(); }
  function hideSheet() { el('sheet').hidden = true; el('sheet-body').innerHTML = ''; }

  window.addEventListener('popstate', () => { state.view = 'sessions'; state.session = null; void loadSessions(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && (!state.ws || state.ws.readyState > 1)) connect(); });

  (async () => {
    state.token = await idb.get('token');
    state.device = await idb.get('device');
    const pairFromHash = location.hash.match(/pair=([A-Za-z0-9-]+)/);
    if (!state.token && pairFromHash) { renderPairing(''); el('pair-code').value = decodeURIComponent(pairFromHash[1]); return; }
    await boot();
  })();
})();

/* ---------- iOS：Safari 不会像安卓那样提示安装，自己弹一条 ---------- */
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (!isIOS || standalone) return;
  var key = 'dsh-ios-a2hs-done';
  try { if (localStorage.getItem(key)) return; } catch (e) {}
  var bar = document.createElement('div');
  bar.id = 'ios-a2hs';
  bar.innerHTML = '<span>装到主屏更好用：点底部 <b>分享</b><span class="a2hs-icon">\u2934</span> \u2192 <b>添加到主屏幕</b></span><button aria-label="知道了">\u2715</button>';
  bar.querySelector('button').onclick = function () {
    try { localStorage.setItem(key, '1'); } catch (e) {}
    bar.remove();
  };
  document.body.appendChild(bar);
})();
