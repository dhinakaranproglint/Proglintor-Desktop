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


def monogram(size, bg, fg, with_mark=True, pad=0.20, rounded=True):
    S = size * 4  # supersample
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    inset = int(S * 0.06) if rounded else 0
    if bg:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((inset, inset, S - inset, S - inset), radius=int(S * 0.2) if rounded else 0, fill=255)
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
