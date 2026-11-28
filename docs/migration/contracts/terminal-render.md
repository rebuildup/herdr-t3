# Contract: terminal render scene (B5)

Version: 1. Scope: the DOM-free paint-scene produced from a
`GhosttySession`'s styled runs — row cache, dirty tracking, per-band
compositing order, text batching, selection/search/cursor overlays,
Kitty image placement, and `background-image` fitting. This is the
behavioral spec both the Canvas2D renderer (`renderer.ts`) and the Rust
`crates/terminal-render` implement; pixel output is verified through
ui-conformance, op-stream equality through the differential harness.

The scene emits an ordered list of paint ops per `render()`. Each op
carries its full paint state (color, font, alpha, optional clip rect)
so runtimes need no canvas-state memory to reproduce it.

## Operations

`collect()`:

- metrics unset → returns false, emits nothing.
- row cache empty → `session.frameAll` fills every row and marks all
  pending; else `session.frame` (dirty rows only) updates the cache and
  marks those rows pending; returns the engine's changed flag.
- `placedImages()` non-null → replaces the image set and marks **every**
  viewport row pending (an image can span rows).
- `invalidate()` clears the row cache and pending set (scroll, resize,
  theme change); next `collect()` repaints everything.

`render()`:

- For each repainted row `y` (pending set in insertion order; **all**
  rows `0..rows-1` when any image is placed):
  1. `clear` the row band.
  2. `fill_rect` band with `background` at `bgAlpha =
     bgOpacity * (1 - clamp(bgImage?.opacity ?? 0))`.
  3. `push`-equivalent: background image drawn clipped to the band at
     `imageAlpha = bgImage ? clamp(bgImage.opacity * bgOpacity) : 0`
     (skipped when alpha ≤ 0 or no image).
  4. Kitty images on layer 0 clipped to the band.
  5. Row backgrounds: one `fill_rect` per run with `bg`, width =
     `sum(cell.wide ? 2 : 1) * cellW`.
  6. Kitty images on layer 1 clipped to the band.
  7. Row text (below).
  8. Kitty images on layer 2 clipped to the band.
- Pending set cleared. Overlay ops appended for the overlay layer:
  clear, selection wash (+ transient fx ops), search-match washes,
  cursor.

Row text, per run (skipped entirely when `flags & INVISIBLE`):

- `fg = run.fg ?? foreground`; `bg = run.bg ?? background`;
  `color = INVERSE ? bg : fg`.
- Font string: `(ITALIC ? "italic " : "") + (BOLD ? "bold " : "") +
  `${fontSize}px ${fontFamily}``, cached per bold/italic pair.
- Alpha: `FAINT ? 0.5 : 1`.
- Cells join into one `fill_text` at the segment's start x while
  `|measure(cell.text, font) - step| <= 0.02` where
  `step = (wide ? 2 : 1) * cellW`; a failing cell flushes the segment
  and — unless its text is `" "` — emits its own `fill_text` at its
  exact cell x. x always advances by cell steps, never glyph width.
- Baseline: `rowTop + (cellH - (ascent + descent)) / 2 + ascent`, ink
  box measured once per `${fontSize}px ${fontFamily}` (no style bits).
- `UNDERLINE_MASK` → `fill_rect` at `baseline + fontSize * 0.15`;
  `STRIKE` → at `baseline - fontSize * 0.3`; height
  `max(1, cellH * 0.06)`, width = run pixel width, color = run color,
  alpha = run alpha.

Kitty image op per placed image intersecting the band:

- `dst = { x: col*cellW + offsetX, y: row*cellH + offsetY, w: width,
  h: height }` (height in px; `y` may span bands — each band clips).
- `src = image.source`; skipped when `source.width/height` is 0 or the
  image's pixels are unavailable (`imagePixels` null).
- Pixel decode/upload is painter-side; the op carries `id` +
  `generation` so painters cache by generation.

Background image (`backgroundDest`, pure geometry):

- `W = cols*cellW`, `H = rows*cellH`; image dims `iw/ih`; invalid dims
  or non-positive surface → no op.
- position fractions: corners/edges/center map to `[0|0.5|1, 0|0.5|1]`,
  default center.
- fit: `stretch` → W×H; `none` → iw×ih; `cover` → max scale;
  `contain` (default) → min scale.
- `tile = repeat && fit !== "cover" && fit !== "stretch"`.
- Non-tile: `draw_image` at `{x: fx*(W-w), y: fy*(H-h), w, h}` when it
  intersects the band. Tile: pattern at the fitted size offset by the
  same position fractions — first tile at `(x, y)`, tiles at `w×h`.
- Alpha: `min(1, max(0, spec.opacity * bgOpacity))`.

Overlay (always repaints fully):

- Transient selection response (issue #441): `setSelectionFx(fx)` stores
  a host-clocked `SelectionFx` — `{kind:"enter"|"commit"|"copy",
  progress}` tracking the live selection, or `{kind:"clear", progress,
  range}` carrying its own history-coordinate range. `progress` is
  linear [0,1]; the scene owns the curves: `enter` multiplies the
  selection-wash alpha by `easeOutCubic(p)` (boundary geometry is never
  delayed), `commit` adds a second wash at `0.55 * 4p(1-p)`, `copy`
  adds a `0.85 * 4p(1-p)` accent strip (`max(1, cellH*0.12)` tall) along
  the bottom edge of each selected row segment in `options.cursor`,
  and `clear` washes `fx.range` at `1 - p` after the selection is gone.
  `progress >= 1` converges to the base frame. `invalidate()` drops the
  fx; `setSelectionFx(null)` clears it. `renderOverlay()` returns the
  overlay ops only so a host can repaint just that layer between full
  frames.
- Selection wash then each search highlight, color
  `options.selection ?? "rgba(120,160,255,0.28)"` /
  `options.search ?? "rgba(250,204,21,0.22)"`.
- `eachCell`: rows `max(start.y, viewportTop)..min(end.y,
  viewportTop+rows-1)`; per row `from = y==start.y ? start.x : 0`,
  `to = y==end.y ? end.x : cols-1`; skip when `to < from`.
- Cursor when `cursorOn` and `cursorState().visible` and
  `x < cols && y < rows`. A cursor on a wide character's tail column
  (`wideTail`) is normalized to the head column and covers both cells;
  a cursor on a wide head cell covers both cells the same way.
  Cursor colours resolve `cursor-color`/`cursor-text` specs against
  the cursor cell's effective fg/bg (post-INVERSE): the keywords
  `cell-foreground`/`cell-background` name those colours, anything else
  is a literal CSS colour; unset `cursor-text` defaults to `background`.
  `bar` → fill `max(2, cellW*0.12) × cellH` at the head column;
  `underline` → `cellW × max(1, cellH*0.12)` at `y + cellH*0.82`;
  `hollow` → stroke rect inset 0.5 spanning the covered cells, width 1;
  `block` (default) → opaque `fill_rect` of the covered cells in the
  cursor colour at alpha 1, then each covered cell's grapheme redrawn
  as `fill_text` in the cursor-text colour at alpha 1 (skipped for
  spaces, empty text and INVISIBLE runs; the run's bold/italic font
  and exact cell x are kept). This is the Ghostty inversion cursor —
  the former alpha-0.35 wash was removed in issue #382.

## Metrics provider

Scene logic never touches DOM. Text measurement is injected:

- `measure(text, font) → advance width` — used by the batching check.
- `box(fontSize, fontFamily) → {ascent, descent}` — used by baseline.

The Canvas2D renderer supplies canvas-backed implementations; tests
and the differential harness supply deterministic fakes.

## Errors

- Session dead → `collect()` propagates the session error like
  `session.call` does today.
- Missing metrics/images → collect/render degrade exactly as the
  Canvas2D path does (no rows painted, images skipped).
