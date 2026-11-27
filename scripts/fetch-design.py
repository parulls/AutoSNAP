#!/usr/bin/env python3
"""Pin a brand DESIGN.md from VoltAgent/awesome-design-md."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = ROOT / ".cursor" / "skills" / "apply-design-md" / "brands.json"


def load_catalog() -> dict:
    try:
        return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"Brand catalog not found: {CATALOG_PATH}", file=sys.stderr)
        return {}
    except json.JSONDecodeError as exc:
        print(f"Brand catalog is not valid JSON: {exc}", file=sys.stderr)
        return {}


def keys_for(brand: dict) -> list[str]:
    values = [brand.get("slug", ""), brand.get("name", "")]
    aliases = brand.get("aliases") or []
    if isinstance(aliases, list):
        values.extend(aliases)
    seen: set[str] = set()
    keys: list[str] = []
    for value in values:
        if not isinstance(value, str) or not value or value in seen:
            continue
        seen.add(value)
        keys.append(value)
    return keys


def resolve(query: str, brands: list[dict]) -> list[dict]:
    needle = query.strip()
    if not needle:
        return []
    folded = needle.lower()
    exact = [
        brand
        for brand in brands
        if any(key.lower() == folded for key in keys_for(brand))
    ]
    if exact:
        return exact
    if len(needle) < 3:
        return []
    return [
        brand
        for brand in brands
        if any(folded in key.lower() for key in keys_for(brand))
    ]


def raw_url(catalog: dict, slug: str) -> str:
    base = str(catalog.get("rawBase", "")).rstrip("/")
    return f"{base}/{slug}/DESIGN.md"


def safe_slug(slug: str) -> bool:
    if not slug or slug in {".", ".."} or "/" in slug or "\\" in slug:
        return False
    if slug.startswith("."):
        return False
    return True


def print_matches(query: str, matches: list[dict]) -> None:
    print(f"Multiple brands match {query!r}:", file=sys.stderr)
    for brand in matches:
        print(f"  {brand.get('slug')}\t{brand.get('name')}", file=sys.stderr)


def cmd_list(brands: list[dict]) -> int:
    for brand in brands:
        print(f"{brand.get('slug')}\t{brand.get('name')}\t{brand.get('category')}")
    return 0


def download(url: str) -> bytes | None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "AutoSNAP-design-kits"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        print(f"Download failed ({exc.code}) for {url}", file=sys.stderr)
    except urllib.error.URLError as exc:
        print(f"Download failed for {url}: {exc.reason}", file=sys.stderr)
    return None


def write_outputs(out_path: Path, content: bytes, meta: dict) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = out_path.with_name(out_path.name + ".part")
    try:
        temporary.write_bytes(content)
        temporary.replace(out_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    source = out_path.parent / ".design-source.json"
    source.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch a brand DESIGN.md")
    parser.add_argument("brand", nargs="?", help="Brand slug, name, or alias")
    parser.add_argument("--list", action="store_true", help="List brands in the catalog")
    parser.add_argument(
        "--out",
        default="DESIGN.md",
        help="Where to write DESIGN.md (default: DESIGN.md)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the raw DESIGN.md URL and do not write files",
    )
    args = parser.parse_args(argv)

    catalog = load_catalog()
    if not catalog:
        return 1
    brands = catalog.get("brands") or []
    if not isinstance(brands, list):
        print("Brand catalog has no brands list.", file=sys.stderr)
        return 1

    if args.list:
        return cmd_list(brands)

    if not args.brand:
        parser.print_usage(sys.stderr)
        return 1

    matches = resolve(args.brand, brands)
    if not matches:
        print(f"No brand matches {args.brand!r}.", file=sys.stderr)
        return 1
    if len(matches) > 1:
        print_matches(args.brand, matches)
        return 2

    brand = matches[0]
    slug = str(brand.get("slug", ""))
    if not safe_slug(slug):
        print(f"Refusing unsafe slug {slug!r}.", file=sys.stderr)
        return 1

    url = raw_url(catalog, slug)
    if args.dry_run:
        print(url)
        return 0

    content = download(url)
    if content is None:
        return 1

    meta = {
        "slug": slug,
        "name": brand.get("name"),
        "url": url,
        "upstream": catalog.get("source"),
    }
    write_outputs(Path(args.out), content, meta)
    print(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
