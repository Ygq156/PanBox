"""生成 PanBox 应用图标（build/icon.ico + build/icon.png）。
设计：深色圆角方块底 + 浅色云朵 + 蓝色向下箭头（「网盘快取」）。"""
import os
from PIL import Image, ImageDraw

S = 1024
BG1 = (18, 22, 30, 255)
BG2 = (28, 38, 54, 255)
CLOUD = (232, 238, 248, 255)
ACCENT = (76, 141, 255, 255)
ACCENT_D = (44, 105, 210, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 纵向渐变底
grad = Image.new("RGBA", (1, S))
for y in range(S):
    t = y / (S - 1)
    grad.putpixel(
        (0, y),
        (
            int(BG1[0] + (BG2[0] - BG1[0]) * t),
            int(BG1[1] + (BG2[1] - BG1[1]) * t),
            int(BG1[2] + (BG2[2] - BG1[2]) * t),
            255,
        ),
    )
grad = grad.resize((S, S))

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(grad, (0, 0), mask)

# ---- 云朵 ----
cx, cy = S * 0.5, S * 0.40
d.ellipse([cx - 300, cy - 150, cx + 40, cy + 190], fill=CLOUD)
d.ellipse([cx - 130, cy - 250, cx + 200, cy + 120], fill=CLOUD)
d.ellipse([cx + 70, cy - 80, cx + 300, cy + 180], fill=CLOUD)
d.rounded_rectangle([cx - 300, cy + 40, cx + 300, cy + 190], radius=80, fill=CLOUD)

# ---- 向下箭头 ----
ax, ay = cx, S * 0.62
d.rounded_rectangle([ax - 62, ay - 30, ax + 62, ay + 150], radius=20, fill=ACCENT)
d.polygon(
    [(ax - 165, ay + 130), (ax + 165, ay + 130), (ax, ay + 300)],
    fill=ACCENT,
)
# 箭头高光
d.rounded_rectangle([ax - 40, ay - 18, ax - 6, ay + 120], radius=12, fill=ACCENT_D)

out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
out_dir = os.path.abspath(out_dir)
os.makedirs(out_dir, exist_ok=True)

png_path = os.path.join(out_dir, "icon.png")
ico_path = os.path.join(out_dir, "icon.ico")
img.save(png_path, "PNG")
img.resize((512, 512), Image.LANCZOS).save(
    ico_path,
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print("png:", png_path, os.path.getsize(png_path))
print("ico:", ico_path, os.path.getsize(ico_path))
