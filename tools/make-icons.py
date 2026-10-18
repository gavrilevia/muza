#!/usr/bin/env python3
"""Генератор иконок PWA для «Музы» — без внешних зависимостей.

Рисует знак: три полосы (список идей) + кольцо (момент, когда идея нужна).
Цвета совпадают с лендингом: фон #0a0d14, оранжевый #ff8a5b, зелёный #5fd4a8.

Запуск:  python3 tools/make-icons.py
"""
import zlib
import struct
import math
import os


def write_png(path: str, w: int, h: int, px: list) -> None:
    """Пишем PNG вручную: без PIL, работает везде, где есть Python."""
    raw = b"".join(b"\x00" + bytes(px[y]) for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return (struct.pack(">I", len(data)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(blob)


BG = (10, 13, 20)        # #0a0d14
ORANGE = (255, 138, 91)  # #ff8a5b
GREEN = (95, 212, 168)   # #5fd4a8


def make_icon(size: int, out_path: str, maskable: bool = False) -> str:
    """size — сторона в пикселях; maskable — с полями для Android-обрезки."""
    SS = 4                      # суперсэмплинг: рисуем крупнее, потом усредняем
    W = size * SS
    buf = [[(0, 0, 0, 0)] * W for _ in range(W)]

    # maskable: знак занимает ~68% и центрируется — Android обрежет края
    pad = W * (0.16 if maskable else 0.0)
    radius = (W - 2 * pad) * 0.22
    x0, y0 = pad, pad
    x1, y1 = W - pad, W - pad

    def inside(p: float, q: float) -> bool:
        if not (x0 <= p < x1 and y0 <= q < y1):
            return False
        cx = min(max(p, x0 + radius), x1 - radius)
        cy = min(max(q, y0 + radius), y1 - radius)
        return (p - cx) ** 2 + (q - cy) ** 2 <= radius * radius

    span = x1 - x0
    X = lambda v: x0 + v * span          # noqa: E731
    Y = lambda v: y0 + v * span          # noqa: E731

    bars = [(0.18, 0.30, 0.82), (0.18, 0.50, 0.55), (0.18, 0.70, 0.68)]
    bar_w = 0.062 * span
    cx, cy, ring_r = X(0.78), Y(0.62), 0.155 * span
    ring_w = 0.062 * span

    for py in range(W):
        for px in range(W):
            if not inside(px, py):
                continue
            col = BG
            for bx0, by, bx1 in bars:
                if X(bx0) <= px <= X(bx1) and Y(by) - bar_w / 2 <= py <= Y(by) + bar_w / 2:
                    col = ORANGE
            dist = math.hypot(px - cx, py - cy)
            if ring_r - ring_w / 2 <= dist <= ring_r + ring_w / 2:
                col = GREEN
            buf[py][px] = (col[0], col[1], col[2], 255)

    # усредняем SS×SS блоков — получаем сглаженные края
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            rs = gs = bs = alpha = 0
            for dy in range(SS):
                for dx in range(SS):
                    r, g, b, a = buf[y * SS + dy][x * SS + dx]
                    rs += r * a
                    gs += g * a
                    bs += b * a
                    alpha += a
            n = SS * SS
            if alpha:
                # цвет — средневзвешенный по альфе; альфа — средняя по блоку
                row += [rs // alpha, gs // alpha, bs // alpha, alpha // n]
            else:
                row += [0, 0, 0, 0]
        out.append(row)

    write_png(out_path, size, size, out)
    return out_path


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    public = os.path.join(here, "..", "public")
    os.makedirs(public, exist_ok=True)

    targets = [
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (512, "icon-maskable-512.png", True),
        (180, "apple-touch-icon.png", False),   # iOS не любит прозрачность
    ]
    for px, name, mask in targets:
        path = make_icon(px, os.path.join(public, name), mask)
        print(f"  ✓ {name}  {px}×{px}")
    print("Готово. Иконки в public/")
