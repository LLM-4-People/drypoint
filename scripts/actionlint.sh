#!/usr/bin/env bash
# The one owner of the actionlint version and its checksum.
#
# Both the path-filtered Actionlint workflow and the trusted `policy` job (part
# of the required aggregate) call this script, so the version and the digest
# cannot drift. The archive is verified before extraction.
#
# Usage:
#   bash scripts/actionlint.sh [workflow-directory]
#
# GitHub Actions only: RUNNER_TEMP is required.
set -euo pipefail

version=1.7.12
digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
directory="${1:-.github/workflows}"

: "${RUNNER_TEMP:?RUNNER_TEMP is required (this script runs only inside GitHub Actions)}"

archive="$RUNNER_TEMP/actionlint_${version}_linux_amd64.tar.gz"
binary="$RUNNER_TEMP/actionlint"

curl -fsSL \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
  -o "$archive"
echo "${digest}  ${archive}" | sha256sum -c -
tar -xzf "$archive" -C "$RUNNER_TEMP" actionlint

# actionlint takes files, not a directory. Expand the directory itself so a
# candidate cannot hide a file behind a path the scanner would skip.
mapfile -t files < <(find "$directory" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "actionlint: no workflow files under $directory" >&2
  exit 2
fi
"$binary" -color "${files[@]}"
