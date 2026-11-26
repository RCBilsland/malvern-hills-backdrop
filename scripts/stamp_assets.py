"""Add a content hash to each local stylesheet and script link in the demo pages.

Browsers (mobile Safari especially) may reuse a cached copy of a file for a
while after it changes; GitHub Pages allows 10 minutes. A page could then pair
new HTML with an old script. Stamping each link with ?v=<hash of the file>
gives every changed file a new URL, so a fresh page always fetches the files
that match it.

Run after changing any component file, before committing:
    python3 scripts/stamp_assets.py
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ["index.html", "ridges.html"]
LINK = re.compile(r'(?P<attr>(?:href|src))="(?P<path>[^"?#:]+\.(?:css|js))(?:\?v=[0-9a-f]+)?"')


def stamp(match: re.Match) -> str:
    path = ROOT / match["path"]
    if not path.is_file():
        return match[0]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
    return f'{match["attr"]}="{match["path"]}?v={digest}"'


def main() -> None:
    for name in PAGES:
        page = ROOT / name
        before = page.read_text()
        after = LINK.sub(stamp, before)
        if after != before:
            page.write_text(after)
        for m in LINK.finditer(after):
            print(f"{name}: {m['path']}")


if __name__ == "__main__":
    main()
