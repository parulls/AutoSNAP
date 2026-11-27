---
name: material-design
description: >
  Apply Material Design 3 to the current UI.
  Use when the user says Material, Material 3, M3, Material You, or desain material.
---

# Material Design 3

Material Design 3 (Material You) is the visual system for this task. The public spec is https://m3.material.io/. Map it onto the controls this repo already has, and say that you are using Material Design 3 before editing.

## In AutoSNAP

Tokens live in `app/globals.css`. Map Material color roles onto those variables:

- Surface → `--background`
- Surface container → `--surface`
- On-surface → `--text-primary`
- On-surface variant → `--text-secondary`
- Primary → `--primary`
- Primary hover → `--primary-hover`
- Outline → `--border`
- Error → `--danger`

Keep `card`, `primary-button`, `secondary-button`, and `app-shell`. Do not install MUI, Material Web, or shadcn for a Material restyle.

Leave `--radius` at `6px` unless the user wants full Material shape, then set `--radius` to `12px`.

Do not use pure black `#000` as the dark surface. Use a dark surface container such as `#1c1b1f`, or the existing `--sidebar` `#0f172a`, so elevation still reads.

## Type scale

Use the public Material 3 type scale. Sizes are font-size / line-height in pixels, then weight.

- Display large: 57/64, weight 400
- Display medium: 45/52, weight 400
- Display small: 36/44, weight 400
- Headline large: 32/40, weight 400
- Headline medium: 28/36, weight 400
- Headline small: 24/32, weight 400
- Title large: 22/28, weight 400
- Title medium: 16/24, weight 500
- Title small: 14/20, weight 500
- Body large: 16/24, weight 400
- Body medium: 14/20, weight 400
- Body small: 12/16, weight 400
- Label large: 14/20, weight 500
- Label medium: 12/16, weight 500
- Label small: 11/16, weight 500

Prefer Roboto, or the font the app already loads. One typeface per screen.

## Shape

Material shape scale, in pixels: 4, 8, 12, 16, 28, and full.

Extra-small is 4, small is 8, medium is 12, large is 16, extra-large is 28, and full is a pill. AutoSNAP controls stay at `--radius: 6px`. Full Material shape sets `--radius` to `12px` for cards and buttons, uses 4 for small chips, 28 for large containers, and full for FABs and pills.

## State layers

Tint the content color over the surface.

- Hover: 8%
- Focus: 12%
- Pressed: 12%

Focus also keeps a visible outline using `--border` or the primary role. Disabled content drops to about 38% opacity. Error states use `--danger`.

## Components

Map this anatomy onto the existing controls. Do not import a Material component package.

- Buttons: filled (`primary-button`), outlined and text (`secondary-button`). Label large, height near `--control-h` (`36px`). State layers on hover, focus, and pressed.
- FAB: a circular primary action, shape full, only when the screen already has one primary action.
- Cards: `card` on `--surface`, outline `--border`, elevation as a soft shadow. Titles use on-surface. Supporting text uses on-surface variant.
- Text fields: filled or outlined. Label on `--text-secondary`, value on `--text-primary`, outline `--border`, error `--danger`. Supporting text uses body small.
- Navigation: `app-shell` sidebar. The active item uses primary at a low state layer. Labels use label medium or label large.
- Top app bar: surface container, title as title large, actions as icon buttons with state layers.
- Dialogs: surface container, headline small, body medium, buttons aligned to the end. The scrim sits over the page.
- Chips: label medium, outline or a low-emphasis primary fill, shape 8 or full.
- Lists: one-line and two-line rows, on-surface title, on-surface variant supporting text, dividers using `--border`.
- Snackbar: a dark inverse surface (not `#000`), a short message, and one action, sitting above the page.

## Layout

Material window size classes:

- Compact: under 600px. One column. Navigation as a bar or a modal drawer.
- Medium: 600–839px. A navigation rail or a narrower sidebar.
- Expanded: 840px and up. Persistent sidebar (`app-shell`) and a wider content pane.

Check the screen you touch at compact width. Keep spacing on a 4px grid.

## One system

This task uses Material Design 3 only. Do not also apply a brand `DESIGN.md` or shadcn blocks on the same screen.
