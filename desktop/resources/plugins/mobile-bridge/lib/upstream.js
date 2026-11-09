export async function fetchUpstreamJson(url, key, timeoutMs = 30_000) {
    const headers = {
        accept: 'application/json',
        'user-agent': 'dsh-mobile-bridge',
    };
    if (key !== '')
        headers.authorization = 'Bearer ' + key;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: response.status, body: await response.text() };
    }
    catch (error) {
        const err = error;
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
            error: timedOut ? `请求上游超时（${Math.round(timeoutMs / 1000)} 秒）` : (err?.message ?? String(error)),
        };
    }
}
