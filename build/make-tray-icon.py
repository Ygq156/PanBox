"""生成托盘图标 resources/tray.png（透明底，只留云 + 下箭头）。

用法（在仓库根目录，或用任何 Python 3 + Pillow 环境）：
    python build/make-tray-icon.py

为什么要单独做一张：托盘图标只有 16px，直接用 1024px 的应用图标会带上深色圆角方块，
在任务栏上糊成一团；这里把深色底按亮度抠成透明，再缩到 32px（高 DPI 下系统会自己缩）。
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "icon.png")
DST = os.path.join(ROOT, "resources", "tray.png")

src = Image.open(SRC).convert("RGBA")
px = src.load()
w, h = src.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        # 深色圆角底（近黑、低饱和）整块抠掉；云与箭头都明显更亮
        if luma < 78:
            px[x, y] = (0, 0, 0, 0)
        else:
            # 边缘按亮度给一点羽化，缩到 16px 时不会有黑边
            px[x, y] = (r, g, b, min(255, int((luma - 70) * 255 / 40)))

content = src.crop(src.getbbox())
side = max(content.size)
pad = int(side * 0.08)
canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
canvas.paste(content, ((canvas.width - content.width) // 2, (canvas.height - content.height) // 2))

out = canvas.resize((32, 32), Image.LANCZOS)
os.makedirs(os.path.dirname(DST), exist_ok=True)
out.save(DST)
print("saved", DST, out.size)