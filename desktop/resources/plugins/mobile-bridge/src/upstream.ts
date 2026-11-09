/**
 * Outbound model-list fetch for the "pull from upstream" action.
 *
 * Deliberately uses global `fetch` instead of `node:http(s).request`: the engine
 * installs an undici dispatcher from its proxy environment at startup
 * (dsh-http-proxy), and only `fetch` goes through it. With `node:https` every
 * provider that needs a proxy (api.mistral.ai from CN, for example) timed out
 * after 30 s regardless of the per-provider network route.
 */
export interface UpstreamResponse {
  status: number
  body: string
}

export interface UpstreamFailure {
  error: string
}

export async function fetchUpstreamJson(
  url: URL,
  key: string,
  timeoutMs = 30_000,
): Promise<UpstreamResponse | UpstreamFailure> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'dsh-mobile-bridge',
  }
  if (key !== '') headers.authorization = 'Bearer ' + key

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, body: await response.text() }
  } catch (error) {
    const err = error as { name?: string; message?: string }
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return {
      error: timedOut ? `请求上游超时（${Math.round(timeoutMs / 1000)} 秒）` : (err?.message ?? String(error)),
    }
  }
}
