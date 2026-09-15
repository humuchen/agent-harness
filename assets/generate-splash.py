#!/usr/bin/env python3
"""
生成 Agent Harness 启动图（splash screen）资产。

输出到 ../assets/（仓库根 assets/），供 mobile/scripts/splash-copy.mjs
拷入 Capacitor 原生工程。所有图统一深色画布 #0b0e14 + 三层菱形 logo
（对齐 public/logo.svg）+ "Agent Harness" 品牌字，与暗色主题一致。

运行： python3 assets/generate-splash.py
依赖： Pillow（macOS 上 Python 自带环境通常已有；否则 pip install pillow）
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("需要 Pillow：pip install pillow")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "assets")
os.makedirs(OUT, exist_ok=True)

BG = (11, 14, 20)          # --ah-canvas #0b0e14
ACCENT = (41, 151, 255)    # --ah-accent #2997FF
TEXT = (230, 237, 243)     # --ah-text   #E6EDF3

# 三层菱形（viewBox 0 0 100 100），与 public/logo.svg 一致。
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

def render(w, h, out_path, large=False):
    """渲染一张启动图：三层菱形 logo + 品牌字，垂直居中。"""
    img = Image.new("RGB", (w, h), BG)
    draw = ImageDraw.Draw(img)
    font_size = max(18, int(w * (0.045 if large else 0.055)))
    font = _font(font_size)

    label = "Agent Harness"
    bbox = draw.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    gap = int(font_size * 0.9)
    total_h = int(font_size * 1.6) + gap + th
    top = (h - total_h) // 2

    # logo 区（三层菱形占 font_size*1.6 高）
    logo_block = int(font_size * 1.6)
    cy_logo = top + logo_block / 2
    scale = (logo_block / 100.0) * 2.2  # 0..100 网格映射

    for i, pts in enumerate(RHOMBI):
        f = 1 - i * 0.30  # 下层菱形渐淡（与 logo 立体感一致）
        c = tuple(int(BG[j] + (ACCENT[j] - BG[j]) * f) for j in range(3))
        poly = [(w / 2 + (x - 50) * scale, cy_logo + (y - 50) * scale) for (x, y) in pts]
        draw.polygon(poly, fill=c)

    # 品牌字
    draw.text((w / 2 - tw / 2, top + logo_block + gap), label, font=font, fill=TEXT)
    img.save(out_path)
    print(f"  {out_path}  ({w}x{h})")

def main():
    print("生成 Android 启动图…")
    # Capacitor 8 竖屏密度序列（mdpi→xxxhdpi）
    render(720, 1280, os.path.join(OUT, "splash_m.png"))
    render(1080, 1920, os.path.join(OUT, "splash_x.png"))
    render(1440, 2560, os.path.join(OUT, "splash_xx.png"))
    render(2160, 3840, os.path.join(OUT, "splash_xxx.png"))
    # Android 14+ 方形大启动图（最小 1908x1908，logo ≤ 648）
    render(1908, 1908, os.path.join(OUT, "splash_large.png"), large=True)

    print("生成 iOS 启动图（LaunchScreen.imageset）…")
    ios_specs = [
        (393, 852), (430, 932), (375, 812), (414, 896),
        (400, 874), (440, 956), (2048, 2732), (1668, 2388), (1366, 1024),
    ]
    for w, h in ios_specs:
        render(w, h, os.path.join(OUT, f"Splash-{w}x{h}.png"))

    print("完成。下一步：cd mobile && pnpm run splash:copy")

if __name__ == "__main__":
    main()
