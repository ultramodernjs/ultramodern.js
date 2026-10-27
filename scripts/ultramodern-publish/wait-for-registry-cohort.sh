#!/usr/bin/env bash
# Consumers: published ERP-10 and Tractor acceptance, each with its own registry gate.
set -euo pipefail

release_dir="$1"
publish_concurrency="$2"
# Tractor's mise environment may select a different Node on PATH after setup.
# Preserve the interpreter already bound to the accepted release toolchain.
acceptance_node="${ULTRAMODERN_ACCEPTANCE_NODE:-node}"
# The verifier resolves npm through PATH even when Node is absolute. Keep
# npm from the same accepted installation ahead of Tractor's mise toolchain.
if [[ -n "${ULTRAMODERN_ACCEPTANCE_NODE:-}" ]]; then
  PATH="$(dirname "$acceptance_node"):$PATH"
  export PATH
fi
read_release() {
  "$acceptance_node" -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).release[process.argv[2]])' \
    "$release_dir/manifest.json" "$1"
}
version="${3-$(read_release version)}"
tag="${4-$(read_release tag)}"

for attempt in {1..12}; do
  # A fresh verifier process per attempt cannot reuse stale registry metadata.
  if "$acceptance_node" "$(dirname "${BASH_SOURCE[0]}")/prepare-bleedingdev-packages.mjs" \
    --publish-existing \
    --dry-run \
    --out "$release_dir" \
    --version "$version" \
    --tag "$tag" \
    --publish-concurrency "$publish_concurrency"; then
    exit 0
  fi
  if [[ "$attempt" == "12" ]]; then
    echo "Exact registry cohort did not become verifiable" >&2
    exit 1
  fi
  sleep 15
done
