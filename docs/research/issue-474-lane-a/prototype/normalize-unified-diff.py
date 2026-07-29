#!/usr/bin/env python3
"""Recalculate unified-diff hunk counts without changing patch content."""

from __future__ import annotations

import re
import sys
from pathlib import Path

HUNK_RE = re.compile(
    r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$"
)


def normalize(lines: list[str]) -> list[str]:
    output: list[str] = []
    index = 0

    while index < len(lines):
        line = lines[index]
        match = HUNK_RE.match(line.rstrip("\n"))
        if match is None:
            output.append(line)
            index += 1
            continue

        old_start, _, new_start, _, suffix = match.groups()
        hunk: list[str] = []
        index += 1
        while index < len(lines):
            candidate = lines[index]
            if HUNK_RE.match(candidate.rstrip("\n")) or candidate.startswith("diff --git "):
                break
            hunk.append(candidate)
            index += 1

        old_count = sum(
            1 for candidate in hunk if candidate.startswith((" ", "-"))
        )
        new_count = sum(
            1 for candidate in hunk if candidate.startswith((" ", "+"))
        )
        output.append(
            f"@@ -{old_start},{old_count} +{new_start},{new_count} @@{suffix}\n"
        )
        output.extend(hunk)

    return output


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} INPUT OUTPUT", file=sys.stderr)
        return 2

    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    destination.write_text(
        "".join(normalize(source.read_text().splitlines(keepends=True)))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
