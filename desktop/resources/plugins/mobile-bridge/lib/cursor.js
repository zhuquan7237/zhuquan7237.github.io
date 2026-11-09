/**
 * Error-text parsing for the engine's session cursor.
 *
 * `session.page` refuses a `throughSeq` past the session head, and different
 * engine versions name the head differently:
 *   0.1.x — "past cursor 123"
 *   0.2.x — "session history cut 9007199254740991 exceeds 123"
 * Only the first shape was recognised, so on 0.2.x every history read failed
 * with a raw E_ENGINE until the cursor was known another way.
 */
export function cursorFromError(message) {
    const match = /past cursor (\d+)/.exec(message) ?? /history cut \d+ exceeds (\d+)/.exec(message);
    if (match === null)
        return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}
