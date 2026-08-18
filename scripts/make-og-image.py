#!/usr/bin/env python3
"""Build the GitHub repo social-preview card (public/og-image.png).

GitHub crops and scales this per-surface — the repo page, link unfurls in Slack/WhatsApp/LinkedIn,
even og:image at other sizes — so nothing load-bearing can sit at the edge. GitHub's own guidance is
a 40pt safe margin; this uses a wider one because a repo card gets cropped more aggressively than
GitHub's own template implies (Twitter's summary_large_image, in particular, crops tighter than
1280x640 before scaling back down).

Same design system as the site (recovered from site/style.css before the site moved to its own
repo): cream ground, near-black ink, a single lime accent, ui-monospace headline. The mark uses full
colour rather than the nav's ink silhouette — for the same reason the favicon does: at a size where
someone is recognising the brand at a glance rather than reading a wordmark next to running text,
colour carries further than restraint.

    python3 scripts/make-og-image.py
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "assets", "brand", "jobseeker-master.webp")
OUT = os.path.join(ROOT, "public", "og-image.png")

W, H = 1280, 640
# GitHub says 40pt; this project's own hero used the same "leave real air" instinct at every other
# size (the icon crops, the logo alpha fix), so the margin here is doubled rather than run to the
# recommended minimum.
MARGIN = 76

CREAM = (245, 243, 238)
INK = (17, 17, 17)
MUTED = (107, 104, 98)
RULE = (216, 212, 202)
ACCENT = (214, 248, 76)

MONO = "/System/Library/Fonts/SFNSMono.ttf"  # first pick in the site's ui-monospace stack on macOS


def font(size, weight="Bold"):
    f = ImageFont.truetype(MONO, size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def text_w(draw, s, f):
    return draw.textlength(s, font=f)


def main():
    img = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(img)

    # ---------- wordmark, top-left ----------
    mark = Image.open(MASTER).convert("RGBA")
    bbox = mark.getchannel("A").getbbox()
    mark = mark.crop(bbox)
    mark_h = 56
    mark = mark.resize((round(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    mark_y = MARGIN
    img.paste(mark, (MARGIN, mark_y), mark)

    f_word = font(30)
    word = "JOBSEEKER"
    # Letter-spaced, matching the site nav's 0.18em tracking — PIL has no tracking primitive, so
    # each glyph is placed by hand.
    tracking = 6
    x = MARGIN + mark.width + 20
    ty = mark_y + (mark_h - f_word.size) // 2 - 4
    for ch in word:
        d.text((x, ty), ch, font=f_word, fill=INK)
        x += text_w(d, ch, f_word) + tracking

    # ---------- headline ----------
    f_h1 = font(74)
    line1 = "Your job search,"
    line2 = "remembered."
    hy = 210
    d.text((MARGIN, hy), line1, font=f_h1, fill=INK)
    hy2 = hy + 92
    w2 = text_w(d, line2, f_h1)
    pad = 14
    # The accent highlight block, matching h1 mark on the site — drawn first so the ink text sits
    # on top of it, not the other way round.
    asc, desc = f_h1.getmetrics()
    d.rectangle([MARGIN - pad, hy2 - 6, MARGIN + w2 + pad, hy2 + asc + desc - 2], fill=ACCENT)
    d.text((MARGIN, hy2), line2, font=f_h1, fill=INK)

    # ---------- subhead ----------
    f_sub = font(27, weight="Regular")
    sub1 = "Reads your email, chats and calendar. Tells you what needs you"
    sub2 = "today. Never applies or sends without your approval."
    sy = hy2 + asc + 46
    d.text((MARGIN, sy), sub1, font=f_sub, fill=MUTED)
    d.text((MARGIN, sy + 40), sub2, font=f_sub, fill=MUTED)

    # ---------- footer rule + repo path ----------
    fy = H - MARGIN - 34
    d.rectangle([MARGIN, fy, MARGIN + 150, fy + 4], fill=ACCENT)
    f_repo = font(24)
    d.text((MARGIN, fy + 18), "github.com/cventour/jobseeker", font=f_repo, fill=INK)

    img.save(OUT, optimize=True)
    print(f"wrote {os.path.relpath(OUT, ROOT)}  {img.size[0]}x{img.size[1]}  {os.path.getsize(OUT)/1024:.1f} KB")


if __name__ == "__main__":
    main()
