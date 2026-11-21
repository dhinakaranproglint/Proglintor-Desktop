"""Builds Proglintor app icons, tray icons and wordmarks from the official Proglint logo.

    python3 -m pip install pillow
    python3 scripts/make-brand-icons.py            # reads assets/brand/proglint-logo-source.png
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "brand" / "proglint-logo-source.png"
OUT = ROOT / "assets"

logo = Image.open(SRC).convert("RGBA")
W, H = logo.size


def is_orange(p):
    r, g, b, a = p
    return a > 40 and r > 180 and b < 170 and r - b > 60


def trimmed(im):
    return im.crop(im.getbbox())


# --- pieces of the wordmark -----------------------------------------------------------
P_BOX = (0, 0, 435, H)                 # first glyph: "p"
MARK_BOX = (2530, 320, W, H)           # orange figure next to the "t"
p_glyph = trimmed(logo.crop(P_BOX))
mark_region = logo.crop(MARK_BOX)
mark = Image.new("RGBA", mark_region.size)
mark.putdata([px if is_orange(px) else (0, 0, 0, 0) for px in mark_region.get_flattened_data()])
mark = trimmed(mark)
p_top_in_logo = logo.crop(P_BOX).getbbox()[1]
mark_top_in_logo = MARK_BOX[1] + mark_region.getbbox()[1] if mark_region.getbbox() else MARK_BOX[1]


def recolor(im, rgb):
    """Recolors the non-orange (black) pixels, keeping alpha."""
    out = Image.new("RGBA", im.size)
    out.putdata([(*rgb, a) if not is_orange((r, g, b, a)) else (r, g, b, a) for r, g, b, a in im.get_flattened_data()])
    return out


def silhouette(im):
    """Black silhouette for macOS template images."""
    out = Image.new("RGBA", im.size)
    out.putdata([(0, 0, 0, a) for *_, a in im.get_flattened_data()])
    return out


def monogram(size, bg, fg, with_mark=True, pad=0.20, rounded=True, inset_ratio=0.06, shadow=False):
    S = size * 4  # supersample
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    inset = int(S * inset_ratio) if rounded else 0
    if bg and shadow:  # soft drop shadow under the tile (macOS style)
        sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((inset, inset + int(S * 0.012), S - inset, S - inset + int(S * 0.012)), radius=int(S * 0.2 * (1 - 2 * inset_ratio)), fill=(0, 0, 0, 120))
        canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * 0.012)))
    if bg:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((inset, inset, S - inset, S - inset), radius=int(S * 0.2 * (1 - 2 * inset_ratio)) if rounded else 0, fill=255)
        layer = Image.new("RGBA", (S, S), bg)
        canvas.paste(layer, (0, 0), mask)
    glyph = recolor(p_glyph, fg) if fg else p_glyph
    avail = S - 2 * inset - 2 * int(S * pad)
    group_w = p_glyph.width + ((0.02 * S) / (avail / p_glyph.height) + mark.width if with_mark else 0)
    scale = min(avail / p_glyph.height, avail / group_w)  # fit both height and width
    pg = glyph.resize((max(1, int(p_glyph.width * scale)), max(1, int(p_glyph.height * scale))), Image.LANCZOS)
    parts_w = pg.width
    mk = None
    if with_mark:
        mk = mark.resize((max(1, int(mark.width * scale)), max(1, int(mark.height * scale))), Image.LANCZOS)
        gap = int(S * 0.02)
        parts_w += gap + mk.width
    x0 = (S - parts_w) // 2
    y0 = (S - pg.height) // 2
    canvas.alpha_composite(pg, (x0, y0))
    if mk is not None:
        my = y0 + int((mark_top_in_logo - p_top_in_logo) * scale)
        canvas.alpha_composite(mk, (x0 + pg.width + gap, my))
    return canvas.resize((size, size), Image.LANCZOS)


def tray(size, with_mark):
    im = monogram(size, None, (0, 0, 0), with_mark=with_mark, pad=0.0, rounded=False)
    return silhouette(im)


# Agent: black "p" + orange figure on white.  Admin: white "p" + orange figure on near-black.
monogram(1024, (255, 255, 255, 255), None).save(OUT / "icon.png")
monogram(1024, (17, 18, 22, 255), (255, 255, 255)).save(OUT / "admin-icon.png")
monogram(64, (255, 255, 255, 255), None).resize((32, 32), Image.LANCZOS).save(OUT / "tray.png")
monogram(64, (17, 18, 22, 255), (255, 255, 255)).resize((32, 32), Image.LANCZOS).save(OUT / "admin-tray.png")
tray(16, False).save(OUT / "trayTemplate.png")
tray(32, False).save(OUT / "trayTemplate@2x.png")
tray(16, True).save(OUT / "adminTrayTemplate.png")
tray(32, True).save(OUT / "adminTrayTemplate@2x.png")

# Wordmarks for the UI (light and dark backgrounds), 600px wide.
word = trimmed(logo)
word = word.resize((600, int(word.height * 600 / word.width)), Image.LANCZOS)
word.save(OUT / "brand" / "proglint-logo.png")
recolor(word, (255, 255, 255)).save(OUT / "brand" / "proglint-logo-white.png")
print("brand assets written to", OUT)


# ---- application icons: macOS .icns, Windows .ico, Linux .png ---------------------------------------
import shutil, subprocess, tempfile

ICONS = OUT / "icons"
ICONS.mkdir(exist_ok=True)
WHITE, DARK = (255, 255, 255, 255), (17, 18, 22, 255)

for name, bg, fg in (("agent", WHITE, None), ("admin", DARK, (255, 255, 255))):
    # Windows / Linux: full-bleed rounded tile.
    flat = monogram(1024, bg, fg, inset_ratio=0.02, pad=0.13)
    flat.resize((512, 512), Image.LANCZOS).save(ICONS / f"{name}.png")
    flat.save(ICONS / f"{name}.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # macOS: Apple's proportions (tile = 824/1024 of the canvas, with a soft shadow).
    mac = monogram(1024, bg, fg, inset_ratio=100 / 1024, shadow=True, pad=0.13)
    mac.save(ICONS / f"{name}-mac.png")
    if shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as td:
            iconset = Path(td) / f"{name}.iconset"
            iconset.mkdir()
            for base in (16, 32, 128, 256, 512):
                mac.resize((base, base), Image.LANCZOS).save(iconset / f"icon_{base}x{base}.png")
                mac.resize((base * 2, base * 2), Image.LANCZOS).save(iconset / f"icon_{base}x{base}@2x.png")
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICONS / f"{name}.icns")], check=True)
print("app icons written to", ICONS)
