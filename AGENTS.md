<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Design kits

Keep AutoSNAP Studio in `app/globals.css` unless the user asks for another system.

- Brand look (Linear, Stripe, and the other names in `.cursor/skills/apply-design-md/brands.json`): skill `apply-design-md`. Pin a file with `python3 scripts/fetch-design.py <slug>`.
- Material 3: skill `material-design`.
- shadcn blocks or shadcnblocks.com: skill `shadcn-blocks`.

Use one system at a time. Map it onto the existing CSS variables and classes. Do not add a second component library during ordinary feature work.
