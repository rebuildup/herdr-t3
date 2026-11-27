# hoxay brand identity

Decision date: 2026-11-27. Status: maintainer-selected brand name and symbol; visual direction accepted for further production. This document is the brand source of truth, not authorization to change existing architectural or release contracts.

## Product identity

**hoxay** is the independent brand for the successor to herdr-t3. The long-term ambition is a globally recognizable integrated agent development environment, combining terminals, AI agents, Git, projects and local/remote development. Native-first, lightweight Rust implementation with a Web fallback is the intended direction, not a claim that all capabilities have shipped. Existing accepted architecture ADRs and migration gates remain authoritative for implementation.

The lineage is herdr's agent orchestration and terminal-oriented identity, and T3 Code's interaction and visual quality. Retain third-party attribution and distinguish hoxay from official upstream products. The aim is an independent product, not indefinite imitation of either upstream.

Working descriptor: **The agent development environment.** This is not a finalized marketing tagline.

## Name and wordmark

- Selected name: `hoxay`, preferably lowercase. Five letters, intended two syllables (HOX-ay, ホクセイ / ホクセー). Japanese readers may also associate it with ホクサイ and Katsushika Hokusai. This is a cultural association, not a claimed etymology or official connection.
- The name is deliberately independent of a literal animal name or shell metaphor. The mascot supplies the visual identity.
- Preserve the word's visual rhythm: the ascender of h, descender of y, curved o/a, and central crossing of x. A custom wordmark remains to be designed; no font is mandated.
- CLI candidate: `hxy`. Not approved or cleared. Trademark, similar names (including Hoxai/Hoxey), domains, package and organization names remain subject to clearance; no claim of global exclusivity is made.

## Symbol — selected Rikyū concept 1

![Selected symbol](originals/hoxay-sea-turtle-symbol-concept-1.svg)

A swimming sea turtle, built from interlocking geometric curves and negative space, with a terminal prompt `>_` integrated as the face. The animal is a standalone identity, comparable in role (not appearance) to Docker's whale or Linux's penguin. The terminal face carries forward the idea of herdr's mascot without making a simple animal substitution.

The sea turtle represents movement, freedom and fluidity rather than a slow land tortoise. Japanese and near-future qualities are expressed through abstraction, precise geometry, controlled asymmetry, balance, dynamic curves, and deliberate negative space. Hokusai, ukiyo-e and Japanese heraldic design are cultural references, not illustrations to reproduce. No Fuji, red sun, waves, or other literal Japanese scenery is required in the mark.

The selected design is Rikyū's concept 1, supplied by the maintainer. The symbol SVG is the master geometry. Construction and outline SVGs document the design process. The approved shape is not a placeholder to redraw.

## Visual tone — latest decision

- Monochrome first: black, white and neutral gray dominate. The mark must work in single-color positive and reversed applications.
- Aim for the restrained, high-contrast tone of T3 Code, rather than pastel or prominently saturated branding. A very weak color gradient may be used as a secondary surface treatment; a fixed accent hue is not yet selected.
- The app-icon exploration converged on a white symbol over a near-black rounded-square surface with soft frontal, centrally balanced illumination. Avoid a directional highlight or gradient emanating from the upper-right corner. Avoid conspicuous blue-green/teal coloration; do not treat the earlier teal concepts as the accepted palette.
- The last monochrome icon rendering was accepted as a visual direction, not as replacement master geometry or production-ready packaging artwork.
- Avoid neon, decorative sci-fi effects, conspicuous gradients, ornamental scenery, generic hexagonal technology motifs, or over-cute character styling. The mark, not the effects, should be recognizable.

## Production and source hierarchy

1. Use the supplied symbol SVG as the canonical geometry. Do not trace, approximate, regenerate with image models, or independently recreate its paths. Recoloring, inversion, scaling and placement are allowed as derived treatments, while the original is preserved unchanged.
2. The construction/outline SVGs explain the geometry; neither supersedes the symbol master. Preserve the supplied files as immutable originals.
3. The poster and approved app-icon rendering are reference images, not geometry masters. Produce final OS assets from the master vector, using the accepted visual direction. OS icon derivation is implemented by `scripts/generate-brand-icons.ts`: white recolor of the master mark on the accepted near-black rounded-square surface with soft frontal centered illumination, rasterized to `build/icon.png`/`.icns`/`.ico`. `docs/brand/icon-manifest.json` binds master→derived→distributable SHA-256 hashes; `scripts/check-brand-icons.ts` (wired into `scripts/ci.sh`) verifies format, builder resolution, and manifest provenance. Regenerate with `bun scripts/generate-brand-icons.ts` (requires `rsvg-convert`, `iconutil` on macOS).
4. Ensure positive/reversed monochrome, small-size legibility (including 16 px as a design target), and consistent recognition across desktop, Web, CLI, GitHub and documentation. Validate actual sizes before shipping; no such validation is claimed here.
5. Keep future exports, wordmark, motion, color tokens, icon containers and usage rules distinct from originals. Avoid visual confusion with Atuin and TortoiseGit. Exact padding, optical adjustment, palette, motion and OS-specific assets are open design tasks.
6. Maintain provenance and existing third-party notices. Brand adoption alone neither changes license terms nor grants third-party affiliation or clearance.

## Original assets and references

The original SVGs below are stored byte-for-byte, with Git blob IDs checked against the supplied files. The two binary references are **pending remote upload**: the current connector can read their metadata but cannot transfer the original image bytes. Their original filenames and SHA-256 values are recorded to make subsequent transfer verifiable.

| File | Role | SHA-256 |
| --- | --- | --- |
| [hoxay-sea-turtle-symbol-concept-1.svg](originals/hoxay-sea-turtle-symbol-concept-1.svg) | Canonical mark | `0d353914793981f089e09f0bad2ba994e496a7193848e5b67cbc3fc3f7c67fea` |
| [hoxay-sea-turtle-symbol-concept-1-construction.svg](originals/hoxay-sea-turtle-symbol-concept-1-construction.svg) | Original construction | `f11e70a211178c522ab4c93dde386685079ef26af96eca4200fc1373c69f3811` |
| [hoxay-sea-turtle-symbol-concept-1-outline.svg](originals/hoxay-sea-turtle-symbol-concept-1-outline.svg) | Original outline | `fe68e2c829a62799eb24d8cd847a2780c5073faca76a1ea4d6b8ac268cdda09c` |
| `hoxay-sea-turtle-symbol-concept-1-poster.jpg` | Rikyū presentation poster; pending | `cfe45071a08caf4e31ba34eae0f24070b7629113d8def671dab366000ceb7189` |
| `a_minimalist_high_contrast_app_icon_on_a_black_ba.png` | Accepted frontal-light monochrome icon reference; pending | `f0e80c64efd515b7db571c8b8451607d7024fa476d34cf0bc65a1a8a8d4f29f0` |

Store binary references under `docs/brand/references/`, preserving the original bytes, then update their status and add links here. The earlier rejected illustrations and directional teal/blue gradients are not accepted production sources.

## Scope of this decision

Selected: brand name, sea-turtle concept 1, integrated prompt face, monochrome-first/frontal-light visual direction. Open: CLI, wordmark, exact color and typography, final icon exports, trademark/domain/package clearance, branding migration schedule and any architectural changes requiring their own ADRs. Repository rename, distribution changes and release promotion are not included in this decision.
