#!/usr/bin/env bash
# NeverLate Plaksha-only release packager — ships ONLY intentional extension files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])" 2>/dev/null || echo "dev")"
OUT="NeverLate-Plaksha-v${VERSION}.zip"
rm -f "$OUT"

# Explicit allow-list: never ship dev metadata even if present on disk.
zip -r "$OUT" \
  manifest.json \
  background.js \
  scripts/moodle-api.js \
  scripts/content.js \
  popup/popup.html \
  popup/popup.css \
  popup/popup.js \
  privacy.html \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png \
  LICENSE \
  PRIVACY.md \
  README.md \
  -x "__MACOSX/*" "*/.DS_Store" ".DS_Store"

echo "Built $OUT"
unzip -l "$OUT"
