---
name: apply-design-md
description: >
  Apply a brand design system from VoltAgent/awesome-design-md.
  Use when the user names a brand look (Linear, Stripe, Vercel, Notion, Nike,
  and the other brands in brands.json), says DESIGN.md, "desain seperti",
  "pakai design", or asks to add the awesome-design-md plugin.
---

# Apply a brand DESIGN.md

The visual source is VoltAgent/awesome-design-md (MIT), https://github.com/VoltAgent/awesome-design-md. Those files are analyses of public sites. They are not a license to copy logos, photographs, or proprietary fonts. Use the documented fallback typeface.

## Pick a brand

1. Read `brands.json` next to this skill. Match the user's words against `slug`, `name`, and `aliases`.
2. If several brands match, list the closest ones and ask which to use. Do not guess.
3. If none match, say so and offer three nearby names from the catalog.

## Load the system

Prefer the project script, from the repo root:

python3 scripts/fetch-design.py <slug>

That writes `DESIGN.md` and `.design-source.json`. If the script is unavailable, download:

https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/<slug>/DESIGN.md

Read the whole file before changing UI. Treat it as the spec: front matter tokens, color roles, type scale, components, layout, elevation, do's and don'ts, and responsive behavior.

## Implement

- Map tokens onto AutoSNAP Studio. The variables live in `app/globals.css`: `--primary`, `--primary-hover`, `--primary-soft`, `--background`, `--surface`, `--sidebar`, `--text-primary`, `--text-secondary`, `--border`, and `--radius`. Keep the existing classes (`card`, `primary-button`, `secondary-button`, `app-shell`). Do not add shadcn or another component library unless the user asked for shadcn blocks.
- Use the font fallback named in the file. Load it once (for example `next/font` or a single font link).
- Follow the Don't list. One accent, the documented surfaces, the documented radius. No extra gradient, glow, or second brand color.
- Cover empty, loading, and error states with the same surfaces and type, not a separate style.
- Check a phone-width layout against the file's breakpoints.

## Leave a trail

After a successful fetch, `DESIGN.md` at the project root is the active system. Later UI work reads that file instead of fetching again, unless the user names a different brand.
