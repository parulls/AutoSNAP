---
name: apply-design
description: Pin a brand DESIGN.md and restyle the UI to match it
---

Follow the `apply-design-md` skill.

The argument is a brand slug or name, for example `linear`, `stripe`, or `vercel`. Resolve it with `brands.json`, run `python3 scripts/fetch-design.py <slug>` from the repo root, read the downloaded `DESIGN.md`, and apply it to the UI you are about to change.

If no argument was given, ask which brand.
