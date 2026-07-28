#!/usr/bin/env bash
#
# Regenerates every binary asset in public/ from the SVG sources next to this script, so the
# committed PNGs are reproducible rather than mystery blobs.
#
# Needs librsvg and ImageMagick, plus the Space Grotesk and JetBrains Mono families the site
# already loads:
#   brew install librsvg imagemagick
#
# Usage: packages/web/assets-src/render.sh
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$src/../public"

png() { rsvg-convert -w "$2" -h "$2" "$src/$1" -o "$3"; }

mkdir -p "$out/favicon"

cp "$src/icon-rounded.svg" "$out/favicon/favicon.svg"

# The tab favicon. icon-small drops the hairline border and fattens the bolt, both of which are
# the difference between a mark and a smudge at 16px.
for size in 16 32 48; do
  png icon-small.svg "$size" "/tmp/hypefuel-ico-$size.png"
done
magick /tmp/hypefuel-ico-16.png /tmp/hypefuel-ico-32.png /tmp/hypefuel-ico-48.png \
  "$out/favicon/favicon.ico"

png icon-rounded.svg 96 "$out/favicon/favicon-96x96.png"

# iOS and Android round the corners themselves, so these use the full-bleed square.
png icon-square.svg 180 "$out/favicon/apple-touch-icon.png"
png icon-square.svg 192 "$out/favicon/web-app-manifest-192x192.png"
png icon-square.svg 512 "$out/favicon/web-app-manifest-512x512.png"

# Social card. Twitter and Facebook both re-encode this, so favour a clean source over a small one.
rsvg-convert -w 1200 -h 630 "$src/og-image.svg" -o "$out/og-image.png"
magick "$out/og-image.png" -strip -quality 92 "$out/og-image.png"

echo "wrote:"
find "$out" -name '*.png' -o -name '*.ico' -o -name '*.svg' | sort | sed "s|$out|  public|"
