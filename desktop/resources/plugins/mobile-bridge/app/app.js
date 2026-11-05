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
    history: [], historyRequestId: 0, historyAppliedId: 0, historyGeneration: 0, live: {}, running: false, doc: null, devices: [],
    ws: null, reconnectTimer: null, seq: 0, epoch: '', connected: false, retry: 0, theme: localStorage.getItem('theme') || 'dark',
    draft: '', failedDrafts: {}, busy: false, sending: false, sendingSessionId: null, sendingSessions: {}, historyRenderDeferred: null, thinking: false, taskStage: '', textChars: 0, reasoningChars: 0, turnVersion: 0, openThink: {},
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
        tx.onabort = () => resolve(false);
      });
    },
    async del(key) {
      const db = await idb.open();
      return new Promise((resolve) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    },
  };

  // --------------------------------------------------------------------- fetch
  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const requestToken = state.token;
    if (requestToken) headers.authorization = `Bearer ${requestToken}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 401) {
      if (requestToken && state.token === requestToken) await forget(true);
      throw new Error('令牌已失效，请重新配对');
    }
    if (!response.ok) {
      // Relay/proxy error pages may contain credentials or other diagnostics.
      throw new Error(`请求失败（HTTP ${response.status}）`);
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('响应格式无效'); }
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
        ${message ? `<p style="color:var(--dsw-alias-state-error-primary)">${escapeHtml(message)}</p>` : ''}
        ${state.recoveryStorageFailed ? Object.entries(state.failedDrafts || {}).filter(([, text]) => text).map(([sid, text]) => `<label class="field">会话 ${escapeHtml(sid)} 的未保存草稿<textarea readonly rows="4">${escapeHtml(text)}</textarea></label>`).join('') : ''}
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

  async function forget(expired = false) {
    // Invalidate synchronously: concurrent 401s must not recover the same
    // pending prompt twice while IndexedDB transactions are still running.
    state.token = null; state.device = null;
    let saved = true;
    if (expired) {
      // Preserve both unsent text and every in-flight submission before hiding
      // the composer. The latter may fail asynchronously after this returns.
      state.drafts ||= {};
      state.failedDrafts ||= {};
      const current = state.view === 'chat' && state.session?.sessionId;
      if (current) state.drafts[current] = el('input').value;
      const recovered = Object.assign({}, state.drafts);
      for (const [sid, text] of Object.entries(state.failedDrafts)) {
        recovered[sid] = [text, recovered[sid]].filter(Boolean).join('\n\n');
      }
      // The invalidated composer may remain visible after its HTTP request
      // has settled and removed the sending lock. Keep its recovery source.
      state.expiredComposers = {};
      for (const [sid, pending] of Object.entries(state.sendingSessions || {})) {
        // Keep the already-failed prefix separate from the editable composer,
        // which can still change while the recovery write is in flight.
        if (!pending.restored) {
          // Record which exact part we added instead of inferring its source
          // later from text that the user may have edited to the same value.
          const remaining = recovered[sid] || '';
          pending.recovery = {
            value: [pending.text, remaining].filter(Boolean).join('\n\n'),
            remaining, failedBefore: state.failedDrafts[sid] || '', edited: false,
          };
          recovered[sid] = pending.recovery.value;
          pending.restored = true;
        }
        state.expiredComposers[sid] = pending;
      }
      state.failedDrafts = recovered; state.drafts = {};
      state.durableDrafts = Object.assign({}, recovered);
      state.durableWrites = (state.durableWrites || Promise.resolve()).catch(() => {}).then(() => idb.set('drafts', Object.assign({}, state.durableDrafts)));
      try { saved = await state.durableWrites; } catch { saved = false; }
    }
    let cleared = true;
    try {
      const tokenCleared = await idb.del('token');
      const deviceCleared = await idb.del('device');
      cleared = tokenCleared && deviceCleared;
    } catch { cleared = false; }
    if (state.reconnectTimer !== null) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    if (state.ws) { const socket = state.ws; state.ws = null; try { socket.close(); } catch {} }
    state.connected = false;
    if (expired) {
      state.recoveryStorageFailed = !saved;
      state.expiredComposers = null;
      state.view = 'pairing'; state.session = null;
      renderPairing(!saved ? '令牌已失效；草稿只能暂存本页，重新加载前请先复制' : !cleared ? '令牌已失效，请重新配对；旧令牌未能从本机存储删除' : '令牌已失效，请重新配对');
    }
  }

  // ------------------------------------------------------------------- events
  function applyEvent(frame) {
    if (frame.kind === 'hello') {
      const epoch = frame.data?.server?.epoch || '';
      const changed = !!(epoch && state.epoch && epoch !== state.epoch);
      if (changed) state.seq = 0;
      if (epoch) state.epoch = epoch;
      // The bridge sends an unsolicited hello immediately on upgrade. Its
      // replay=0 is NOT the response to our client hello or an empty replay.
      const initialHello = state.awaitingInitialHello === true;
      state.awaitingInitialHello = false;
      if (!initialHello) {
        const replayCount = Number(frame.data?.replay) || 0;
        state.replayThrough = replayCount > 0 ? Number(frame.seq) || 0 : null;
        state.replayPending = replayCount > 0 && state.replayThrough > state.seq;
        // Quarantine offline submissions through the replay high-water mark;
        // reconcile them from history rather than attributing old events.
        for (const sid of Object.keys(state.replayFences || {})) {
          if (replayCount === 0) delete state.replayFences[sid];
          else state.replayFences[sid] = Number(frame.seq) || 0;
        }
      }
      // The server's advertised seq is its high-water mark, not proof that
      // the intervening replay frames reached this client. Advance only on
      // actual events, otherwise a mid-replay disconnect can lose them.
      // Reconcile with the desktop after restart or an incomplete replay.
      if (changed || frame.data?.gap) {
        if (state.session) void loadHistory(state.session.sessionId, { keepScroll: true });
        if (state.view === 'sessions') void loadSessions();
      }
      return;
    }
    if (frame.kind !== 'event' && frame.kind !== 'notify') return;
    const frameSeq = Number(frame.seq) || 0;
    state.seq = Math.max(state.seq, frameSeq);
    if (state.replayPending && state.replayThrough !== null && frameSeq >= state.replayThrough) {
      state.replayPending = false; state.replayThrough = null;
    }
    const fence = frame.sessionId && state.replayFences && Object.prototype.hasOwnProperty.call(state.replayFences, frame.sessionId)
      ? state.replayFences[frame.sessionId] : undefined;
    const quarantined = fence !== undefined && (fence === null || frameSeq <= fence);
    for (const [sid, through] of Object.entries(state.replayFences || {})) {
      if (through !== null && frameSeq >= through) {
        delete state.replayFences[sid];
        if (!state.sendingSessions?.[sid] && state.view === 'chat' && state.session?.sessionId === sid) void loadHistory(sid, { keepScroll: true });
      }
    }
    if (quarantined) return;
    if (frame.kind === 'notify') {
      toast(`${frame.title || ''}${frame.body ? ' · ' + frame.body : ''}`);
      if (state.view === 'sessions') void loadSessions();
      return;
    }
    if (frame.kind !== 'event') return;
    if (state.session && frame.sessionId && frame.sessionId !== state.session.sessionId) return;
    const redraw = () => { if (state.view === 'chat') renderTaskStatus(); else renderComposer(); };
    // Progress cannot establish that a turn is active by itself. If initial
    // history is still loading, let it recover running; once active, newer
    // status events must supersede a snapshot or pending prompt result.
    const markProgress = () => { if (state.running) state.turnVersion = (state.turnVersion || 0) + 1; };
    if (frame.type === 'turn/start') {
      state.turnVersion = (state.turnVersion || 0) + 1;
      state.running = true; state.live = {}; state.thinking = false;
      state.taskStage = 'waiting'; state.textChars = 0; state.reasoningChars = 0;
      redraw();
    }
    if (frame.type === 'turn/end') {
      state.turnVersion = (state.turnVersion || 0) + 1;
      state.running = false; state.thinking = false; state.taskStage = '';
      redraw();
      if (state.session) void loadHistory(state.session.sessionId, { keepScroll: true });
    }
    if (frame.type === 'assistant/waiting') {
      markProgress();
      state.taskStage = 'waiting'; state.thinking = false;
      state.textChars = 0; state.reasoningChars = 0;
      redraw();
    }
    if (frame.type === 'assistant/progress') {
      const data = frame.data || {};
      const textChars = Math.max(0, Number(data.textChars) || 0);
      const reasoningChars = Math.max(0, Number(data.reasoningChars) || 0);
      const stage = ['responding', 'reasoning', 'output', 'tool'].includes(data.phase)
        ? data.phase : textChars > 0 ? 'output' : reasoningChars > 0 ? 'reasoning' : '';
      // A zero-count legacy pulse means the request started, not that the model responded.
      if (stage) {
        markProgress();
        state.taskStage = stage; state.textChars = textChars; state.reasoningChars = reasoningChars;
        state.thinking = stage === 'reasoning';
        redraw();
      }
    }
    if (frame.type === 'assistant/chunk') {
      // Older bridges can send content increments. Reflect evidence as status,
      // but show the reply only when the complete message lands in history.
      const text = chunkText(frame.data);
      if (text) {
        markProgress();
        const reasoning = chunkIsReasoning(frame.data);
        state.taskStage = reasoning ? 'reasoning' : 'output';
        state.thinking = reasoning;
        if (reasoning) state.reasoningChars += text.length;
        else state.textChars += text.length;
        redraw();
      }
    }
    if (frame.type === 'tool/call') { markProgress(); state.taskStage = 'tool'; state.thinking = false; redraw(); }
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
    if (state.reconnectTimer !== null) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    // An open or still-connecting socket is already doing the job. Visibility
    // and a scheduled retry can race; neither may close a healthy connection.
    if (state.ws && state.ws.readyState < 2) return;
    const socket = new WebSocket(WS_URL(state.token));
    state.replayPending = true; state.replayThrough = null; state.awaitingInitialHello = true;
    state.ws = socket;
    socket.onopen = () => {
      if (state.ws !== socket) return;
      state.connected = true; state.retry = 0; renderHeader();
      socket.send(JSON.stringify({ type: 'hello', since: state.seq, epoch: state.epoch }));
    };
    socket.onmessage = (event) => { if (state.ws === socket) { try { applyEvent(JSON.parse(event.data)); } catch {} } };
    socket.onclose = () => {
      if (state.ws !== socket) return;
      state.ws = null; state.connected = false; renderHeader();
      if (!state.token) return;
      const delay = Math.min(15000, 800 * Math.pow(1.6, state.retry++));
      state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, delay);
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
    // The input belongs to a session, never to the shared composer element.
    if (typeof el === 'function' && state.view === 'chat' && state.session?.sessionId) {
      state.drafts ||= {};
      state.drafts[state.session.sessionId] = el('input').value;
    }
    state.historyGeneration = (state.historyGeneration || 0) + 1;
    state.session = { sessionId };
    state.view = 'chat';
    state.chatRenderedSession = null;
    state.history = []; state.live = {}; state.running = false; state.thinking = false;
    state.taskStage = ''; state.textChars = 0; state.reasoningChars = 0;
    state.turnVersion = (state.turnVersion || 0) + 1;
    // Enter the chat immediately even when its history must wait for a prompt.
    const submitting = state.sendingSessions?.[sessionId];
    if (submitting) {
      state.running = true; state.taskStage = 'submitting';
      renderChat();
    }
    if (typeof el === 'function') {
      const input = el('input');
      input.value = [state.failedDrafts?.[sessionId], state.drafts?.[sessionId]].filter(Boolean).join('\n\n');
      if (state.failedDrafts?.[sessionId]) {
        if (submitting?.restored) submitting.restoredShown = true;
        delete state.failedDrafts[sessionId];
        toast('已恢复这条会话中未确认的消息，请核对后再发送。', 5200);
      }
    }
    try {
      const listed = state.sessions.find((item) => item.sessionId === sessionId);
      if (listed) state.session = listed;
    } catch {}
    await loadHistory(sessionId);
    if (state.view === 'chat' && state.session?.sessionId === sessionId) {
      window.history.pushState({ sessionId }, '', `#s=${encodeURIComponent(sessionId)}`);
    }
  }

  async function loadHistory(sessionId, options = {}) {
    // Only a newer event for this session supersedes its in-flight snapshot;
    // another session's global sequence must not suppress recovery here.
    const requestedAtTurn = state.turnVersion;
    const requestedGeneration = state.historyGeneration || 0;
    const requestedWhileSending = !!(state.sendingSessions?.[sessionId] || (state.sending && state.sendingSessionId === sessionId));
    const requestId = state.historyRequestId = (state.historyRequestId || 0) + 1;
    try {
      const data = await api(`${API.sessions}/${encodeURIComponent(sessionId)}/history?maxMessages=100`);
      // A later *successful* snapshot supersedes this one, not merely a later
      // request. This prevents slow consecutive requests from starving the UI.
      if (!state.session || state.session.sessionId !== sessionId ||
          (state.historyGeneration || 0) !== requestedGeneration || requestId < (state.historyAppliedId || 0)) return;
      state.historyAppliedId = requestId;
      const items = data.items || data.entries || data.history || [];
      const previousItems = JSON.stringify(state.history);
      const previousOptimistic = JSON.stringify((state.optimisticBySession?.[sessionId] || []).filter((item) => !item.inHistory).map((item) => item.text));
      state.history = items;
      // Keep local optimistic rows until the authoritative history actually
      // contains them. A successful HTTP ACK alone is not that evidence.
      if (state.optimisticBySession?.[sessionId] && typeof extractText === 'function') {
        state.optimisticBySession[sessionId] = state.optimisticBySession[sessionId].filter((pending) => {
          const matches = [];
          items.forEach((item, index) => {
            const event = item?.event || item;
            if (event?.type === 'user/message' && extractText(event.data) === pending.text) matches.push(index);
          });
          const index = matches[pending.previousMatches];
          pending.inHistory = index !== undefined;
          if (index === undefined) return true;
          // A previous turn/end before this message cannot end the new turn.
          // Continue protecting its status until a later boundary is visible.
          return !items.slice(index + 1).some((item) => {
            const type = (item?.event || item)?.type;
            return type === 'turn/start' || type === 'turn/end';
          });
        });
      }
      const awaitingPromptHistory = !!state.optimisticBySession?.[sessionId]?.length;
      if (!requestedWhileSending && !awaitingPromptHistory && state.turnVersion === requestedAtTurn) {
        for (let i = items.length - 1; i >= 0; i--) {
          const type = (items[i] && (items[i].event || items[i]).type) || '';
          if (type === 'turn/start' || type === 'turn/end') {
            state.running = type === 'turn/start';
            break;
          }
        }
        if (!state.running) state.taskStage = '';
        else if (!state.taskStage) state.taskStage = 'waiting';
      }
      if (state.view === 'chat') {
        if (state.sendingSessions?.[sessionId] || (state.sending && state.sendingSessionId === sessionId)) {
          state.historyDeferred ||= {};
          state.historyDeferred[sessionId] = true;
        }
        else if (state.chatRenderedSession === sessionId && previousItems === JSON.stringify(items) && previousOptimistic === JSON.stringify((state.optimisticBySession?.[sessionId] || []).filter((item) => !item.inHistory).map((item) => item.text))) renderTaskStatus();
        else renderChat(options.keepScroll);
      }
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

  function taskStatusHtml() {
    const stages = {
      submitting: '正在提交…', waiting: '等待模型响应…', responding: '模型已开始响应…',
      reasoning: '模型正在思考…', output: '模型正在输出…', tool: '模型正在调用工具…',
    };
    const rawCount = state.taskStage === 'reasoning' ? state.reasoningChars : state.taskStage === 'output' ? state.textChars : 0;
    const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 0;
    return `<div class="msg think running" id="mobile-pending-state" role="status" aria-live="polite"><span class="who">电脑端</span><div class="bubble"><span class="dot"></span><span>${stages[state.taskStage] || stages.waiting}${count ? ` · ${count} 字` : ''}</span></div></div>`;
  }

  // Status pulses update only their own node: replacing the whole transcript
  // each second destroys text selection and can make the conversation flash.
  function renderTaskStatus() {
    const view = el('view');
    const current = view.querySelector('.msg.think.running');
    if (!state.running) {
      if (current) current.remove();
    } else if (current) {
      current.outerHTML = taskStatusHtml();
    } else {
      const anchor = view.querySelector('#anchor');
      if (anchor) anchor.insertAdjacentHTML('beforebegin', taskStatusHtml());
      else view.insertAdjacentHTML('beforeend', taskStatusHtml());
    }
    renderHeader();
    renderComposer();
  }

  function renderChat(keepScroll) {
    state.chatRenderedSession = state.session?.sessionId || null;
    el('composer').hidden = false;
    el('back').hidden = false;
    el('action').hidden = false;
    el('title').textContent = state.session ? sessionTitle(state.session) : '会话';
    renderHeader();
    const chips = {};
    const rows = messageRows();
    for (const pending of state.optimisticBySession?.[state.session?.sessionId] || []) if (!pending.inHistory) rows.push({ who: 'user', text: pending.text });
    const bubbles = rows.map((row) => {
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
    const running = state.running ? taskStatusHtml() : '';
    el('view').innerHTML = bubbles + running + '<div style="height:16px"></div><div id="anchor"></div>';
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
    const sessionId = state.session?.sessionId;
    el('stop').disabled = !!(state.sendingSessions?.[sessionId] || (state.sending && !state.sendingSessions && (!state.sendingSessionId || state.sendingSessionId === sessionId)));
  }

  async function send() {
    const text = el('input').value.trim();
    if (!text || !state.session) return;
    const sessionId = state.session.sessionId;
    if (state.sendingSessions?.[sessionId] || (state.sending && !state.sendingSessions && (!state.sendingSessionId || state.sendingSessionId === sessionId))) return;
    if (state.connected === false || state.replayPending) {
      state.replayFences ||= {};
      state.replayFences[sessionId] = state.replayPending && typeof state.replayThrough === 'number' ? state.replayThrough : null;
    }
    // Invalidate history snapshots begun before this submission, including
    // queued sends. Newer task events must still supersede the HTTP result.
    const turnVersion = state.turnVersion = (state.turnVersion || 0) + 1;
    const wasRunning = state.running;
    let acknowledged = false;
    state.optimisticBySession ||= {};
    const optimistic = state.optimisticBySession[sessionId] ||= [];
    const previousMatches = typeof extractText === 'function' ? (state.history || []).filter((item) => {
      const event = item?.event || item;
      return event?.type === 'user/message' && extractText(event.data) === text;
    }).length : 0;
    const optimisticRow = { text, previousMatches: previousMatches + optimistic.filter((item) => item.text === text && !item.inHistory).length };
    optimistic.push(optimisticRow);
    state.sendingSessions ||= {};
    state.sendingSessions[sessionId] = { text };
    state.sending = true; state.sendingSessionId = sessionId;
    el('input').value = ''; state.draft = '';
    if (state.drafts) state.drafts[sessionId] = '';
    el('view').insertAdjacentHTML('beforeend', `<div class="msg user"><span class="who">我</span><div class="bubble">${escapeHtml(text)}</div></div>`);
    if (!wasRunning) {
      el('view').insertAdjacentHTML('beforeend', '<div class="msg think running" id="mobile-pending-state" role="status" aria-live="polite"><span class="who">电脑端</span><div class="bubble"><span class="dot"></span><span>正在提交…</span></div></div>');
      state.running = true; state.taskStage = 'submitting'; state.thinking = false;
    }
    el('view').scrollTop = el('view').scrollHeight;
    renderComposer();
    try {
      const result = await api(`${API.sessions}/${encodeURIComponent(sessionId)}/prompt`, { method: 'POST', body: { text, mode: 'queue' } });
      if (!result || result.ok !== true) throw new Error('电脑端未确认接收消息');
      acknowledged = true;
      const recoveredSubmission = state.sendingSessions[sessionId];
      // Remove only the exact, never-edited recovery value we constructed.
      // A matching textual prefix (or even an identical edited value) says
      // nothing about which characters belong to the user's unsent draft.
      const recovery = recoveredSubmission?.recovery;
      if (recovery) recovery.confirmed = true;
      const withoutConfirmed = (draft) => recovery && !recovery.edited && draft === recovery.value
        ? recovery.remaining : draft;
      if (recovery?.edited) toast('消息已确认；已保留编辑后的恢复草稿，请核对以免重复发送。', 5200);
      if (recoveredSubmission?.restored) {
        if (state.failedDrafts?.[sessionId]) {
          const remaining = withoutConfirmed(state.failedDrafts[sessionId]);
          if (remaining) state.failedDrafts[sessionId] = remaining;
          else delete state.failedDrafts[sessionId];
        }
        // Once recovery was shown in the composer, it may have been edited or
        // moved to a different session. Only strip an intact submitted prefix.
        if (recoveredSubmission.restoredShown) {
          if (state.drafts && Object.prototype.hasOwnProperty.call(state.drafts, sessionId)) state.drafts[sessionId] = withoutConfirmed(state.drafts[sessionId]);
          if (state.view === 'chat' && state.session?.sessionId === sessionId) el('input').value = withoutConfirmed(el('input').value);
        }
      }
      if (state.durableDrafts && Object.prototype.hasOwnProperty.call(state.durableDrafts, sessionId)) {
        // forget(true) moved unsent text out of state.drafts. A recovered
        // submission must be removed from the durable value, not replace the
        // entire value with the now-empty in-memory drafts map.
        const unsent = recoveredSubmission?.restored
          ? withoutConfirmed(state.durableDrafts[sessionId]) : state.drafts?.[sessionId] || '';
        if (unsent) state.durableDrafts[sessionId] = unsent;
        else delete state.durableDrafts[sessionId];
        // Serialize writes so concurrent acknowledgements cannot resurrect a
        // recovered draft from an older IndexedDB snapshot.
        state.durableWrites = (state.durableWrites || Promise.resolve()).catch(() => {}).then(() => idb.set('drafts', Object.assign({}, state.durableDrafts)));
        try {
          if (!await state.durableWrites) toast('消息已确认，但本机草稿记录未能更新，请勿重复发送。', 5200);
        } catch {
          toast('消息已确认，但本机草稿记录未能更新，请勿重复发送。', 5200);
        }
      }
      // Start/end events can both arrive before the HTTP acknowledgement. Do
      // not resurrect a finished turn, or affect a session opened in between.
      if (state.session?.sessionId === sessionId && ((!wasRunning && state.turnVersion === turnVersion) || state.taskStage === 'submitting')) {
        state.running = true; state.taskStage = 'waiting';
        const label = el('view').querySelector?.('#mobile-pending-state .bubble span:last-child');
        if (label) label.textContent = '等待模型响应…';
      }
    } catch (error) {
      state.optimisticBySession[sessionId] = optimistic.filter((item) => item !== optimisticRow);
      toast(`发送未确认：${String(error.message || error)}。请先核对电脑端，草稿已保留。`, 5200);
      if (state.sendingSessions[sessionId]?.restored) {
        // forget(true) already saved this submission, including to IndexedDB.
      } else if (state.session?.sessionId === sessionId) {
        // A different turn may have begun while this request was in flight;
        // preserve the text without overriding that newer turn's status.
        if (!wasRunning && state.turnVersion === turnVersion) { state.running = false; state.taskStage = ''; }
        const input = el('input');
        input.value = [text, input.value].filter(Boolean).join('\n\n');
        renderChat(true);
      } else {
        state.failedDrafts ||= {};
        state.failedDrafts[sessionId] = [text, state.failedDrafts[sessionId]].filter(Boolean).join('\n\n');
      }
    } finally {
      delete state.sendingSessions[sessionId];
      const pendingIds = Object.keys(state.sendingSessions);
      state.sending = pendingIds.length > 0; state.sendingSessionId = pendingIds.at(-1) || null;
      const deferred = !!state.historyDeferred?.[sessionId];
      if (deferred) delete state.historyDeferred[sessionId];
      if (acknowledged && state.view === 'chat' && state.session?.sessionId === sessionId) {
        // A pre-ACK request can finish even after the ACK. Invalidate all of
        // them and always request a causally later snapshot.
        state.historyGeneration = (state.historyGeneration || 0) + 1;
        if (deferred) {
          // Do not hide an already fetched answer if the refresh fails. Keep
          // the optimistic user bubble if this snapshot predates the prompt.
          renderChat(true);
        }
        void loadHistory(sessionId, { keepScroll: true });
      }
      if (state.view === 'chat') renderComposer();
    }
  }

  async function cancelTurn() {
    if (!state.session) return;
    // Cancellation cannot preempt a prompt that hasn't reached the engine.
    const sessionId = state.session.sessionId;
    if (state.sendingSessions?.[sessionId] || (state.sending && !state.sendingSessions && (!state.sendingSessionId || state.sendingSessionId === sessionId))) { toast('消息正在提交，请稍后再停止。'); return; }
    try { await api(`${API.sessions}/${encodeURIComponent(state.session.sessionId)}/cancel`, { method: 'POST', body: {} }); toast('已请求停止'); }
    catch (error) { toast(String(error.message || error)); }
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
      ${provider.map((row) => `<div class="card"><h2>${escapeHtml(row.name || row.id)}${row.readonly ? ' <span class="meta">· 只读</span>' : ''}</h2><p>${row.readonly ? '由电脑端的引擎自己管理（官方登录 / 官方 API key），手机可直接选用，改动请到电脑端做。' : `${escapeHtml(row.baseURL || '')} · ${escapeHtml(row.apiMode || '')} · ${row.apiKeyConfigured ? 'Key 已配置' : 'Key 未配置'}`}</p></div>`).join('')}
      ${items.length ? `<div class="card"><h2>逐模型开关</h2><p>启用状态与标签是手机端的标记，保存在电脑端桥接里；引擎本身没有「停用某个模型」这个字段。只读模型由电脑端管理。</p>${items.map((item) => item.readonly ? `<div class="field" style="display:flex;align-items:center;gap:10px"><span class="meta">只读</span><span>${escapeHtml(item.name || item.modelId)}<br><span class="meta">${escapeHtml(item.provider)} · 图片 ${(item.params && item.params.input || []).includes('image') ? '是' : '否'} · 上下文 ${(item.params && item.params.contextWindow) || '—'}</span></span></div>` : `<label class="field" style="display:flex;align-items:center;gap:10px"><input type="checkbox" data-model="${escapeHtml(item.id)}" ${item.enabled ? 'checked' : ''}/><span>${escapeHtml(item.name || item.modelId)}<br><span class="meta">${escapeHtml(item.provider)} · 图片 ${(item.params && item.params.input || []).includes('image') ? '是' : '否'} · 上下文 ${(item.params && item.params.contextWindow) || '—'}</span></span></label>`).join('')}<button class="primary" id="save-models">保存模型开关</button></div>` : ''}
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
      const items2 = state.doc.items.filter((item) => !item.readonly).map((item) => Object.assign({}, item, { enabled: !disabled.includes(item.id) }));
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
  el('stop').onclick = () => { void cancelTurn(); };
  el('input').oninput = () => {
    const node = el('input');
    if (state.view === 'chat' && state.session?.sessionId) {
      state.drafts ||= {};
      const sessionId = state.session.sessionId;
      state.drafts[sessionId] = node.value;
      const pending = state.expiredComposers?.[sessionId] || state.sendingSessions?.[sessionId];
      // Any user input after the combined recovery was shown invalidates its
      // provenance, even if the resulting text still equals the old snapshot.
      if (pending?.restoredShown && pending.recovery) pending.recovery.edited = true;
      if (state.durableDrafts && (Object.prototype.hasOwnProperty.call(state.durableDrafts, sessionId) || (pending?.restored && !state.token))) {
        if (pending?.restored && !state.token) {
          // During the first recovery write the visible input is still the
          // separate unsent part; update that known source, not by prefix test.
          if (!pending.restoredShown && pending.recovery) {
            pending.recovery.remaining = [pending.recovery.failedBefore, node.value].filter(Boolean).join('\n\n');
            pending.recovery.value = [pending.text, pending.recovery.remaining].filter(Boolean).join('\n\n');
            state.failedDrafts[sessionId] = pending.recovery.confirmed ? pending.recovery.remaining : pending.recovery.value;
          } else {
            state.failedDrafts[sessionId] = node.value;
          }
          delete state.drafts[sessionId];
          state.durableDrafts[sessionId] = state.failedDrafts[sessionId];
        } else {
          state.durableDrafts[sessionId] = node.value;
        }
        state.durableWrites = (state.durableWrites || Promise.resolve()).catch(() => {}).then(() => idb.set('drafts', Object.assign({}, state.durableDrafts)));
        void state.durableWrites.then((saved) => { if (!saved) toast('本机草稿保存失败，请勿重新加载。', 5200); }, () => toast('本机草稿保存失败，请勿重新加载。', 5200));
      }
    }
    node.style.height = 'auto';
    node.style.height = `${Math.min(132, node.scrollHeight)}px`;
  };
  el('input').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  el('back').onclick = () => { if (state.session) { state.drafts ||= {}; state.drafts[state.session.sessionId] = el('input').value; } state.view = 'sessions'; state.session = null; location.hash = ''; void loadSessions(); };
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

  window.addEventListener('popstate', () => { if (state.session && state.view === 'chat') { state.drafts ||= {}; state.drafts[state.session.sessionId] = el('input').value; } state.view = 'sessions'; state.session = null; void loadSessions(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && (!state.ws || state.ws.readyState > 1)) connect(); });

  (async () => {
    state.token = await idb.get('token');
    state.device = await idb.get('device');
    state.failedDrafts = await idb.get('drafts') || {};
    state.durableDrafts = Object.assign({}, state.failedDrafts);
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
