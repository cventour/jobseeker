#!/usr/bin/env python3
"""Derive the JobSeeker icon set from the single Gemini master (jobseeker.png).

Transform: the source has a mid-grey field with an additive coloured glow. We split
each pixel into a neutral base (min channel) and chroma (the glow), darken + tint the
neutral base toward the app's navy #0f1220, and keep the chroma untouched.
"""
import os
from PIL import Image, ImageDraw
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Lossless WebP: every pixel with any opacity is bit-identical to the original PNG, at 113 KB
# instead of 1,355 KB. A smooth gradient is the worst case for PNG and the best case for WebP.
SRC = os.path.join(ROOT, "assets", "brand", "jobseeker-master.webp")
PUB = os.path.join(ROOT, "public")
# app/ was removed with the legacy Next.js layer; icons now live only in public/,
# which server/dashboard.mjs serves through an explicit allowlist.
SITE = os.path.join(ROOT, "site", "img")   # the published website's own copies
os.makedirs(PUB, exist_ok=True)
os.makedirs(SITE, exist_ok=True)

NAVY = (15, 18, 32)          # --bg of the dashboard dark theme
KD = 0.5                      # how much to darken the neutral field
TINT = tuple(v / max(NAVY) for v in NAVY)   # (0.469, 0.5625, 1.0)

# ---------- 1. retint ----------
# Read RGBA, not RGB. `.convert("RGB")` DISCARDS the alpha channel, which means every fully
# transparent pixel contributes whatever RGB happens to be stored beneath it -- and those values are
# undefined. Converting the master from PNG to lossless WebP rewrote them (legitimately: they are
# invisible), which pushed the chroma bounding box below out to the image edge and produced a
# clipped, off-centre app icon. Masking by alpha makes the crop depend only on pixels that render.
_src = Image.open(SRC).convert("RGBA")
alpha = np.asarray(_src.getchannel("A"))
a = np.asarray(_src.convert("RGB")).astype(np.float32)
# ...and ZERO that RGB wherever it is invisible, before anything reads it.
#
# Masking only the chroma used to FIND the crop box (below) was half the fix: the crop is taken from
# `tinted`, which still carried the undefined colour stored beneath transparent pixels. Both cuts
# extend past the artwork by design — 72% and 88% of the tile — so they reached straight into that
# garbage and rendered it as a hard green rectangle beside the mark. Worse, it is Pillow-version
# dependent: what a given build hands back for an invisible pixel is not defined, so the same script
# and the same master produced a clean icon on one machine and a broken one on another. Zeroing it
# here makes the output depend only on pixels that render.
a *= (alpha > 8)[..., None]
m = a.min(axis=2)
chroma = a - m[..., None]
base = (m * KD)[..., None] * np.array(TINT, dtype=np.float32)
out = np.clip(base + chroma, 0, 255).astype(np.uint8)
tinted = Image.fromarray(out, "RGB")

# ---------- 2. crop so the symbol fills ~72% of the tile ----------
cmax = chroma.max(axis=2)
# A transparent pixel carries no signal, whatever colour is stored under it.
cmax = np.where(alpha > 8, cmax, 0)
ys, xs = np.where(cmax > 140)
if len(xs) == 0:
    raise SystemExit("make-icons: no visible chroma found in the master — check SRC")
cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
side = max(xs.max() - xs.min(), ys.max() - ys.min()) / 0.72
left, top = round(cx - side / 2), round(cy - side / 2)
side = round(side)
master = tinted.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.LANCZOS)
print(f"crop {side}px @ ({left},{top})  symbol ~{(xs.max()-xs.min())/side:.0%} of tile")

BG = master.getpixel((8, 8))

# ---------- 2b. small-size variant ----------
# The soft glow dissolves below ~48px, so favicons get their own optical cut:
# tighter crop (symbol ~88% of the tile), more saturation and contrast so the
# stroke still separates from the field at 16px.
from PIL import ImageEnhance, ImageFilter
side_s = round(max(xs.max() - xs.min(), ys.max() - ys.min()) / 0.88)
l_s, t_s = round(cx - side_s / 2), round(cy - side_s / 2)
small = tinted.crop((l_s, t_s, l_s + side_s, t_s + side_s)).resize((512, 512), Image.LANCZOS)
small = ImageEnhance.Color(small).enhance(1.35)
small = ImageEnhance.Contrast(small).enhance(1.30)
small = ImageEnhance.Brightness(small).enhance(1.15)


def tiny(size):
    """Downscale the small-size cut and re-sharpen the stroke edges."""
    o = small.resize((size, size), Image.LANCZOS)
    return o.filter(ImageFilter.UnsharpMask(radius=1, percent=110, threshold=0))


def squircle(img, radius_pct=0.22):
    """Rounded-square mask with transparent corners, at 4x for clean edges."""
    n = img.size[0]
    mask = Image.new("L", (n * 4, n * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, n * 4 - 1, n * 4 - 1), radius=int(n * 4 * radius_pct), fill=255)
    mask = mask.resize((n, n), Image.LANCZOS)
    o = img.convert("RGBA")
    o.putalpha(mask)
    return o


def save(img, path, **kw):
    img.save(path, optimize=True, **kw)
    print(f"  {os.path.relpath(path, ROOT):38s} {img.size[0]:>4}px  {os.path.getsize(path)/1024:6.1f} KB")


def rounded(size):
    return squircle(master.resize((size, size), Image.LANCZOS))


def flat(size):
    return master.resize((size, size), Image.LANCZOS)


print("\nicons:")
# The header renders the mark at 32-40px, which is favicon territory, not app-icon
# territory — so the lockup uses the same punchy small-size cut, not the master.
save(squircle(small.resize((256, 256), Image.LANCZOS)), f"{PUB}/logo.png")

# WebP for the pages that actually render the logo: this artwork is one big smooth
# gradient, which PNG stores terribly (~245 KB at 512) and WebP nails at ~8 KB.
for n in (128, 256):
    p = f"{PUB}/logo.webp" if n == 256 else f"{PUB}/logo-{n}.webp"
    squircle(small.resize((n, n), Image.LANCZOS)).save(p, quality=90, method=6)
    print(f"  {os.path.relpath(p, ROOT):38s} {n:>4}px  {os.path.getsize(p)/1024:6.1f} KB")

# Android maskable: no rounding, symbol shrunk into the 80% safe zone.
mk = Image.new("RGB", (512, 512), BG)
inner = flat(round(512 * 0.72))
mk.paste(inner, ((512 - inner.size[0]) // 2,) * 2)

# iOS masks its own corners and flattens alpha -> must be square + opaque.
# Transparent mark for README and docs — no rounded tile, so it sits on any background.
mark = Image.open(SRC).convert("RGBA").resize((256, 256), Image.LANCZOS)
save(mark, f"{PUB}/logo-mark.png")

# The WEBSITE gets the same mark, generated rather than copied. site/img/mark*.png were
# hand-placed once and then never regenerated, so when the alpha bug was fixed in public/ the
# published site kept serving the old clipped artwork — the fix landed everywhere except the one
# place a visitor actually looks. Emitting them here is what stops that happening again.
save(mark, f"{SITE}/mark.png")
save(mark, f"{SITE}/mark-ink.png")

save(flat(180), f"{PUB}/apple-touch-icon.png")  # served by the standalone dashboard

# Tab icons use the small-size cut. Square (not rounded) — at 16px rounded corners
# just eat pixels, and every browser draws the favicon inside its own chrome anyway.
save(tiny(48), f"{PUB}/favicon-48.png")
save(tiny(32), f"{PUB}/favicon-32.png")
save(tiny(16), f"{PUB}/favicon-16.png")

# .ico: legacy fallback, multi-resolution, each layer optically sized.
def build_ico(path):
    tiny(48).save(path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                  append_images=[tiny(32), tiny(16)])
    print(f"  {os.path.relpath(path, ROOT):38s} 16/32/48  {os.path.getsize(path)/1024:6.1f} KB")


build_ico(f"{PUB}/favicon.ico")

# ---------- 3. og image ----------
og = Image.new("RGB", (1200, 630), NAVY)
lg = flat(300)
og.paste(lg, (150, 165))
try:
    from PIL import ImageFont
    f1 = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 92, index=1)
    f2 = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 34, index=0)
    d = ImageDraw.Draw(og)
    d.text((520, 250), "JobSeeker", font=f1, fill=(231, 233, 243))
    d.text((524, 360), "Your job search, run by agents.", font=f2, fill=(154, 160, 189))
except Exception as e:
    print("  (og text skipped:", e, ")")

# ---------- social preview ----------
# 1280x640: GitHub's social-preview size, and what LinkedIn crops cleanly. Without it every shared
# link renders as a blank grey card.
print("\n  (public/og-image.png is generated separately: python3 scripts/make-og-image.py)")
