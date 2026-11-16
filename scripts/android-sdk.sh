#!/usr/bin/env bash
# Install the pinned Android SDK packages the gate and the release build with.
#
# Both workflows run this one script: the toolchain the pull-request gate
# proves is the toolchain the release uses, and the licence handling exists
# once.
#
# `sdkmanager --licenses` exits non-zero when every licence has already been
# accepted on the runner image. That is the one benign outcome, and it is
# recognised by its message. Anything else is a failure: `|| true` used to hide
# a sdkmanager that could not start at all, and the build then failed later
# with a misleading missing-package error.
#
# `yes` dies of SIGPIPE when sdkmanager exits, so `pipefail` would report that
# 141 as the pipeline's status even on success. The pipeline's own status is
# taken with pipefail suspended; only sdkmanager's exit code is used.
set -euo pipefail

sdkmanager="$(command -v sdkmanager || true)"
if [ -z "$sdkmanager" ]; then
  sdkmanager="${ANDROID_HOME:-}/cmdline-tools/latest/bin/sdkmanager"
fi
if [ ! -x "$sdkmanager" ]; then
  echo "::error::sdkmanager not found; set ANDROID_HOME to an SDK with cmdline-tools" >&2
  exit 1
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +o pipefail
if yes | "$sdkmanager" --licenses > "$log" 2>&1; then
  accepted=1
else
  accepted=0
fi
set -o pipefail

if [ "$accepted" -eq 0 ] && ! grep -q 'All SDK package licenses accepted' "$log"; then
  cat "$log" >&2
  echo "::error::sdkmanager --licenses failed" >&2
  exit 1
fi
if [ "$accepted" -eq 0 ]; then
  echo "android-sdk: every licence was already accepted"
fi

"$sdkmanager" "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}"
