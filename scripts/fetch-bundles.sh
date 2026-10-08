#!/usr/bin/env bash
# Download Concur's public web-app bundles (the only GraphQL schema source —
# introspection is disabled) so scripts/extract-ops.mjs can pull operation text.
#   scripts/fetch-bundles.sh <outdir>
# Hashes rotate with Concur releases; refresh the list from a signed-in tab's
# performance.getEntriesByType('resource') when a 404 appears.
set -euo pipefail
out="${1:?usage: fetch-bundles.sh <outdir>}"
mkdir -p "$out/spend" "$out/travel"
base=https://static.concursolutions.com
for f in runtime.955955c1ad61516f8f5c 7040.dd78cd294cad986f4a04 2454.3fb05e7c1298471cff96 \
         3108.f49d3921950c92561e27 1590.80930a7ddf7150d78718 6883.c71dfc2369e5dfac931e \
         7575.24faf842e76c1f6cd068 expense.3b3df53ab78fdb7d9e86 1895.7f7adbea79abee37e90f \
         1442.5bfc611f8227992adfae; do
  curl -fsS -o "$out/spend/$f.js" "$base/nui/expense/release/$f.js"
done
curl -fsS -o "$out/travel/main.js" "$base/t2-ui/nui-trip/static/main.bundle.c10a387211d59a563a5e.js"
echo "bundles in $out — e.g. node scripts/extract-ops.mjs $out/spend out.graphql GetAuditTrails"
