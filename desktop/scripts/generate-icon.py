#!/usr/bin/env python3
"""Generate PNG icons (no third-party libraries) for installers and the running app."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def pixel(x: int, y: int, size: int) -> bytes:
    nx = (x + 0.5) / size
    ny = (y + 0.5) / size
    px, py = abs(nx - 0.5), abs(ny - 0.5)
    if max(px, py) > 0.46:
        return b"\x00\x00\x00\x00"
    if max(px, py) > 0.42:
        return bytes((21, 24, 33, 255))
    cx, cy = nx - 0.5, ny - 0.54
    body = (cx * cx) / 0.22**2 + (cy * cy) / 0.12**2
    if body <= 1:
        return bytes((77, 147, 248, 255))
    if (nx - 0.40) ** 2 + (ny - 0.52) ** 2 < 0.004:
        return bytes((16, 18, 24, 255))
    return bytes((21, 24, 33, 255))


def png(size: int) -> bytes:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x, y, size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def write(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png(size))
    print(f"wrote {path} ({path.stat().st_size} bytes)")


def main() -> None:
    write(ROOT / "build" / "icon.png", 1024)
    write(ROOT / "resources" / "icon.png", 256)
    icons = ROOT / "build" / "icons"
    for size in SIZES:
        write(icons / f"{size}x{size}.png", size)


if __name__ == "__main__":
    main()
