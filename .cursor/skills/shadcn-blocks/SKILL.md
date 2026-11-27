---
name: shadcn-blocks
description: >
  Build or restyle a screen with shadcn blocks.
  Use when the user asks for shadcn, a shadcn/ui block, or a block from
  shadcnblocks.com.
---

# shadcn blocks

Official free blocks are at https://ui.shadcn.com/blocks. The catalog next to this skill is `blocks.json`. shadcnblocks.com is a separate third-party gallery.

## In AutoSNAP

This repo is Tailwind with classes in `app/globals.css`, not a shadcn app. Do not run `npx shadcn init` or add registry blocks unless the user explicitly asked to adopt shadcn. Otherwise build sections with `card`, `primary-button`, `secondary-button`, and `app-shell`.

Install an official block with `npx shadcn@latest add <name>` only after shadcn is adopted. Read `blocks.json` and prefer a block whose `name` and `categories` match the screen. The install string in that file is `npx shadcn@latest add <name>`.

Suggested starts:

- Dashboard: `dashboard-01`
- Sidebar: `sidebar-07` or `sidebar-08`
- Login: `login-03` or `login-02`
- Signup: `signup-05` or `signup-01`

## shadcnblocks.com

shadcnblocks.com is a third-party gallery. Do not scrape or paste its source. Use only the install command shown on a block page (`npx shadcn@latest add @shadcnblocks/<name>`). Do not invent the registry URL.

## Section patterns

Match the section the user named. Replace placeholder content with the product's real copy and states (empty, loading, and error).

- Hero: one headline, one short supporting line, one primary action, and one secondary action.
- Feature grid: a heading and a small set of `card`s, each with a title and one sentence.
- Pricing: a few `card`s, one emphasized with `primary-button`, the others with `secondary-button`.
- Logos: a quiet row of product or partner names on `--surface`.
- FAQ: questions as titles, answers as secondary text, one column.
- CTA: one `card` or band with one headline and one `primary-button`.
- Dashboard: `app-shell`, a page title, summary `card`s, and the existing data states.
- Auth: one `card`, fields, a `primary-button`, and a text link to the other path (login or signup).

## One system

Use one system at a time. Do not combine these blocks with a brand DESIGN.md (`apply-design-md`) or Material 3 (`material-design`) on the same screen. If the user did not ask to adopt shadcn, stay on the AutoSNAP Studio classes.
