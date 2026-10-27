#!/usr/bin/env python3
"""无依赖生成插件图标：Telegram 蓝圆角底 + 白色纸飞机（Material send 轮廓）。
用法: python3 tools/gen_icons.py
"""
import os
import struct
import zlib

# Material Design "send" icon path, in a 24x24 viewBox (y down)
PLANE = [
    (2.01, 21.0), (23.0, 12.0), (2.01, 3.0),
    (2.0, 10.0), (17.0, 12.0), (2.0, 14.0),
]

BG_TOP = (0x2A, 0xAB, 0xEE)
BG_BOTTOM = (0x1E, 0x8C, 0xD6)
FG = (0xFF, 0xFF, 0xFF, 0xFF)

SIZES = [16, 32, 48, 128]
SS = 4  # supersample factor for anti-aliasing


def inside_polygon(px, py, poly):
    """Ray casting, works for concave polygons."""
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > py) != (yj > py):
            xint = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < xint:
                inside = not inside
        j = i
    return inside


def rounded_alpha(x, y, size, radius):
    """1.0 inside the rounded square, 0.0 outside, anti-aliased edge."""
    r = radius
    # shift so the shape occupies [-r, size-r]
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    dx = x - cx
    dy = y - cy
    d = (dx * dx + dy * dy) ** 0.5
    return max(0.0, min(1.0, r - d + 0.5))


def render(size):
    px = bytearray()
    radius = size * 0.22
    # fit the 24x24 glyph into the central 68% of the icon
    scale = size * 0.68 / 24.0
    ox = (size - 24.0 * scale) / 2.0
    oy = (size - 24.0 * scale) / 2.0

    step = 1.0 / SS
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # background (supersampled for the rounded corner)
            bg_a = 0.0
            bg_r = bg_g = bg_b = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) * step
                    fy = y + (sy + 0.5) * step
                    a = rounded_alpha(fx, fy, size, radius)
                    if a <= 0:
                        continue
                    t = fy / max(1, size - 1)
                    bg_a += a
                    bg_r += a * (BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
                    bg_g += a * (BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
                    bg_b += a * (BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
            n = SS * SS
            bg_a /= n
            if bg_a <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            r = bg_r / n
            g = bg_g / n
            b = bg_b / n

            # foreground glyph
            fg_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) * step
                    fy = y + (sy + 0.5) * step
                    gx = (fx - ox) / scale
                    gy = (fy - oy) / scale
                    if 0 <= gx <= 24 and 0 <= gy <= 24 and inside_polygon(gx, gy, PLANE):
                        fg_a += 1.0
            fg_a /= n

            out_a = bg_a
            out_r = r * (1 - fg_a) + FG[0] * fg_a
            out_g = g * (1 - fg_a) + FG[1] * fg_a
            out_b = b * (1 - fg_a) + FG[2] * fg_a
            row += bytes((int(out_r + 0.5), int(out_g + 0.5), int(out_b + 0.5),
                          int(out_a * 255 + 0.5)))
        px += b"\x00" + row  # PNG filter type 0
    return bytes(px)


def png(size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in SIZES:
        data = png(s, render(s))
        with open(os.path.join(out_dir, f"icon-{s}.png"), "wb") as f:
            f.write(data)
        print(f"icon-{s}.png  {len(data)} bytes")


if __name__ == "__main__":
    main()
