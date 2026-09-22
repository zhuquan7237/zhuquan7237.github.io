/**
 * Where a reconnecting phone's stream should resume.
 *
 * The bridge's event `seq` is an in-memory counter: it restarts at zero every
 * time the engine (and this plugin with it) starts. A phone, however, keeps its
 * own watermark on disk and announces it with `hello { since }`. Taking that
 * number on faith deadlocks the connection: `since = 900` against a fresh
 * counter of `12` means "I have already seen everything up to 900", so every
 * new frame (13, 14, …) fails the `seq > since` test inside `publish` and the
 * phone goes deaf while still showing a green "已连接".
 *
 * Reproduced live against the running bridge: one socket claiming
 * `since = 999999` received 0 of a turn's 12 frames (turn/start … turn/end)
 * while an honest `since = 0` socket received all of them — the phone that sent
 * a prompt saw a blank screen until it re-opened the conversation, which reads
 * history over HTTP and never consults this counter.
 *
 * So a watermark is only meaningful inside the counter's own lifetime:
 *
 *   - `since > seq` — the number is from a previous run. Ignore it (replay from
 *     the ring buffer, deliver live frames) and tell the caller `stale` so it
 *     can refresh history: its own view may have missed a whole turn.
 *   - `since` older than the oldest buffered frame — frames in between were
 *     dropped by the buffer cap; same advice, `gap`.
 *
 * @module @dsh-desktop/dsh-mobile-bridge/hello
 */
/**
 * Clamp a client's watermark into this counter's lifetime.
 *
 * @param rawSince - the `since` the client sent, unvalidated.
 * @param seq - the highest seq this bridge has published.
 * @param oldestBuffered - the oldest frame still in the ring buffer, if any.
 * @returns The resume point plus the two flags a client reacts to.
 */
export function normalizeSince(rawSince, seq, oldestBuffered) {
    const asked = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;
    const stale = asked > seq;
    const since = stale ? 0 : asked;
    const gap = stale || (since > 0 && oldestBuffered !== undefined && since + 1 < oldestBuffered);
    return { since, stale, gap };
}
