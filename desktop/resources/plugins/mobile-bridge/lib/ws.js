/**
 * A dependency-free WebSocket server side: enough RFC 6455 to push event frames
 * to a phone and read the occasional subscribe/close from it.
 *
 * Why hand-written: the engine's `ws`-shaped dependency is not ours to import
 * (out-of-tree plugins may not pull host runtime values), and the bridge only
 * needs text frames in one direction plus close/ping handling. Binary frames are
 * refused rather than half-supported.
 *
 * @module @dsh-desktop/dsh-mobile-bridge/ws
 */
import { createHash } from 'node:crypto';
/** The handshake GUID every WebSocket server appends to the client key. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Encode one server-to-client text frame (never masked). */
export function encodeTextFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    if (length < 126) {
        return Buffer.concat([Buffer.from([0x81, length]), payload]);
    }
    if (length < 65536) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
        return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return Buffer.concat([header, payload]);
}
/** Encode a close frame. */
export function encodeCloseFrame(code = 1000) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}
/** Encode a pong frame echoing the client's payload. */
export function encodePongFrame(payload) {
    if (payload.length > 125)
        return Buffer.from([0x8a, 0]);
    return Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
}
/**
 * Decode as many complete client frames as the buffer holds.
 *
 * @param state - leftover bytes carried between socket reads.
 * @param chunk - newly arrived bytes.
 * @returns complete frames plus the unconsumed tail.
 */
export function decodeFrames(state, chunk) {
    const buffer = Buffer.concat([state, chunk]);
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let cursor = offset + 2;
        if (length === 126) {
            if (cursor + 2 > buffer.length)
                break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        }
        else if (length === 127) {
            if (cursor + 8 > buffer.length)
                break;
            const big = buffer.readBigUInt64BE(cursor);
            if (big > 4n * 1024n * 1024n) {
                // A frame this large is not part of this protocol; drop the connection.
                return { frames: [], rest: Buffer.alloc(0) };
            }
            length = Number(big);
            cursor += 8;
        }
        const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
        if (masked)
            cursor += 4;
        if (cursor + length > buffer.length)
            break;
        const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
        if (maskKey !== undefined) {
            for (let i = 0; i < payload.length; i += 1) {
                payload[i] = payload[i] ^ maskKey[i % 4];
            }
        }
        frames.push({ opcode, payload });
        offset = cursor + length;
    }
    return { frames, rest: buffer.subarray(offset) };
}
/**
 * Complete the handshake and wire one socket to the handlers.
 *
 * @param req - the upgrade request.
 * @param socket - the raw socket from the HTTP upgrade.
 * @param head - bytes already read past the headers.
 * @param handlers - message and close callbacks.
 * @returns the connection, or undefined when the handshake was invalid.
 */
export function acceptUpgrade(req, socket, head, handlers) {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || key === '' || version !== '13') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return undefined;
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
    ].join('\r\n'));
    if (head.length > 0)
        socket.unshift(head);
    let open = true;
    let received = 0;
    let leftover = Buffer.alloc(0);
    const connection = {
        get open() {
            return open;
        },
        get received() {
            return received;
        },
        send(text) {
            if (!open)
                return false;
            try {
                socket.write(encodeTextFrame(text));
                return true;
            }
            catch {
                return false;
            }
        },
        close(code = 1000) {
            if (!open)
                return;
            open = false;
            try {
                socket.write(encodeCloseFrame(code));
            }
            catch {
                // the peer is already gone
            }
            socket.end();
        },
    };
    socket.on('data', (chunk) => {
        received += chunk.length;
        const decoded = decodeFrames(leftover, chunk);
        leftover = decoded.rest;
        for (const frame of decoded.frames) {
            if (frame.opcode === 0x8) {
                connection.close(1000);
                return;
            }
            if (frame.opcode === 0x9) {
                socket.write(encodePongFrame(frame.payload));
                continue;
            }
            if (frame.opcode === 0x1)
                handlers.onMessage(connection, frame.payload.toString('utf8'));
            // Continuation (0x0) and binary (0x2) frames are not part of this protocol.
        }
    });
    const finish = () => {
        if (!open)
            return;
        open = false;
        handlers.onClose(connection);
    };
    socket.on('close', finish);
    socket.on('error', finish);
    socket.on('end', finish);
    return connection;
}
