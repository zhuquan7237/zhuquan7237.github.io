#!/usr/bin/env python3
"""Rasterize the official DeepSeek whale into installer / window icon sizes.

Source: desktop/scripts/deepseek-whale.png
(DeepSeek org avatar — same #4D6BFE whale as www.deepseek.com/favicon.ico).
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT.parent / "assets"
SOURCE = Path(__file__).resolve().parent / "deepseek-whale.png"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
BRAND = (77, 107, 254)
PAD = 0.06


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png(path: Path) -> tuple[int, int, bytearray]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    pos = 8
    width = height = bpp = 0
    raw = b""
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bit, color, _comp, _filt, inter = struct.unpack(">IIBBBBB", body)
            if bit != 8 or color not in (2, 6) or inter != 0:
                raise ValueError(f"unsupported PNG {bit}/{color}/{inter}")
            bpp = 3 if color == 2 else 4
        elif tag == b"IDAT":
            raw += body
        elif tag == b"IEND":
            break
    buf = zlib.decompress(raw)
    stride = width * bpp
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _y in range(height):
        filt = buf[i]
        i += 1
        line = bytearray(buf[i : i + stride])
        i += stride
        if filt == 1:
            for x in range(stride):
                line[x] = (line[x] + (line[x - bpp] if x >= bpp else 0)) & 255
        elif filt == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif filt == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) // 2)) & 255
        elif filt == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                c = prev[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + paeth(a, prev[x], c)) & 255
        elif filt != 0:
            raise ValueError(f"unsupported PNG filter {filt}")
        prev = line
        if bpp == 3:
            for x in range(0, stride, 3):
                out.extend(line[x : x + 3])
                out.append(255)
        else:
            out.extend(line)
    return width, height, out


def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(rgba[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    print(f"wrote {path} ({path.stat().st_size} bytes)")


def unwhite(width: int, height: int, rgba: bytearray) -> bytearray:
    """Turn a white-backed official mark into brand-blue + alpha (no white halo)."""
    out = bytearray(len(rgba))
    br, bg, bb = BRAND
    for i in range(0, len(rgba), 4):
        r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
        alphas = []
        for channel, brand in ((r, br), (g, bg), (b, bb)):
            denom = 255 - brand
            if denom > 0:
                alphas.append((255 - channel) / denom)
        alpha = max(0.0, min(1.0, max(alphas) if alphas else 0.0))
        out[i] = br
        out[i + 1] = bg
        out[i + 2] = bb
        out[i + 3] = 0 if alpha < 0.04 else int(round(alpha * 255))
    return out


def bbox(width: int, height: int, rgba: bytearray, cutoff: int = 12) -> tuple[int, int, int, int]:
    minx, miny, maxx, maxy = width, height, 0, 0
    for y in range(height):
        row = y * width * 4
        for x in range(width):
            if rgba[row + x * 4 + 3] > cutoff:
                minx = min(minx, x)
                miny = min(miny, y)
                maxx = max(maxx, x)
                maxy = max(maxy, y)
    if maxx < minx:
        return 0, 0, width - 1, height - 1
    return minx, miny, maxx, maxy


def sample(width: int, height: int, rgba: bytearray, x: float, y: float) -> tuple[int, int, int, int]:
    if x < 0 or y < 0 or x >= width - 1 or y >= height - 1:
        ix, iy = int(round(x)), int(round(y))
        if ix < 0 or iy < 0 or ix >= width or iy >= height:
            return (0, 0, 0, 0)
        i = (iy * width + ix) * 4
        return rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]
    x0, y0 = int(x), int(y)
    x1, y1 = x0 + 1, y0 + 1
    fx, fy = x - x0, y - y0

    def pix(px: int, py: int) -> tuple[int, int, int, int]:
        i = (py * width + px) * 4
        return rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]

    c00, c10, c01, c11 = pix(x0, y0), pix(x1, y0), pix(x0, y1), pix(x1, y1)

    def mix(a: int, b: int, t: float) -> float:
        return a * (1 - t) + b * t

    return tuple(int(round(mix(mix(c00[k], c10[k], fx), mix(c01[k], c11[k], fx), fy))) for k in range(4))  # type: ignore[return-value]


def compose(size: int, width: int, height: int, rgba: bytearray) -> bytes:
    x0, y0, x1, y1 = bbox(width, height, rgba)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    side = max(bw, bh)
    pad = max(int(side * PAD), 1)
    side += pad * 2
    left = x0 - (side - bw) // 2
    top = y0 - (side - bh) // 2
    out = bytearray(size * size * 4)
    if size >= side:
        for y in range(size):
            sy = top + (y + 0.5) * side / size - 0.5
            for x in range(size):
                sx = left + (x + 0.5) * side / size - 0.5
                r, g, b, a = sample(width, height, rgba, sx, sy)
                i = (y * size + x) * 4
                out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, a
        return bytes(out)
    # Area-average downscale so 16px still reads as the whale.
    for y in range(size):
        sy0 = top + y * side / size
        sy1 = top + (y + 1) * side / size
        iy0, iy1 = int(sy0), min(height, int(sy1) + 1)
        for x in range(size):
            sx0 = left + x * side / size
            sx1 = left + (x + 1) * side / size
            ix0, ix1 = int(sx0), min(width, int(sx1) + 1)
            tr = tg = tb = ta = count = 0
            for iy in range(max(iy0, 0), max(iy1, 0)):
                row = iy * width * 4
                for ix in range(max(ix0, 0), max(ix1, 0)):
                    p = row + ix * 4
                    tr += rgba[p]
                    tg += rgba[p + 1]
                    tb += rgba[p + 2]
                    ta += rgba[p + 3]
                    count += 1
            i = (y * size + x) * 4
            if count:
                out[i] = tr // count
                out[i + 1] = tg // count
                out[i + 2] = tb // count
                out[i + 3] = ta // count
    return bytes(out)


def main() -> None:
    width, height, rgb = read_png(SOURCE)
    rgba = unwhite(width, height, rgb)
    write_png(ROOT / "build" / "icon.png", 1024, 1024, compose(1024, width, height, rgba))
    write_png(ROOT / "resources" / "icon.png", 256, 256, compose(256, width, height, rgba))
    icons = ROOT / "build" / "icons"
    for size in SIZES:
        write_png(icons / f"{size}x{size}.png", size, size, compose(size, width, height, rgba))
    if SITE.is_dir():
        raster = compose(256, width, height, rgba)
        write_png(SITE / "icon.png", 256, 256, raster)
        write_png(SITE / "deepseek-whale.png", 256, 256, raster)
        public = ROOT.parent / "deepseek-app" / "public"
        write_png(public / "favicon.png", 256, 256, raster)
        svg = Path(__file__).resolve().parent / "deepseek-whale.svg"
        if svg.is_file():
            text = svg.read_text(encoding="utf-8")
            for dest in (
                SITE / "favicon.svg",
                ROOT.parent / "app" / "favicon.svg",
                public / "favicon.svg",
            ):
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(text, encoding="utf-8")
                print(f"wrote {dest}")


if __name__ == "__main__":
    main()
