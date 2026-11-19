#!/usr/bin/env python3
"""Generate store/icon.png: a 12x12 pixel-art HUD glyph scaled 2x to 24x24.
Even Hub icons must be transparent + opaque #F4F4F4 drawn in 2x2 blocks."""
import struct, sys, zlib

ART = [  # 12x12: three HUD lines, the middle one with an "alert" dot
    "............",
    "............",
    ".##########.",
    "............",
    "............",
    ".######..##.",
    "............",
    "............",
    ".########...",
    "............",
    "............",
    "............",
]
INK = (0xF4, 0xF4, 0xF4, 255)
CLEAR = (0, 0, 0, 0)

rows = b""
for y in range(24):
    line = bytearray([0])
    for x in range(24):
        line += bytes(INK if ART[y // 2][x // 2] == "#" else CLEAR)
    rows += bytes(line)

def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 24, 24, 8, 6, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))
open(sys.argv[1] if len(sys.argv) > 1 else "store/icon.png", "wb").write(png)
