/**
 * The search engines this client can route to, and what each one actually speaks.
 *
 * The harness's own seam takes one provider and no priority chain: pin one id, and
 * anything else usable in the same profile makes it refuse with
 * `WEB_PROVIDER_AMBIGUOUS`. So this package registers a single provider that owns
 * the user's engine list and tries them in order — and each engine below is the
 * real protocol that endpoint speaks, because the differences are exactly what
 * made hand-configuring search fail:
 *
 *   - the official DeepSeek engine posts `${base}/messages` (Anthropic Messages
 *     with a server-side search tool), so an endpoint like `google.serper.dev`
 *     passes a URL check and then answers HTTP 411 on every search;
 *   - a self-hosted pool exposes `GET /search?q=&limit=` and returns nothing for
 *     the POST shape Tavily's own API uses;
 *   - SearXNG answers `GET /search?format=json` only when the instance enabled
 *     the json format, otherwise it is reachable and returns zero results.
 *
 * Everything here is pure: request building, response mapping and error wording
 * are decided from configuration alone, so they are testable without a network.
 */
/** Every engine, in the order the page shows them. */
export const ENGINE_PRESETS = [
    {
        kind: 'pool',
        label: '本机搜索池',
        hint: '本机跑的搜索服务，池子替你轮换上游密钥，不需要自己填 Key。',
        defaults: { enabled: true, baseURL: 'http://127.0.0.1:9876', maxResults: 8 },
        needsKey: false,
        urlHint: '本机地址，例如 http://127.0.0.1:9876',
        keyRef: '',
    },
    {
        kind: 'searxng',
        label: 'SearXNG（自建）',
        hint: '自己搭的元搜索引擎：不花钱、不看别人脸色，但结果质量取决于你启用了哪些上游。',
        defaults: { enabled: false, baseURL: 'http://127.0.0.1:18880', maxResults: 8, language: 'zh-CN', safesearch: 1 },
        needsKey: false,
        urlHint: 'SearXNG 实例根地址，例如 http://127.0.0.1:18880',
    },
    {
        kind: 'tavily',
        label: 'Tavily 官方',
        hint: '专给 AI 用的搜索 API，返回正文摘录，通常最省事。',
        defaults: { enabled: false, baseURL: 'https://api.tavily.com', maxResults: 8, searchDepth: 'basic', apiKeyEnv: 'TAVILY_API_KEY' },
        needsKey: true,
        urlHint: '接口根地址，默认 https://api.tavily.com（会自动拼 /search）',
        keyRef: 'TAVILY_API_KEY',
    },
    {
        kind: 'serper',
        label: 'Serper（谷歌结果）',
        hint: '拿谷歌的结果，按次计费；中文/英文都稳。',
        defaults: { enabled: false, baseURL: 'https://google.serper.dev', maxResults: 8, gl: 'cn', hl: 'zh-cn', apiKeyEnv: 'SERPER_API_KEY' },
        needsKey: true,
        urlHint: 'Serper 接口地址，默认 https://google.serper.dev（会自动拼 /search）',
        keyRef: 'SERPER_API_KEY',
    },
    {
        kind: 'deepseek',
        label: '官方 DeepSeek 搜索',
        hint: '由 DeepSeek 服务端执行搜索。一次搜索等于跑一个完整模型回合，慢且按 token 计费。',
        defaults: { enabled: false, baseURL: 'https://api.deepseek.com/anthropic/v1', maxResults: 8, maxUses: 5, apiKeyEnv: 'DEEPSEEK_API_KEY' },
        needsKey: true,
        urlHint: '必须是 Anthropic 兼容的 Messages 接口基址，默认 https://api.deepseek.com/anthropic/v1（会自动拼 /messages）',
        anthropicBase: true,
        keyRef: 'DEEPSEEK_API_KEY',
    },
    {
        kind: 'custom',
        label: '自定义 JSON 接口',
        hint: '任何返回 JSON 的搜索接口：填地址、鉴权头，再告诉我在返回里结果数组和字段在哪。',
        defaults: {
            enabled: false,
            method: 'GET',
            urlTemplate: 'https://example.com/search?q={query}&limit={maxResults}',
            resultsPath: 'results',
            urlPath: 'url',
            titlePath: 'title',
            snippetPath: 'content',
            maxResults: 8,
        },
        needsKey: false,
        urlHint: '完整地址，用 {query} 代表关键词、{maxResults} 代表条数；POST 时关键词放在 JSON 体里，字段名同样写 {query}',
    },
];
/** @param kind - engine id. @returns its preset, or undefined for an unknown id. */
export function presetFor(kind) {
    return ENGINE_PRESETS.find((preset) => preset.kind === kind);
}
const MAX_RESULTS_FLOOR = 1;
const MAX_RESULTS_CEILING = 20;
/** Clamp a requested count into something every engine accepts. */
export function clampResults(value, fallback = 8) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(MAX_RESULTS_CEILING, Math.max(MAX_RESULTS_FLOOR, n));
}
/**
 * Whether a request to this URL should go through the configured proxy.
 *
 * A self-hosted engine lives on loopback or the LAN, and sending it through a
 * proxy makes it unreachable — the pool at 127.0.0.1:9876 fails as "connection
 * refused" purely because the proxy was handed a loopback address.
 *
 * @param url - the request URL.
 * @param proxy - the configured proxy, if any.
 * @returns the proxy to use, or undefined to go direct.
 */
export function proxyFor(url, proxy) {
    const configured = String(proxy ?? '').trim();
    if (configured === '')
        return undefined;
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase();
    }
    catch {
        return configured;
    }
    const bare = host.replace(/^\[|\]$/g, '');
    const isLocal = bare === 'localhost' ||
        bare === '::1' ||
        bare === '0.0.0.0' ||
        bare.endsWith('.local') ||
        /^127\./.test(bare) ||
        /^10\./.test(bare) ||
        /^192\.168\./.test(bare) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(bare);
    return isLocal ? undefined : configured;
}
/** Trim a base URL and drop trailing slashes so `${base}/path` never doubles up. */
export function baseOf(config, fallback) {
    const raw = (config?.baseURL ?? '').trim() || fallback;
    return raw.replace(/\/+$/, '');
}
/** Parse `Name: value` header lines into a record, ignoring blanks and comments. */
export function parseHeaders(lines) {
    const out = {};
    for (const line of String(lines ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const at = trimmed.indexOf(':');
        if (at <= 0)
            continue;
        out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
    }
    return out;
}
/** Read a dot path (`data.items`) out of a parsed JSON body. */
export function readPath(root, path) {
    const parts = String(path ?? '').split('.').filter((part) => part !== '');
    let cursor = root;
    for (const part of parts) {
        if (cursor === null || typeof cursor !== 'object')
            return undefined;
        cursor = cursor[part];
    }
    return cursor;
}
const text = (value) => {
    if (typeof value === 'string' && value.trim() !== '')
        return value.trim();
    if (typeof value === 'number')
        return String(value);
    return undefined;
};
/**
 * Build the request one engine issues for one query.
 *
 * @param kind - engine id.
 * @param config - its saved configuration.
 * @param query - the user's query, percent-encoded where the protocol needs it.
 * @param maxResults - caller's bound.
 * @returns the request, plus whether a credential is required.
 */
export function buildRequest(kind, config, query, maxResults) {
    const preset = presetFor(kind);
    const count = clampResults(maxResults ?? config?.maxResults, 8);
    const base = baseOf(config, String(preset?.defaults.baseURL ?? ''));
    const keyEnv = (config?.apiKeyEnv ?? preset?.keyRef ?? '').trim();
    switch (kind) {
        case 'pool':
            // GET with q/limit: the pool answers nothing for Tavily's POST shape.
            return {
                url: `${base}/search?q=${encodeURIComponent(query)}&limit=${count}`,
                init: { method: 'GET', headers: { accept: 'application/json' } },
                needsKey: false,
            };
        case 'searxng': {
            const params = new URLSearchParams({ q: query, format: 'json', pageno: '1' });
            if (config?.language)
                params.set('language', String(config.language));
            if (config?.safesearch !== undefined)
                params.set('safesearch', String(config.safesearch));
            return {
                url: `${base}/search?${params.toString()}`,
                init: { method: 'GET', headers: { accept: 'application/json' } },
                needsKey: false,
            };
        }
        case 'tavily':
            return {
                url: `${base}/search`,
                init: {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({
                        query,
                        max_results: count,
                        search_depth: config?.searchDepth ?? 'basic',
                        include_answer: true,
                    }),
                },
                needsKey: true,
                keyRef: keyEnv || 'TAVILY_API_KEY',
            };
        case 'serper':
            return {
                url: `${base}/search`,
                init: {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({ q: query, num: count, gl: config?.gl ?? 'cn', hl: config?.hl ?? 'zh-cn' }),
                },
                needsKey: true,
                keyRef: keyEnv || 'SERPER_API_KEY',
            };
        case 'deepseek':
            // `${base}/messages`, Anthropic shape, server-side search tool.
            return {
                url: `${base}/messages`,
                init: {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        accept: 'application/json',
                        'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                        model: 'deepseek-v4-flash',
                        max_tokens: 4096,
                        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
                        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config?.maxUses ?? 5 }],
                    }),
                },
                needsKey: true,
                keyRef: keyEnv || 'DEEPSEEK_API_KEY',
            };
        case 'custom':
        default: {
            const template = String(config?.urlTemplate ?? '').trim();
            const method = config?.method === 'POST' ? 'POST' : 'GET';
            const headers = { accept: 'application/json', ...parseHeaders(config?.headerLines) };
            const substituted = template
                .replace(/\{query\}/g, encodeURIComponent(query))
                .replace(/\{maxResults\}/g, String(count));
            if (method === 'POST') {
                headers['content-type'] = headers['content-type'] ?? 'application/json';
                return {
                    url: substituted,
                    init: { method, headers, body: JSON.stringify({ query, maxResults: count }) },
                    needsKey: false,
                };
            }
            return { url: substituted, init: { method, headers }, needsKey: false };
        }
    }
}
/** Map one engine's parsed body onto the seam's source shape. */
export function mapResponse(kind, config, raw) {
    const sources = [];
    let content;
    if (kind === 'pool' || kind === 'tavily') {
        const rows = readPath(raw, 'results');
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const url = text(readPath(row, 'url'));
                if (!url)
                    continue;
                sources.push({
                    url,
                    title: text(readPath(row, 'title')),
                    snippet: text(readPath(row, 'content')) ?? text(readPath(row, 'raw_content')),
                });
            }
        }
        content = text(readPath(raw, 'answer'));
    }
    else if (kind === 'searxng') {
        const rows = readPath(raw, 'results');
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const url = text(readPath(row, 'url'));
                if (!url)
                    continue;
                sources.push({ url, title: text(readPath(row, 'title')), snippet: text(readPath(row, 'content')) });
            }
        }
        const answers = readPath(raw, 'answers');
        if (Array.isArray(answers) && answers.length > 0)
            content = text(answers[0]);
    }
    else if (kind === 'serper') {
        const rows = readPath(raw, 'organic');
        if (Array.isArray(rows)) {
            for (const row of rows) {
                const url = text(readPath(row, 'link'));
                if (!url)
                    continue;
                sources.push({ url, title: text(readPath(row, 'title')), snippet: text(readPath(row, 'snippet')) });
            }
        }
        content = text(readPath(raw, 'answerBox.answer')) ?? text(readPath(raw, 'answerBox.snippet'));
    }
    else if (kind === 'deepseek') {
        // Same shape the official provider reads: server-side search result blocks,
        // never text scraped out of the reply.
        const blocks = readPath(raw, 'content');
        if (!Array.isArray(blocks))
            throw new Error('返回里没有 content 数组');
        const seen = new Set();
        for (const block of blocks) {
            if (block?.type !== 'web_search_tool_result')
                continue;
            const items = block.content;
            if (!Array.isArray(items))
                continue;
            for (const item of items) {
                if (item?.type !== 'web_search_result')
                    continue;
                const url = text(item.url);
                if (!url || seen.has(url))
                    continue;
                seen.add(url);
                sources.push({
                    url,
                    title: text(item.title),
                    ...(text(item.page_age) ? { publishedAt: text(item.page_age) } : {}),
                });
            }
        }
        if (sources.length === 0)
            throw new Error('返回里没有 web_search_tool_result（这次请求没有触发服务端搜索）');
    }
    else {
        const rows = readPath(raw, config?.resultsPath ?? 'results');
        if (!Array.isArray(rows))
            throw new Error(`在 ${config?.resultsPath ?? 'results'} 处没找到数组`);
        for (const row of rows) {
            const url = text(readPath(row, config?.urlPath ?? 'url'));
            if (!url)
                continue;
            sources.push({
                url,
                title: text(readPath(row, config?.titlePath ?? 'title')),
                snippet: text(readPath(row, config?.snippetPath ?? 'content')),
            });
        }
    }
    return { sources, content, endpoint: '' };
}
/** Whether a preset's address is being used for an engine whose protocol cannot match. */
export function looksLikeWrongProtocol(kind, config) {
    const base = baseOf(config, '').toLowerCase();
    if (base === '')
        return undefined;
    if (kind === 'deepseek') {
        if (/serper|tavily|brave|searx|bing|duckduckgo|search\?/.test(base)) {
            return `这个地址看起来不是 Anthropic 兼容的 Messages 接口（它像是别的搜索引擎的地址）。官方搜索会请求 ${base}/messages，协议对不上，每次搜索都会失败 —— 请改用上面那张对应的引擎卡。`;
        }
        if (/\/messages\/?$/.test(base))
            return '地址不应该包含 /messages，只填到 /v1 这一层就行。';
        return undefined;
    }
    if (kind === 'pool' || kind === 'searxng') {
        if (/^https:\/\/(api\.)?(tavily|serper|google)\./.test(base)) {
            return '这是云端搜索 API 的地址，本机池/SearXNG 应该填你自己实例的地址（例如 http://127.0.0.1:…）。';
        }
    }
    return undefined;
}
/**
 * Wording for a failed attempt: what happened, and the one next thing to do.
 *
 * HTTP 411 and 405 both mean "this is not that engine's endpoint" and are worded
 * that way, because a URL that merely parses is how the official engine was
 * pointed at a search API and failed on every query.
 */
export function explainFailure(kind, status, detail) {
    const preset = presetFor(kind);
    const name = preset?.label ?? kind;
    const tail = detail && detail.trim() !== '' ? `（服务端说明：${detail.trim().slice(0, 160)}）` : '';
    if (status === undefined) {
        const lowered = String(detail ?? '').toLowerCase();
        if (/abort|timeout|timed out/.test(lowered))
            return `${name} 请求超时 —— 检查网络/代理，以及该实例是否在运行。`;
        if (/econnrefused|fetch failed|connect/.test(lowered))
            return `${name} 连不上 —— 实例没启动、端口不对，或需要代理。`;
        return `${name} 请求失败：${detail ?? '未知错误'}`;
    }
    if (status === 401 || status === 403)
        return `${name} 拒绝了这个 Key（HTTP ${status}）—— 去拿一个有效 Key 填进这张卡，或改用不需要 Key 的引擎。${tail}`;
    if (status === 402)
        return `${name} 提示余额/配额不足（HTTP 402）—— 充值、换 Key，或换引擎。${tail}`;
    if (status === 429)
        return `${name} 触发限流（HTTP 429）—— 等一会儿、降低频率，或在优先级里把它排到后面。${tail}`;
    if (status === 404 || status === 405 || status === 411 || status === 501) {
        return `${name} 这个地址不是它的接口（HTTP ${status}）—— 地址填错了。${preset?.urlHint ? `正确形态：${preset.urlHint}` : ''}${tail}`;
    }
    if (status >= 500)
        return `${name} 服务端出错（HTTP ${status}）—— 稍后重试或换引擎。${tail}`;
    return `${name} 返回 HTTP ${status}。${tail}`;
}
/**
 * Engines to try, in order, for one search.
 *
 * @param order - the user's preference list.
 * @param engines - saved configurations by kind.
 * @returns enabled kinds, preference order first, then any other enabled engine.
 */
export function attemptOrder(order, engines) {
    const enabled = Object.keys(engines).filter((kind) => engines[kind]?.enabled === true);
    const preferred = (order ?? []).filter((kind) => enabled.includes(kind));
    const rest = enabled.filter((kind) => !preferred.includes(kind));
    return [...preferred, ...rest];
}
/** Compose the error shown when every enabled engine failed. */
export function summarizeFailures(failures) {
    const lines = failures.map((failure) => `· ${presetFor(failure.kind)?.label ?? failure.kind}：${failure.message}`);
    return `所有已启用的搜索引擎都没能返回结果：\n${lines.join('\n')}`;
}
