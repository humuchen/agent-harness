#!/usr/bin/env python3
"""
生成 Agent Harness App 图标（mipmap launcher icons）。

输出到 mobile/android/app/src/main/res/mipmap-{dpi}/ 目录。
- ic_launcher.png: 深色背景 (#0b0e14) + 三层菱形 logo + 品牌字
- ic_launcher_foreground.png: 透明背景 + 三层菱形 logo（安全区内）
- 同时更新 values/ic_launcher_background.xml 为 #0B0E14

运行：python3 assets/generate-icons.py
依赖：Pillow
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ANDROID_RES = os.path.join(ROOT, "mobile/android/app/src/main/res")

BG = (11, 14, 20)          # #0b0e14
ACCENT = (41, 151, 255)    # #2997FF
LIGHT = (64, 159, 255)     # lighter accent for logo contrast

# 三层菱形（viewBox 0 0 100 100），与 public/logo.svg 一致
RHOMBI = [
    [(50, 6), (84, 20), (50, 34), (16, 20)],
    [(50, 36), (84, 50), (50, 64), (16, 50)],
    [(50, 66), (84, 80), (50, 94), (16, 80)],
]

def _font(size):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

def draw_logo(draw, cx, cy, size, alpha_base=1.0):
    """在 (cx, cy) 绘制三层菱形 logo，size 为 logo 区块边长（px）。"""
    scale = size / 100.0
    for i, pts in enumerate(RHOMBI):
        f = alpha_base - i * 0.35
        if f < 0.1:
            f = 0.1
        c = tuple(int(BG[j] + (LIGHT[j] - BG[j]) * f) for j in range(3))
        poly = [(cx + (x - 50) * scale, cy + (y - 50) * scale) for (x, y) in pts]
        draw.polygon(poly, fill=c)

def gen_launcher(dpi, size):
    """生成 ic_launcher.png：深色背景 + 菱形 logo 居中"""
    path = os.path.join(ANDROID_RES, f"mipmap-{dpi}", "ic_launcher.png")
    img = Image.new("RGBA", (size, size), (*BG, 255))
    draw = ImageDraw.Draw(img)
    # logo 占图标的 60%
    logo_size = int(size * 0.60)
    draw_logo(draw, size // 2, size // 2, logo_size, alpha_base=1.0)
    img.save(path)
    print(f"  {os.path.relpath(path, ANDROID_RES)}  ({size}x{size})")

def gen_foreground(dpi, size):
    """
    生成 ic_launcher_foreground.png：透明背景 + 菱形 logo 在安全区内。
    安全区：Android 自适应图标 logo 必须落在中心 66% 圆形内。
    图标总尺寸 = 108dp 等效，logo 区块 = 66% * size * 0.8 ≈ size * 0.53
    """
    path = os.path.join(ANDROID_RES, f"mipmap-{dpi}", "ic_launcher_foreground.png")
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 安全区内：logo 占中心 ~60% 区域
    logo_size = int(size * 0.53)
    draw_logo(draw, size // 2, size // 2, logo_size, alpha_base=1.0)
    img.save(path)
    print(f"  {os.path.relpath(path, ANDROID_RES)}  ({size}x{size})")

def gen_round_launcher(dpi, size):
    """生成 ic_launcher_round.png：圆形裁剪"""
    import math
    path = os.path.join(ANDROID_RES, f"mipmap-{dpi}", "ic_launcher_round.png")
    # 先生成方形再裁圆
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # 绘制圆形
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    bg_img = Image.new("RGBA", (size, size), (*BG, 255))
    square.paste(bg_img, (0, 0), mask)
    square = Image.alpha_composite(square, bg_img)
    draw = ImageDraw.Draw(square)
    logo_size = int(size * 0.55)
    draw_logo(draw, size // 2, size // 2, logo_size, alpha_base=1.0)
    # 重新应用圆形 mask
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(square, (0, 0), mask)
    result.save(path)
    print(f"  {os.path.relpath(path, ANDROID_RES)}  ({size}x{size})")

def main():
    if not os.path.isdir(ANDROID_RES):
        sys.exit(f"找不到 {ANDROID_RES}，请先运行 cap sync 生成 android 目录")

    # 各密度尺寸（与 Capacitor 默认一致）
    densities = [
        ("mdpi", 48),
        ("hdpi", 72),
        ("xhdpi", 96),
        ("xxhdpi", 144),
        ("xxxhdpi", 192),
    ]
    # foreground 尺寸 = 108dp 等效
    fg_sizes = {
        "mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432
    }

    print("生成 mipmap 图标…")
    for dpi, size in densities:
        d = os.path.join(ANDROID_RES, f"mipmap-{dpi}")
        os.makedirs(d, exist_ok=True)
        gen_launcher(dpi, size)
        gen_foreground(dpi, fg_sizes[dpi])
        gen_round_launcher(dpi, size)

    # 更新 ic_launcher_background.xml
    bg_xml = os.path.join(ANDROID_RES, "values", "ic_launcher_background.xml")
    with open(bg_xml, "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write('<resources>\n')
        f.write('    <color name="ic_launcher_background">#0B0E14</color>\n')
        f.write('</resources>\n')
    print(f"  {bg_xml} → #0B0E14")

    print("完成。下一步：cd mobile/android && ./gradlew assembleDebug --no-daemon")

if __name__ == "__main__":
    main()
