#!/usr/bin/env python3
"""Build contact sheets and side-by-side comparisons for PR #62 evidence.

Usage: python3 scripts/build-evidence-sheets.py <evidenceDir>
Writes contact-sheet-*.png and cmp-*.png next to the captures.
"""
import os
import sys
from PIL import Image, ImageDraw

DIR = sys.argv[1] if len(sys.argv) > 1 else "docs/design/evidence/56"
T3 = os.path.join(DIR, "t3")

# (file, label) in display order
HERDR = [
    ("01-sidebar-populated.png", "01 sidebar populated (dark)"),
    ("02-sidebar-collapsed.png", "02 sidebar collapsed (dark)"),
    ("03-command-palette.png", "03 command palette (dark)"),
    ("04-sidebar-context-menu.png", "04 sidebar context menu (dark)"),
    ("05-tab-context-menu.png", "05 tab context menu (dark)"),
    ("07-pane-split.png", "07 pane split (asserted: 2 panes)"),
    ("08-pane-zoomed.png", "08 pane zoomed (asserted: layout.zoomed)"),
    ("09-dark.png", "09 dark theme"),
    ("10-light.png", "10 light theme"),
    ("11-narrow.png", "11 narrow 480px"),
    ("12-narrow-sheet.png", "12 mobile sheet (asserted)"),
]
T3SHOTS = [
    ("t3/t3-01-main.png", "T3 main (light)"),
    ("t3/t3-02-palette.png", "T3 palette (light)"),
    ("t3/t3-03-dark.png", "T3 dark"),
    ("t3/t3-04-light.png", "T3 light"),
    ("t3/t3-05-palette-dark.png", "T3 palette (dark)"),
    ("t3/t3-06-narrow.png", "T3 narrow 480px (dark)"),
    ("t3/t3-07-narrow-sheet.png", "T3 sheet 480px (dark)"),
    ("t3/t3-08-narrow-sheet-light.png", "T3 sheet 480px (light)"),
    ("t3/t3-06-narrow-light.png", "T3 narrow 480px (light)"),
]

CELL_W, CELL_H_MAX, LABEL_H, PAD = 960, 620, 26, 8
BG = (24, 24, 27)


def load(rel, base=DIR):
    im = Image.open(os.path.join(base, rel)).convert("RGB")
    scale = min(CELL_W / im.width, CELL_H_MAX / im.height)
    return im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)


def contact_sheet(items, out, per_row=2):
    cells = [load(f) for f, _ in items]
    labels = [l for _, l in items]
    rows = (len(cells) + per_row - 1) // per_row
    cell_h = max(c.height for c in cells) + LABEL_H + PAD
    sheet = Image.new("RGB", (per_row * CELL_W + (per_row + 1) * PAD, rows * cell_h + PAD), BG)
    d = ImageDraw.Draw(sheet)
    for i, (cell, label) in enumerate(zip(cells, labels)):
        r, c = divmod(i, per_row)
        x = PAD + c * (CELL_W + PAD)
        y = PAD + r * cell_h
        d.rectangle([x, y, x + CELL_W, y + cell_h - PAD], fill=(40, 40, 44))
        sheet.paste(cell, (x, y + LABEL_H))
        d.text((x + 6, y + 6), label, fill=(220, 220, 224))
    sheet.save(os.path.join(DIR, out))
    print("wrote", out, sheet.size)


def side_by_side(left, llabel, right, rlabel, out, height=760):
    li = Image.open(os.path.join(DIR, left)).convert("RGB")
    ri = Image.open(os.path.join(T3, right) if not right.startswith("t3/") else os.path.join(DIR, right)).convert("RGB")
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
    sheet.save(os.path.join(DIR, out))
    print("wrote", out, sheet.size)


def main():
    # Contact sheets: herdr states split into two readable sheets, T3 refs one.
    contact_sheet(HERDR[:6], "contact-sheet-1.png")
    contact_sheet(HERDR[6:], "contact-sheet-2.png")
    contact_sheet(T3SHOTS, "contact-sheet-t3.png")

    # Side-by-side comparisons at matching viewport (1440x900) and theme.
    side_by_side("10-light.png", "main, light", "t3-04-light.png", "main, light", "cmp-main-light.png")
    side_by_side("09-dark.png", "main, dark", "t3-03-dark.png", "main, dark", "cmp-main-dark.png")
    side_by_side("03-command-palette.png", "command palette, dark", "t3-05-palette-dark.png", "command palette, dark", "cmp-palette-dark.png")
    side_by_side("11-narrow.png", "narrow 480px, light", "t3-06-narrow-light.png", "narrow 480px, light", "cmp-narrow-light.png")
    side_by_side("12-narrow-sheet.png", "mobile sheet, light", "t3-08-narrow-sheet-light.png", "mobile sheet, light", "cmp-sheet-light.png")


if __name__ == "__main__":
    main()
