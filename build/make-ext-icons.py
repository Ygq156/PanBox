"""生成浏览器插件的 PNG 图标（16/32/48/128）。

设计：圆角方块 + 蓝色渐变底 + 白色向下箭头 + 一条底线（“落到本地磁盘”）。
用 4 倍超采样再缩回来，边缘才干净。
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "extension", "icons")
S = 4  # 超采样倍数


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size), Image.BILINEAR)


def make(size):
    n = size * S
    img = gradient(n, (86, 152, 255), (40, 96, 220)).convert("RGBA")
    d = ImageDraw.Draw(img)

    # 向下箭头：竖杆 + 三角头
    cx = n / 2
    bar_w = n * 0.145
    bar_top = n * 0.20
    bar_bot = n * 0.60
    d.rounded_rectangle([cx - bar_w / 2, bar_top, cx + bar_w / 2, bar_bot], radius=bar_w * 0.35, fill=(255, 255, 255, 255))

    head_w = n * 0.34
    head_top = bar_bot - n * 0.045
    head_bot = n * 0.775
    d.polygon([(cx - head_w, head_top), (cx + head_w, head_top), (cx, head_bot)], fill=(255, 255, 255, 255))

    # 底部托盘（一条圆角横线 = 收到本地）
    tray_w = n * 0.62
    tray_h = n * 0.088
    tray_y = n * 0.845
    d.rounded_rectangle(
        [cx - tray_w / 2, tray_y, cx + tray_w / 2, tray_y + tray_h],
        radius=tray_h / 2,
        fill=(255, 255, 255, 235),
    )

    img.putalpha(rounded_mask(n, n * 0.22))
    return img.resize((size, size), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"icon{s}.png")
    make(s).save(p, "PNG", optimize=True)
    print(f"{p}  {os.path.getsize(p)} bytes")
