#!/usr/bin/env python3
"""Build WebP review artifacts for docs/design/evidence/56/.

Pipeline:
  1. Convert each raw PNG capture to a full-resolution WebP (the committed
     "original" for review; PNGs stay local-only and are gitignored).
  2. Build labeled contact sheets from the WebP sources.
  3. Build side-by-side herdr-t3 vs T3 Code comparisons at matched viewport
     and theme, plus detail crops of the sidebar and topbar for legibility.

Usage: python3 scripts/build-evidence-sheets.py [evidenceDir]
Requires Pillow with WebP support.
"""
import json
import os
import sys
from PIL import Image, ImageDraw

DIR = sys.argv[1] if len(sys.argv) > 1 else "docs/design/evidence/56"
T3 = os.path.join(DIR, "t3")

# (png source, webp target, label) — pngs are raw local captures, webps are committed.
HERDR = [
    ("01-sidebar-populated.png", "01-sidebar-populated", "01 sidebar populated (dark)"),
    ("02-sidebar-collapsed.png", "02-sidebar-collapsed", "02 sidebar collapsed (dark)"),
    ("03-command-palette.png", "03-command-palette", "03 command palette (dark)"),
    ("04-sidebar-context-menu.png", "04-sidebar-context-menu", "04 sidebar context menu (dark)"),
    ("05-tab-context-menu.png", "05-tab-context-menu", "05 tab context menu (dark)"),
    ("07-pane-split.png", "07-pane-split", "07 pane split (asserted: 2 panes)"),
    ("08-pane-zoomed.png", "08-pane-zoomed", "08 pane zoomed (asserted: layout.zoomed)"),
    ("09-dark.png", "09-dark", "09 dark theme"),
    ("10-light.png", "10-light", "10 light theme"),
    ("11-narrow.png", "11-narrow", "11 narrow 480px"),
    ("12-narrow-sheet.png", "12-narrow-sheet", "12 mobile sheet (asserted)"),
]
T3SHOTS = [
    ("t3/t3-01-main.png", "t3/t3-01-main", "T3 main (light)"),
    ("t3/t3-02-palette.png", "t3/t3-02-palette", "T3 palette (light)"),
    ("t3/t3-03-dark.png", "t3/t3-03-dark", "T3 dark"),
    ("t3/t3-04-light.png", "t3/t3-04-light", "T3 light"),
    ("t3/t3-05-palette-dark.png", "t3/t3-05-palette-dark", "T3 palette (dark)"),
    ("t3/t3-06-narrow.png", "t3/t3-06-narrow", "T3 narrow 480px (dark)"),
    ("t3/t3-07-narrow-sheet.png", "t3/t3-07-narrow-sheet", "T3 sheet 480px (dark)"),
    ("t3/t3-08-narrow-sheet-light.png", "t3/t3-08-narrow-sheet-light", "T3 sheet 480px (light)"),
    ("t3/t3-06-narrow-light.png", "t3/t3-06-narrow-light", "T3 narrow 480px (light)"),
]

WEBP_KW = dict(quality=88, method=6)
CELL_W, CELL_H_MAX, LABEL_H, PAD = 960, 620, 26, 8
BG = (24, 24, 27)
MANIFEST = []


def save_webp(im, path, **kw):
    im.save(path, "WEBP", **{**WEBP_KW, **kw})
    MANIFEST.append({
        "file": os.path.relpath(path, DIR),
        "width": im.width,
        "height": im.height,
        "bytes": os.path.getsize(path),
    })


def convert_sources():
    for png, webp_stem, _ in HERDR:
        src = os.path.join(DIR, png)
        if not os.path.exists(src):
            continue
        out = os.path.join(DIR, webp_stem + ".webp")
        im = Image.open(src).convert("RGB")
        save_webp(im, out)
        print(f"convert {png} -> {webp_stem}.webp ({os.path.getsize(src)} -> {os.path.getsize(out)} bytes)")
    for png, webp_stem, _ in T3SHOTS:
        src = os.path.join(DIR, png)
        if not os.path.exists(src):
            continue
        out = os.path.join(DIR, webp_stem + ".webp")
        im = Image.open(src).convert("RGB")
        save_webp(im, out)
        print(f"convert {png} -> {webp_stem}.webp ({os.path.getsize(src)} -> {os.path.getsize(out)} bytes)")


def load(rel, base=DIR):
    if rel.endswith(".png"):
        im = Image.open(os.path.join(base, rel)).convert("RGB")
    else:
        im = Image.open(os.path.join(base, rel + ".webp")).convert("RGB")
    scale = min(CELL_W / im.width, CELL_H_MAX / im.height)
    return im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)


def contact_sheet(items, out, per_row=2):
    cells = []
    for png, stem, label in items:
        im = Image.open(os.path.join(DIR, stem + ".webp")).convert("RGB")
        scale = min(CELL_W / im.width, CELL_H_MAX / im.height)
        cells.append((im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS), label))
    rows = (len(cells) + per_row - 1) // per_row
    cell_h = max(c.height for c, _ in cells) + LABEL_H + PAD
    sheet = Image.new("RGB", (per_row * CELL_W + (per_row + 1) * PAD, rows * cell_h + PAD), BG)
    d = ImageDraw.Draw(sheet)
    for i, (cell, label) in enumerate(cells):
        r, c = divmod(i, per_row)
        x = PAD + c * (CELL_W + PAD)
        y = PAD + r * cell_h
        d.rectangle([x, y, x + CELL_W, y + cell_h - PAD], fill=(40, 40, 44))
        sheet.paste(cell, (x + (CELL_W - cell.width) // 2, y + LABEL_H))
        d.text((x + 6, y + 6), label, fill=(220, 220, 224))
    save_webp(sheet, os.path.join(DIR, out))
    print("wrote", out, sheet.size)


def side_by_side(left_stem, llabel, right_stem, rlabel, out, height=760):
    li = Image.open(os.path.join(DIR, left_stem + ".webp")).convert("RGB")
    ri = Image.open(os.path.join(T3, right_stem + ".webp")).convert("RGB")
    lw = int(li.width * height / li.height)
    rw = int(ri.width * height / ri.height)
    li = li.resize((lw, height), Image.LANCZOS)
    ri = ri.resize((rw, height), Image.LANCZOS)
    w = lw + rw + 24
    h = height + LABEL_H + 16
    sheet = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(sheet)
    sheet.paste(li, (0, LABEL_H + 8))
    sheet.paste(ri, (lw + 24, LABEL_H + 8))
    d.text((6, 4), "herdr-t3: " + llabel, fill=(120, 200, 255))
    d.text((lw + 30, 4), "T3 Code: " + rlabel, fill=(255, 200, 120))
    save_webp(sheet, os.path.join(DIR, out))
    print("wrote", out, sheet.size)


def detail_crop(left_stem, right_stem, box, out, height=900):
    """Crop the same normalized box (x0,y0,x1,y1 in 0..1) from both captures."""
    li = Image.open(os.path.join(DIR, left_stem + ".webp")).convert("RGB")
    ri = Image.open(os.path.join(T3, right_stem + ".webp")).convert("RGB")
    def crop(im):
        w, h = im.size
        return im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    li, ri = crop(li), crop(ri)
    # Keep the combined canvas under the WebP 16383px width limit.
    unit_w = li.width / li.height + ri.width / ri.height
    lh = min(height, int(15000 / unit_w))
    lw = int(li.width * lh / li.height)
    rw = int(ri.width * lh / ri.height)
    rh = int(ri.height * lh / ri.width)
    li = li.resize((lw, lh), Image.LANCZOS)
    ri = ri.resize((rw, rh), Image.LANCZOS)
    sheet = Image.new("RGB", (lw + rw + 24, max(lh, rh) + LABEL_H + 16), BG)
    d = ImageDraw.Draw(sheet)
    sheet.paste(li, (0, LABEL_H + 8))
    sheet.paste(ri, (lw + 24, LABEL_H + 8))
    d.text((6, 4), "herdr-t3 (left) vs T3 Code (right) — detail crop", fill=(220, 220, 224))
    save_webp(sheet, os.path.join(DIR, out))
    print("wrote", out, sheet.size)


def main():
    convert_sources()
    herdr_items = [(p, s, l) for p, s, l in HERDR]
    contact_sheet(herdr_items[:6], "contact-sheet-1.webp")
    contact_sheet(herdr_items[6:], "contact-sheet-2.webp")
    contact_sheet([(p, s, l) for p, s, l in T3SHOTS], "contact-sheet-t3.webp")

    side_by_side("10-light", "main, light", "t3-04-light", "main, light", "cmp-main-light.webp")
    side_by_side("09-dark", "main, dark", "t3-03-dark", "main, dark", "cmp-main-dark.webp")
    side_by_side("03-command-palette", "command palette, dark", "t3-05-palette-dark", "command palette, dark", "cmp-palette-dark.webp")
    side_by_side("11-narrow", "narrow 480px, light", "t3-06-narrow-light", "narrow 480px, light", "cmp-narrow-light.webp")
    side_by_side("12-narrow-sheet", "mobile sheet, light", "t3-08-narrow-sheet-light", "mobile sheet, light", "cmp-sheet-light.webp")

    # Detail crops (normalized boxes) for legibility checks on the main pair.
    detail_crop("10-light", "t3-04-light", (0.0, 0.0, 0.30, 1.0), "crop-sidebar-light.webp")
    detail_crop("10-light", "t3-04-light", (0.0, 0.0, 1.0, 0.12), "crop-topbar-light.webp")
    detail_crop("09-dark", "t3-03-dark", (0.0, 0.0, 0.30, 1.0), "crop-sidebar-dark.webp")

    with open(os.path.join(DIR, "manifest.json"), "w") as f:
        json.dump(MANIFEST, f, indent=2)
        f.write("\n")
    total = sum(m["bytes"] for m in MANIFEST)
    print(f"manifest: {len(MANIFEST)} files, {total/1048576:.1f} MiB total")


if __name__ == "__main__":
    main()
