#!/usr/bin/env node
/**
 * Workflow policy gate on parsed YAML.
 *
 * A GitHub Actions workflow is executable supply chain, and a tag reference is
 * mutable. A line-oriented scan is not a policy: YAML can spell the same grant
 * as a quoted scalar, a folded block scalar, a tag or an alias, and the parser
 * (not a regular expression) is the authority on what GitHub will run.
 * This gate therefore parses each file once and asserts on the resolved values:
 *
 *   - every `uses:` names a commit only (40 hex characters, no tag or branch),
 *   - only the actions on the pinned allowlist may be used at all,
 *   - every workflow declares a top-level `permissions:` scope map, never
 *     `write-all`/`read-all` in any spelling or through an anchor,
 *   - every workflow declares a top-level `concurrency:`,
 *   - every job declares `timeout-minutes:`,
 *   - a checkout never persists credentials,
 *   - `pull_request_target` is banned outright,
 *   - the aggregate job reads every leg from `toJSON(needs)` and runs even when
 *     a leg failed,
 *   - the merge gate commands are exact and cannot be masked with `|| true`,
 *     `; true`, `echo`, `continue-on-error` or a step condition,
 *   - the release publishes with `--verify-tag` on the real `gh release create`
 *     command, never through a quoted command name, eval or a decoy echo.
 *
 * GitHub is the syntax authority; `actionlint.yml` runs the pinned actionlint
 * on the same files. This script checks the policy YAML cannot express.
 *
 * Usage:
 *   node scripts/check-workflows.mjs                         # exit 1 on any finding
 *   node scripts/check-workflows.mjs --list                  # also print the scanned count
 *   node scripts/check-workflows.mjs --workflows <dir>       # scan a tree as data
 */

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDocument } from 'yaml';

import { THROWAWAY as CI_THROWAWAY } from './ci-keystore.mjs';

export const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WORKFLOW_DIR = '.github/workflows';
export const RELEASE_FILE = 'release.yml';
/** The one aggregate job whose whole purpose is to read its legs' results. */
export const AGGREGATE_JOB = 'required';
/** The one environment that holds the release signing key. */
export const RELEASE_ENVIRONMENT = 'release';

/** The pinned action commits the trusted wiring names explicitly below. */
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';

/** How the trusted gate selects the candidate tree as data, never as code. */
const PR_TREE_EXPRESSION =
  "${{ github.event_name == 'pull_request' && format('{0}/pr', github.workspace) || github.event_name == 'push' && format('{0}/data', github.workspace) || github.workspace }}";

/**
 * The exact trusted wiring of `policy` and `required`.
 *
 * These two jobs decide every merge, and a candidate checkout is present in
 * the policy job. The gate therefore does not approve "equivalent" wiring: the
 * exact steps, refs, paths, conditions, environment and shell bodies are the
 * contract. A missing/extra/reordered step, a `working-directory`, a job
 * `defaults` or `container`, a fork `repository:` or a moved checkout path is
 * a finding.
 */
export const TRUSTED_STEPS = Object.freeze({
  policy: Object.freeze([
    Object.freeze({ name: 'Checkout main (trusted policy scripts)', uses: CHECKOUT, with: Object.freeze({ ref: 'main', 'persist-credentials': false }) }),
    Object.freeze({ name: 'Use the pinned Node', uses: SETUP_NODE, with: Object.freeze({ 'node-version-file': '.node-version' }) }),
    Object.freeze({ name: 'Install the one dev-only dependency', run: 'npm ci' }),
    Object.freeze({
      name: 'Checkout the pull request as data',
      if: "github.event_name == 'pull_request'",
      uses: CHECKOUT,
      with: Object.freeze({
        repository: '${{ github.event.pull_request.head.repo.full_name }}',
        ref: '${{ github.event.pull_request.head.sha }}',
        path: 'pr',
        'persist-credentials': false,
        'fetch-depth': 1,
      }),
    }),
    Object.freeze({
      name: 'Checkout the pushed commit as data',
      if: "github.event_name == 'push'",
      uses: CHECKOUT,
      with: Object.freeze({ ref: '${{ github.sha }}', path: 'data', 'persist-credentials': false, 'fetch-depth': 1 }),
    }),
    Object.freeze({
      name: 'Workflow policy and privacy on the candidate tree',
      env: Object.freeze({ PR_TREE: PR_TREE_EXPRESSION }),
      run: Object.freeze([
        'set -euo pipefail',
        'node scripts/check-workflows.mjs --workflows "$PR_TREE/.github/workflows"',
        'node scripts/check-privacy.mjs --root "$PR_TREE" --tracked',
        'bash scripts/actionlint.sh "$PR_TREE/.github/workflows"',
      ]).join('\n'),
    }),
  ]),
  required: Object.freeze([
    Object.freeze({
      name: 'Checkout main (trusted aggregate)',
      uses: CHECKOUT,
      with: Object.freeze({ ref: 'main', 'persist-credentials': false, 'fetch-depth': 1 }),
    }),
    Object.freeze({
      name: 'Every leg must have succeeded',
      env: Object.freeze({ NEEDS: '${{ toJSON(needs) }}' }),
      run: 'node scripts/check-required.mjs',
    }),
  ]),
});

export const CHECKS_STEPS = Object.freeze({
  web: Object.freeze([
  {
    "name": "Checkout",
    "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "with": {
      "persist-credentials": false
    }
  },
  {
    "name": "Use Node ${{ matrix.node }}",
    "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "with": {
      "node-version": "${{ matrix.node }}"
    }
  },
  {
    "name": "Install the one dev-only dependency",
    "run": "npm ci"
  },
  {
    "name": "Generated files are current",
    "run": "npm run build:brand -- --check"
  },
  {
    "name": "The precache manifest is current",
    "run": "npm run check:precache"
  },
  {
    "name": "Privacy gate",
    "run": "npm run privacy:check"
  },
  {
    "name": "Unit test suite (the browser suites have their own job)",
    "run": "npm run test:unit"
  },
  {
    "name": "Generated documentation is current",
    "run": "node scripts/build-docs.mjs --check"
  },
  {
    "name": "Documentation links and generated docs",
    "run": "npm run docs:check"
  },
  {
    "name": "Workflow policy",
    "run": "npm run workflows:check"
  },
  {
    "name": "No tracked file changed",
    "run": "git diff --exit-code"
  },
  {
    "name": "No untracked file was left behind",
    "run": "test -z \"$(git status --porcelain)\""
  }
]),
  browser: Object.freeze([
  {
    "name": "Checkout",
    "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "with": {
      "persist-credentials": false
    }
  },
  {
    "name": "Use the pinned Node",
    "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "with": {
      "node-version-file": ".node-version"
    }
  },
  {
    "name": "Install the one dev-only dependency",
    "run": "npm ci"
  },
  {
    "name": "Locate a Chromium binary",
    "run": "node scripts/find-chrome.mjs"
  },
  {
    "name": "Measured layout suites",
    "env": {
      "CI": "true"
    },
    "run": "npm run test:browser"
  }
]),
  android: Object.freeze([
  {
    "name": "Checkout",
    "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "with": {
      "persist-credentials": false
    }
  },
  {
    "name": "Use the pinned Node",
    "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "with": {
      "node-version-file": ".node-version"
    }
  },
  {
    "name": "Install the one dev-only dependency",
    "run": "npm ci"
  },
  {
    "name": "Use JDK 21",
    "uses": "actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880",
    "with": {
      "distribution": "temurin",
      "java-version": "21"
    }
  },
  {
    "name": "Install the pinned SDK packages",
    "run": "bash scripts/android-sdk.sh"
  },
  {
    "name": "Create a throwaway signing key",
    "run": "node scripts/ci-keystore.mjs"
  },
  {
    "name": "Build and sign the APK",
    "run": "npm run build:android"
  },
  {
    "name": "Prove the package identity and print the digest",
    "run": "set -euo pipefail\nversion=\"$(node -p \"require('./package.json').version\")\"\npackage_id=\"$(node -p \"require('./brand.json').appId\")\"\nversion_code=\"$(node scripts/build-android.mjs --version-code)\"\napk=\"android/build/drypoint-${version}.apk\"\ntest -f \"$apk\"\nbadging=\"$(\"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2\" dump badging \"$apk\")\"\n# The package the phone installs must be the one brand.json names,\n# with the versionCode the version arithmetic produces, not only the\n# human-readable versionName.\nprintf '%s\\n' \"$badging\" | grep -F \"package: name='${package_id}' versionCode='${version_code}' versionName='${version}'\"\nsha256sum \"$apk\"\n"
  },
  {
    "name": "The built APK matches its manifest and policy",
    "run": "node scripts/check-apk.mjs --aapt2 \"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2\" --apksigner \"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner\""
  },
  {
    "name": "No tracked file changed",
    "run": "git diff --exit-code"
  },
  {
    "name": "No untracked file was left behind",
    "run": "test -z \"$(git status --porcelain)\""
  },
  {
    "name": "Upload the APK",
    "uses": "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "with": {
      "name": "drypoint-apk",
      "path": "android/build/drypoint-*.apk",
      "if-no-files-found": "error",
      "retention-days": 14
    }
  }
]),
});

export const RELEASE_JOBS_STEPS = Object.freeze({
  resolve: Object.freeze([
    {
      "name": "Checkout main with tags",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "main",
        "fetch-depth": 0,
        "fetch-tags": true,
        "persist-credentials": false
      }
    },
    {
      "name": "Resolve the tag",
      "id": "tag",
      "env": {
        "EVENT": "${{ github.event_name }}",
        "INPUT_TAG": "${{ inputs.tag }}",
        "RUN_SHA": "${{ github.event.workflow_run.head_sha }}",
        "INPUT_PUBLISH": "${{ inputs.publish }}"
      },
      "run": "set -euo pipefail\nout() { printf '%s\\n' \"$1\" >> \"$GITHUB_OUTPUT\"; }\n\nif [ \"$EVENT\" = workflow_dispatch ]; then\n  input=\"$INPUT_TAG\"\n  # A full SHA is the pre-tag dry run: the commit is built and signed,\n  # but a synthetic tag name is never treated as a real tag.\n  if [[ \"$input\" =~ ^[0-9a-f]{40}$ ]]; then\n    if [ \"$INPUT_PUBLISH\" = true ]; then\n      echo \"::error::publish=true requires a release tag, not the commit $input; a SHA dry run never publishes\"\n      exit 1\n    fi\n    if ! git cat-file -e \"${input}^{commit}\" 2>/dev/null; then\n      echo \"::error::commit $input does not exist in this repository\"\n      exit 1\n    fi\n    if ! git merge-base --is-ancestor \"$input\" origin/main; then\n      echo \"::error::$input is not an ancestor of origin/main\"\n      exit 1\n    fi\n    sha=\"$input\"\n    version=\"$(git show \"$sha:package.json\" | jq -r .version)\"\n    if ! [[ \"$version\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then\n      echo \"::error::package.json at $sha has no strict semantic version (got $version)\"\n      exit 1\n    fi\n    # The tag is the notes and version binding only; the commit is\n    # what gets checked out, and nothing is published.\n    tag=\"v$version\"\n    ref=\"$sha\"\n    publish=false\n  elif [[ \"$input\" =~ ^[0-9a-f]{7,39}$ ]]; then\n    echo \"::error::commit $input is not a full 40-character SHA; pass the full SHA for a dry run\"\n    exit 1\n  else\n    tag=\"$input\"\n    if ! [[ \"$tag\" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then\n      echo \"::error::$tag is not a strict release tag or a full 40-character commit SHA\"\n      exit 1\n    fi\n    if ! git rev-parse --verify --quiet \"refs/tags/$tag\" > /dev/null; then\n      echo \"::error::tag $tag does not exist\"\n      exit 1\n    fi\n    sha=\"$(git rev-list -n1 \"$tag\")\"\n    if ! git merge-base --is-ancestor \"$sha\" origin/main; then\n      echo \"::error::$sha is not an ancestor of origin/main\"\n      exit 1\n    fi\n    version=\"$(git show \"$tag:package.json\" | jq -r .version)\"\n    if [ \"$version\" != \"${tag#v}\" ]; then\n      echo \"::error::tag $tag does not match package.json version $version\"\n      exit 1\n    fi\n    ref=\"$tag\"\n    publish=\"$INPUT_PUBLISH\"\n  fi\nelse\n  # A tag that points at main HEAD produces two successful Checks\n  # runs for one commit (the branch push and the tag push). Deriving\n  # the tag from the commit makes both runs agree without depending\n  # on head_branch.\n  sha=\"$RUN_SHA\"\n  mapfile -t tags < <(git tag --points-at \"$sha\" | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' || true)\n  if [ \"${#tags[@]}\" -eq 0 ]; then\n    out \"publish=false\"\n    echo \"no release tag at $sha\"\n    exit 0\n  fi\n  if [ \"${#tags[@]}\" -ne 1 ]; then\n    echo \"::error::multiple release tags at $sha: ${tags[*]}\"\n    exit 1\n  fi\n  tag=\"${tags[0]}\"\n  if ! git merge-base --is-ancestor \"$sha\" origin/main; then\n    echo \"::error::$sha is not an ancestor of origin/main\"\n    exit 1\n  fi\n  version=\"$(git show \"$tag:package.json\" | jq -r .version)\"\n  if [ \"$version\" != \"${tag#v}\" ]; then\n    echo \"::error::tag $tag does not match package.json version $version\"\n    exit 1\n  fi\n  ref=\"$tag\"\n  publish=true\nfi\n\nout \"publish=$publish\"\nout \"tag=$tag\"\nout \"sha=$sha\"\nout \"version=$version\"\nout \"ref=$ref\"\n"
    }
  ]),
  build: Object.freeze([
    {
      "name": "Checkout main",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "main",
        "fetch-depth": 0,
        "fetch-tags": true,
        "persist-credentials": false
      }
    },
    {
      "name": "Materialize the resolved commit",
      "env": {
        "REF": "${{ needs.resolve.outputs.ref }}"
      },
      "run": "set -euo pipefail\nworktree=\"$RUNNER_TEMP/release\"\ngit worktree add --detach \"$worktree\" \"$REF\"\nprintf 'RELEASE_TREE=%s\\n' \"$worktree\" >> \"$GITHUB_ENV\"\n"
    },
    {
      "name": "Prove the worktree is the resolved commit",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "test \"$(git rev-parse HEAD)\" = \"$SHA\""
    },
    {
      "name": "Use the pinned Node",
      "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "with": {
        "node-version-file": "${{ env.RELEASE_TREE }}/.node-version"
      }
    },
    {
      "name": "Install the one dev-only dependency",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "npm ci"
    },
    {
      "name": "Locate a Chromium binary",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "node scripts/find-chrome.mjs"
    },
    {
      "name": "Gate the resolved tree",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "env": {
        "CI": "true"
      },
      "run": "npm run verify:all"
    },
    {
      "name": "Release notes from the changelog",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "mkdir -p dist"
    },
    {
      "name": "Generate the notes",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "node scripts/release-notes.mjs --tag \"$TAG\" --commit \"$SHA\" --out dist/notes.md"
    },
    {
      "name": "Use JDK 21",
      "uses": "actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880",
      "with": {
        "distribution": "temurin",
        "java-version": "21"
      }
    },
    {
      "name": "Install the pinned SDK packages",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "bash scripts/android-sdk.sh"
    },
    {
      "name": "Create a throwaway signing key",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "node scripts/ci-keystore.mjs"
    },
    {
      "name": "Build the unsigned APK with a throwaway key",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "npm run build:android"
    },
    {
      "name": "Package the unsigned artifact",
      "id": "package",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "set -euo pipefail\napk=\"android/build/drypoint-${VERSION}.apk\"\ntest -f \"$apk\"\ncp \"$apk\" \"dist/drypoint-${VERSION}-unsigned.apk\"\n(\n  cd dist\n  sha256sum \"drypoint-${VERSION}-unsigned.apk\" > \"drypoint-${VERSION}-unsigned.apk.sha256\"\n  cat \"drypoint-${VERSION}-unsigned.apk.sha256\"\n)\n# The job output is the digest of the exact bytes this step wrote.\n# The sign job compares its download against this value, so a\n# checksum shipped inside the same artifact cannot vouch for it.\nprintf 'unsigned_sha256=%s\\n' \"$(sha256sum \"dist/drypoint-${VERSION}-unsigned.apk\" | awk '{print $1}')\" >> \"$GITHUB_OUTPUT\"\n# Data for the sign job's independent package and certificate checks.\n# It is read with jq there, never executed. The version code and the\n# signing-scheme answer come from the one owner of each rule, not a\n# second copy in the sign job.\nnode scripts/build-android.mjs --version-code > dist/version-code.txt\nnode scripts/build-android.mjs --signing-scheme > dist/signing.json\ncp brand.json dist/brand.json\n"
    },
    {
      "name": "Write the provenance predicate",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "node scripts/release-provenance.mjs --sha \"$SHA\" --tag \"$TAG\" --version \"$VERSION\" --out dist/provenance.json"
    },
    {
      "name": "The build changed no tracked file",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "git diff --exit-code"
    },
    {
      "name": "The build left no untracked file",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "test -z \"$(git status --porcelain)\""
    },
    {
      "name": "The built APK matches its manifest and policy",
      "working-directory": "${{ env.RELEASE_TREE }}",
      "run": "set -euo pipefail\nnode scripts/check-apk.mjs \\\n  --apk \"dist/drypoint-${VERSION}-unsigned.apk\" \\\n  --aapt2 \"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2\" \\\n  --apksigner \"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner\"\n"
    },
    {
      "name": "Upload the unsigned artifact",
      "uses": "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      "with": {
        "name": "drypoint-unsigned",
        "path": "${{ env.RELEASE_TREE }}/dist/*",
        "if-no-files-found": "error",
        "retention-days": 7
      }
    }
  ]),
  sign: Object.freeze([
    {
      "name": "Download the unsigned artifact",
      "uses": "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
      "with": {
        "name": "drypoint-unsigned",
        "path": "dist"
      }
    },
    {
      "name": "Use the gate-proved JDK",
      "uses": "actions/setup-java@d1374f8ac74474200d16ef8ecee22c7ae7a51880",
      "with": {
        "distribution": "temurin",
        "java-version": "21"
      }
    },
    {
      "name": "Install the pinned build tools",
      "run": "set -euo pipefail\nsdkmanager=\"$(command -v sdkmanager)\"\n\"$sdkmanager\" \"platforms;${ANDROID_PLATFORM}\" \"build-tools;${ANDROID_BUILD_TOOLS}\"\n"
    },
    {
      "name": "Sign, verify and describe the APK",
      "env": {
        "ANDROID_KEYSTORE_BASE64": "${{ secrets.ANDROID_KEYSTORE_BASE64 }}",
        "ANDROID_KEYSTORE_PASSWORD": "${{ secrets.ANDROID_KEYSTORE_PASSWORD }}",
        "ANDROID_KEYSTORE_KEY_PASSWORD": "${{ secrets.ANDROID_KEYSTORE_KEY_PASSWORD }}",
        "ANDROID_KEY_ALIAS": "${{ vars.ANDROID_KEY_ALIAS }}"
      },
      "run": "set -euo pipefail\ntools=\"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS\"\nunsigned=\"dist/drypoint-${VERSION}-unsigned.apk\"\nsigned=\"dist/drypoint-${VERSION}.apk\"\nnotes=\"dist/notes.md\"\nbrand=\"dist/brand.json\"\ntrap 'rm -f \"$RUNNER_TEMP/release.jks\" \"$RUNNER_TEMP/ks-pass\" \"$RUNNER_TEMP/key-pass\" \"$RUNNER_TEMP/signed.apk\"' EXIT\n\n# The build-exposed digest is the independent reference. The checksum\n# file in this artifact was written by the job that wrote the APK, so\n# it cannot detect a substituted APK; this value can.\nif [ -z \"${UNSIGNED_SHA256:-}\" ]; then\n  echo \"::error::the build did not expose the unsigned APK digest\"\n  exit 1\nfi\nunsigned_sha=\"$(sha256sum \"$unsigned\" | awk '{print $1}')\"\nif [ \"$unsigned_sha\" != \"$UNSIGNED_SHA256\" ]; then\n  echo \"::error::the downloaded APK $unsigned_sha is not the build's $UNSIGNED_SHA256\"\n  exit 1\nfi\ntest -f \"$notes\"\ntest -f \"$brand\"\n# The build wrote both answers from their one owners: the versionCode\n# arithmetic in build-android.mjs and the manifest's minSdk. The sign\n# job reads them with jq/cat, never re-derives them.\ntest -f dist/version-code.txt\ntest -f dist/signing.json\nexpected_version_code=\"$(cat dist/version-code.txt)\"\nmin_sdk=\"$(jq -r .minSdkVersion dist/signing.json)\"\nv1_signing=\"$(jq -r .v1SigningEnabled dist/signing.json)\"\nif ! [[ \"$expected_version_code\" =~ ^[0-9]+$ ]] || ! [[ \"$min_sdk\" =~ ^[0-9]+$ ]] || ! [[ \"$v1_signing\" =~ ^(true|false)$ ]]; then\n  echo \"::error::the build did not publish a valid versionCode/signing scheme\"\n  exit 1\nfi\nif [ -z \"${EXPECTED_CERT:-}\" ]; then\n  echo \"::error::RELEASE_CERT_SHA256 is not pinned in the release environment\"\n  exit 1\nfi\nif [ -z \"${ANDROID_KEYSTORE_BASE64:-}\" ]; then\n  echo \"::error::ANDROID_KEYSTORE_BASE64 is not set; a release must be signed by the project key\"\n  exit 1\nfi\nprintf '%s' \"$ANDROID_KEYSTORE_BASE64\" | base64 --decode > \"$RUNNER_TEMP/release.jks\"\nprintf '%s' \"$ANDROID_KEYSTORE_PASSWORD\" > \"$RUNNER_TEMP/ks-pass\"\nprintf '%s' \"$ANDROID_KEYSTORE_KEY_PASSWORD\" > \"$RUNNER_TEMP/key-pass\"\nchmod 600 \"$RUNNER_TEMP/release.jks\" \"$RUNNER_TEMP/ks-pass\" \"$RUNNER_TEMP/key-pass\"\n\n\"$tools/apksigner\" sign \\\n  --ks \"$RUNNER_TEMP/release.jks\" \\\n  --ks-key-alias \"$ANDROID_KEY_ALIAS\" \\\n  --ks-pass \"file:$RUNNER_TEMP/ks-pass\" \\\n  --key-pass \"file:$RUNNER_TEMP/key-pass\" \\\n  --min-sdk-version \"$min_sdk\" \\\n  --v1-signing-enabled \"$v1_signing\" \\\n  --v2-signing-enabled true \\\n  --v3-signing-enabled true \\\n  --out \"$signed\" \\\n  \"$unsigned\"\n\nverify=\"$(\"$tools/apksigner\" verify --verbose --print-certs \"$signed\")\"\nprintf '%s\\n' \"$verify\"\nprintf '%s\\n' \"$verify\" | grep -F 'Verified using v2 scheme (APK Signature Scheme v2): true'\nprintf '%s\\n' \"$verify\" | grep -F 'Verified using v3 scheme (APK Signature Scheme v3): true'\n\nsigner=\"$(printf '%s\\n' \"$verify\" | grep -oE 'Signer #1 certificate SHA-256 digest: [0-9a-f]{64}' | awk '{print $NF}')\"\nif [ \"$signer\" != \"$EXPECTED_CERT\" ]; then\n  echo \"::error::the APK signer $signer is not the pinned $EXPECTED_CERT\"\n  exit 1\nfi\n# brand.json is repository data, read with jq and never executed. A\n# silent fingerprint drift must fail even when the key itself is\n# right, because the downloader reads this file.\nbrand_cert=\"$(jq -r .androidSigningCertificateSha256 \"$brand\")\"\nif [ \"$brand_cert\" != \"$EXPECTED_CERT\" ]; then\n  echo \"::error::brand.json records $brand_cert, not the environment pin $EXPECTED_CERT\"\n  exit 1\nfi\nnotes_cert=\"$(grep -F 'Signing certificate SHA-256' \"$notes\" | grep -oE '[0-9a-f]{64}' | tail -1)\"\nif [ \"$notes_cert\" != \"$EXPECTED_CERT\" ]; then\n  echo \"::error::the release notes name $notes_cert, not the environment pin $EXPECTED_CERT\"\n  exit 1\nfi\n\n\"$tools/zipalign\" -c -v 4 \"$signed\" > /dev/null\nbadging=\"$(\"$tools/aapt2\" dump badging \"$signed\")\"\npackage_id=\"$(jq -r .appId \"$brand\")\"\n# The exact package, versionCode and versionName: the same values\n# check-apk asserts against the unsigned artifact. A hard-coded\n# versionCode fails here even when it is positive.\nexpected_package=\"package: name='${package_id}' versionCode='${expected_version_code}' versionName='${VERSION}'\"\nif ! printf '%s\\n' \"$badging\" | grep -qF \"$expected_package\"; then\n  echo \"::error::the APK does not carry ${expected_package}\"\n  exit 1\nfi\nif printf '%s\\n' \"$badging\" | grep -q 'android.permission.INTERNET'; then\n  echo \"::error::the APK requests android.permission.INTERNET\"\n  exit 1\nfi\nlaunchers=\"$(printf '%s\\n' \"$badging\" | grep -c \"^launchable-activity: name='\")\"\nif [ \"$launchers\" -ne 1 ]; then\n  echo \"::error::the APK must have exactly one MAIN/LAUNCHER activity, found $launchers\"\n  exit 1\nfi\n\nxmltree=\"$(\"$tools/aapt2\" dump xmltree --file AndroidManifest.xml \"$signed\")\"\nprintf '%s\\n' \"$xmltree\" | grep -qE 'android:allowBackup\\([^)]*\\)=(false|\\(type 0x12\\)0x0)'\nif printf '%s\\n' \"$xmltree\" | grep -q 'android:debuggable'; then\n  echo \"::error::the APK is debuggable\"\n  exit 1\nfi\nif printf '%s\\n' \"$xmltree\" | grep -q 'android:usesCleartextTraffic'; then\n  echo \"::error::the APK allows cleartext traffic\"\n  exit 1\nfi\nif printf '%s\\n' \"$xmltree\" | grep -q 'android.permission.INTERNET'; then\n  echo \"::error::the manifest grants android.permission.INTERNET\"\n  exit 1\nfi\nif printf '%s\\n' \"$xmltree\" | grep -qE 'E: (provider|service|receiver)( |$)'; then\n  echo \"::error::the APK declares a provider, service or receiver\"\n  exit 1\nfi\nactivities=\"$(printf '%s\\n' \"$xmltree\" | grep -cE 'E: activity( |$)')\"\nexported=\"$(printf '%s\\n' \"$xmltree\" | grep -cE 'android:exported\\([^)]*\\)=true')\"\nif [ \"$activities\" -ne 1 ] || [ \"$exported\" -ne 1 ]; then\n  echo \"::error::the APK must have one activity and one exported component (activities=$activities exported=$exported)\"\n  exit 1\nfi\nif ! printf '%s\\n' \"$xmltree\" | grep -q 'android.intent.action.MAIN'; then\n  echo \"::error::the launcher activity has no MAIN action\"\n  exit 1\nfi\nif ! printf '%s\\n' \"$xmltree\" | grep -q 'android.intent.category.LAUNCHER'; then\n  echo \"::error::the launcher activity has no LAUNCHER category\"\n  exit 1\nfi\n\n(\n  cd dist\n  sha256sum \"drypoint-${VERSION}.apk\" > \"drypoint-${VERSION}.apk.sha256\"\n  cat \"drypoint-${VERSION}.apk.sha256\"\n)\n"
    },
    {
      "name": "Attest the signed APK",
      "uses": "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      "with": {
        "subject-path": "dist/drypoint-${{ needs.resolve.outputs.version }}.apk",
        "predicate-type": "https://slsa.dev/provenance/v1",
        "predicate-path": "dist/provenance.json"
      }
    },
    {
      "name": "Download the provenance bundle",
      "env": {
        "GH_TOKEN": "${{ github.token }}"
      },
      "run": "set -euo pipefail\n# A dedicated empty directory: a file already in dist/ cannot be\n# selected instead of the bundle this run downloads.\nrm -rf dist/attest\nmkdir -p dist/attest\n(\n  cd dist/attest\n  gh attestation download \"drypoint-${VERSION}.apk\" -R \"$GITHUB_REPOSITORY\"\n)\nshopt -s nullglob\nfiles=(dist/attest/*.jsonl)\nif [ \"${#files[@]}\" -ne 1 ]; then\n  echo \"::error::gh attestation download wrote ${#files[@]} bundles; exactly one is required\"\n  exit 1\nfi\nmv \"${files[0]}\" \"dist/drypoint-${VERSION}.apk.intoto.jsonl\"\ntest -f \"dist/drypoint-${VERSION}.apk.intoto.jsonl\"\n"
    },
    {
      "name": "Prove the provenance binds the tag commit",
      "env": {
        "GH_TOKEN": "${{ github.token }}"
      },
      "run": "set -euo pipefail\nbundle=\"dist/drypoint-${VERSION}.apk.intoto.jsonl\"\napk=\"dist/drypoint-${VERSION}.apk\"\napk_sha=\"$(sha256sum \"dist/drypoint-${VERSION}.apk\" | awk '{print $1}')\"\n# Verify the Sigstore bundle and the signer workflow before parsing\n# it. `--format json` returns only the attestations that passed that\n# verification, so a forged line appended to the bundle is never\n# considered by the assertion below.\ngh attestation verify \"$apk\" \\\n  --bundle \"$bundle\" \\\n  -R \"$GITHUB_REPOSITORY\" \\\n  --signer-workflow \"LLM-4-People/drypoint/.github/workflows/release.yml\" \\\n  --predicate-type \"https://slsa.dev/provenance/v1\" \\\n  --format json > \"$RUNNER_TEMP/verified.json\"\n# The DSSE payload is the in-toto statement. At least one verified\n# statement for this exact APK digest must carry exactly one\n# dependency and it must be the resolved commit. A prior dry run or\n# GitHub's automatic release attestation may add statements; they\n# cannot satisfy the binding unless they name this commit.\nif ! jq -e --arg sha \"$SHA\" --arg apk \"$apk_sha\" '\n  [ .[]\n    | .attestation.bundle.dsseEnvelope.payload\n    | @base64d | fromjson\n    | select(.subject[0].digest.sha256 == $apk)\n  ] as $statements\n  | ($statements | length) >= 1\n    and any($statements[];\n      (.predicate.buildDefinition.resolvedDependencies // []) as $dependencies\n      | ($dependencies | length) == 1\n        and $dependencies[0].digest.gitCommit == $sha)\n' \"$RUNNER_TEMP/verified.json\" > /dev/null; then\n  echo \"::error::the provenance does not bind the signed APK to the resolved commit $SHA\"\n  exit 1\nfi\necho \"provenance binds $apk_sha to $SHA\"\n"
    },
    {
      "name": "Upload the release files",
      "uses": "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      "with": {
        "name": "drypoint-release",
        "path": "dist/drypoint-${{ needs.resolve.outputs.version }}.apk\ndist/drypoint-${{ needs.resolve.outputs.version }}.apk.sha256\ndist/drypoint-${{ needs.resolve.outputs.version }}.apk.intoto.jsonl\ndist/notes.md\n",
        "if-no-files-found": "error",
        "retention-days": 7
      }
    }
  ]),
  publish: Object.freeze([
    {
      "name": "Download the release files",
      "uses": "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
      "with": {
        "name": "drypoint-release",
        "path": "dist"
      }
    },
    {
      "name": "Publish the release, or prove it already is",
      "run": "set -euo pipefail\napk=\"dist/drypoint-${VERSION}.apk\"\nchecksum=\"${apk}.sha256\"\nbundle=\"dist/drypoint-${VERSION}.apk.intoto.jsonl\"\nnotes=\"dist/notes.md\"\nfor file in \"$apk\" \"$checksum\" \"$bundle\" \"$notes\"; do test -f \"$file\"; done\n\n# A re-run of this workflow for the same tag must not fail, and must\n# not silently accept a release that carries different bytes. It\n# exits 0 only when the existing release's assets match the ones this\n# run built and verified.\nif gh release view \"$TAG\" > /dev/null 2>&1; then\n  gh release download \"$TAG\" --dir \"$RUNNER_TEMP/existing\" --clobber\n  # The APK and its checksum are reproducible: compare those bytes.\n  for asset in \\\n    \"drypoint-${VERSION}.apk\" \\\n    \"drypoint-${VERSION}.apk.sha256\"; do\n    if ! cmp -s \"dist/${asset}\" \"$RUNNER_TEMP/existing/${asset}\"; then\n      echo \"::error::the existing release asset ${asset} differs from this build\"\n      exit 1\n    fi\n  done\n  # The attestation bundle is not reproducible: every signing makes a\n  # fresh certificate and signature, and GitHub adds its own release\n  # attestation. Verify the published APK against the repository and\n  # the signer workflow, then require a statement for its exact\n  # digest that binds this commit, instead of comparing bundle bytes.\n  existing_apk=\"$RUNNER_TEMP/existing/drypoint-${VERSION}.apk\"\n  existing_bundle=\"$RUNNER_TEMP/existing/drypoint-${VERSION}.apk.intoto.jsonl\"\n  existing_sha=\"$(sha256sum \"$existing_apk\" | awk '{print $1}')\"\n  # Only the attestations gh verified are parsed; a forged line in the\n  # downloaded bundle is not in this output.\n  gh attestation verify \"$existing_apk\" \\\n    --bundle \"$existing_bundle\" \\\n    -R \"$GITHUB_REPOSITORY\" \\\n    --signer-workflow \"LLM-4-People/drypoint/.github/workflows/release.yml\" \\\n    --predicate-type \"https://slsa.dev/provenance/v1\" \\\n    --format json > \"$RUNNER_TEMP/verified.json\"\n  if ! jq -e --arg sha \"$SHA\" --arg apk \"$existing_sha\" '\n    [ .[]\n      | .attestation.bundle.dsseEnvelope.payload\n      | @base64d | fromjson\n      | select(.subject[0].digest.sha256 == $apk)\n    ] as $statements\n    | ($statements | length) >= 1\n      and any($statements[];\n        (.predicate.buildDefinition.resolvedDependencies // []) as $dependencies\n        | ($dependencies | length) == 1\n          and $dependencies[0].digest.gitCommit == $sha)\n  ' \"$RUNNER_TEMP/verified.json\" > /dev/null; then\n    echo \"::error::the existing release attestation does not bind the published APK to the resolved commit $SHA\"\n    exit 1\n  fi\n  # The assets are immutable, the body is not. A re-run with a changed\n  # changelog must not exit 0 while the published notes still lie.\n  gh release edit \"$TAG\" --notes-file \"$notes\"\n  echo \"::notice::release $TAG already exists with these exact assets; notes refreshed\"\n  exit 0\nfi\n\n# Tags are strict vMAJOR.MINOR.PATCH and the resolve step verified the\n# tag's own tree, so this command only ever creates the release the\n# build job proved.\ngh release create \"$TAG\" \\\n  \"$apk\" \\\n  \"$checksum\" \\\n  \"$bundle\" \\\n  --verify-tag \\\n  --title \"v${VERSION}\" \\\n  --notes-file \"$notes\" \\\n  --latest\n"
    }
  ]),
});

export const PAGES_JOBS_STEPS = Object.freeze({
  build: Object.freeze([
    {
      "name": "Checkout main for the Checks run",
      "if": "github.event_name == 'workflow_run' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'main'",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "main",
        "persist-credentials": false
      }
    },
    {
      "name": "The checked-out commit is the one Checks validated",
      "if": "github.event_name == 'workflow_run'",
      "run": "set -euo pipefail\nexpected=\"${{ github.event.workflow_run.head_sha }}\"\nactual=\"$(git rev-parse HEAD)\"\nif [ \"$actual\" != \"$expected\" ]; then\n  echo \"::error::main moved: checked out $actual, but Checks validated $expected; the newer Checks run will deploy it\"\n  exit 1\nfi\necho \"checked out $actual, the commit Checks validated\"\n"
    },
    {
      "name": "Checkout main for a manual deploy",
      "if": "github.event_name == 'workflow_dispatch'",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "refs/heads/main",
        "persist-credentials": false
      }
    },
    {
      "name": "Use the pinned Node",
      "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "with": {
        "node-version-file": ".node-version"
      }
    },
    {
      "name": "Stage the site from the runtime file list",
      "run": "set -euo pipefail\nnpm run build:brand -- --check\nnpm run pages:build\nnode scripts/build-pages.mjs --check\n"
    },
    {
      "name": "Configure Pages",
      "uses": "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d"
    },
    {
      "name": "Upload the Pages artifact",
      "uses": "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
      "with": {
        "path": "_site"
      }
    }
  ]),
  deploy: Object.freeze([
    {
      "name": "Deploy to GitHub Pages",
      "id": "deployment",
      "uses": "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346"
    }
  ]),
  smoke: Object.freeze([
    {
      "name": "Checkout main for the Checks run",
      "if": "github.event_name == 'workflow_run' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'main'",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "main",
        "persist-credentials": false
      }
    },
    {
      "name": "The checked-out commit is the one Checks validated",
      "if": "github.event_name == 'workflow_run'",
      "run": "set -euo pipefail\nexpected=\"${{ github.event.workflow_run.head_sha }}\"\nactual=\"$(git rev-parse HEAD)\"\nif [ \"$actual\" != \"$expected\" ]; then\n  echo \"::error::main moved: checked out $actual, but Checks validated $expected; the newer Checks run will deploy it\"\n  exit 1\nfi\necho \"checked out $actual, the commit Checks validated\"\n"
    },
    {
      "name": "Checkout main for a manual deploy",
      "if": "github.event_name == 'workflow_dispatch'",
      "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "with": {
        "ref": "refs/heads/main",
        "persist-credentials": false
      }
    },
    {
      "name": "Use the pinned Node",
      "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "with": {
        "node-version-file": ".node-version"
      }
    },
    {
      "name": "Smoke-test every precached file",
      "env": {
        "RUN_ID": "${{ github.run_id }}",
        "BASE_URL": "${{ needs.deploy.outputs.page_url }}"
      },
      "run": "set -euo pipefail\nif [ -z \"$BASE_URL\" ]; then\n  echo \"::error::the deployment page_url is empty\"\n  exit 1\nfi\n# The URL list is the worker's own manifest, not a hand-picked few:\n# a deployment that forgets one file fails here instead of on a\n# phone. Each URL is retried a bounded number of times and the\n# manifest's content type is checked too.\nnode scripts/smoke-pages.mjs --base \"$BASE_URL\" --cache-bust \"$RUN_ID\"\n"
    }
  ]),
});

export const GUARDED_JOBS_STEPS = Object.freeze({
  'codeql.yml': Object.freeze({
    analyze: Object.freeze([
      {
        "name": "Checkout",
        "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "with": {
          "persist-credentials": false
        }
      },
      {
        "name": "Initialize CodeQL",
        "uses": "github/codeql-action/init@33d7b85da1a04171e211befe2c739303b9a4c066",
        "with": {
          "languages": "${{ matrix.language }}",
          "build-mode": "${{ matrix.build-mode }}"
        }
      },
      {
        "name": "Analyze",
        "uses": "github/codeql-action/analyze@33d7b85da1a04171e211befe2c739303b9a4c066"
      }
    ]),
  }),
  'scorecard.yml': Object.freeze({
    analysis: Object.freeze([
      {
        "name": "Checkout",
        "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "with": {
          "persist-credentials": false
        }
      },
      {
        "name": "Run the OpenSSF Scorecard analysis",
        "uses": "ossf/scorecard-action@fa7117db83c52d787ae5a89f350999701505d78e",
        "with": {
          "results_file": "results.sarif",
          "results_format": "sarif",
          "publish_results": true
        }
      },
      {
        "name": "Keep the SARIF result as an artifact",
        "uses": "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
        "with": {
          "name": "scorecard-results",
          "path": "results.sarif",
          "if-no-files-found": "error",
          "retention-days": 5
        }
      },
      {
        "name": "Upload the result to code scanning",
        "uses": "github/codeql-action/upload-sarif@33d7b85da1a04171e211befe2c739303b9a4c066",
        "with": {
          "sarif_file": "results.sarif"
        }
      }
    ]),
  }),
  'stale.yml': Object.freeze({
    stale: Object.freeze([
      {
        "name": "Mark quiet issues and pull requests",
        "uses": "actions/stale@4391f3da665fdf50b6810c1a66712fb9ba21aa93",
        "with": {
          "days-before-stale": 60,
          "days-before-close": -1,
          "stale-issue-label": "stale",
          "stale-pr-label": "stale",
          "exempt-issue-labels": "security, pinned, good first issue",
          "exempt-pr-labels": "security, pinned, good first issue",
          "stale-issue-message": "This issue has had no activity for 60 days. It is labelled stale so the open queue stays useful; add a comment if it is still relevant.\n",
          "stale-pr-message": "This pull request has had no activity for 60 days. It is labelled stale; rebase it on the current main branch if you want it reviewed.\n",
          "operations-per-run": 60
        }
      }
    ]),
  }),
});
/**
 * The exact job set of every owned workflow. A job that is not named here is a
 * new place to run code with the workflow's token, so the set is closed.
 */
export const EXPECTED_JOBS = Object.freeze({
  'actionlint.yml': Object.freeze(['actionlint']),
  'checks.yml': Object.freeze(['web', 'browser', 'android', 'policy', 'required']),
  'codeql.yml': Object.freeze(['analyze']),
  'dependency-review.yml': Object.freeze(['review']),
  'pages.yml': Object.freeze(['build', 'deploy', 'smoke']),
  'release.yml': Object.freeze(['resolve', 'build', 'sign', 'publish']),
  'scorecard.yml': Object.freeze(['analysis']),
  'stale.yml': Object.freeze(['stale']),
});

/** The exact ordered `needs:` list of every job whose order is authority. */
export const EXPECTED_NEEDS = Object.freeze({
  'pages.yml': Object.freeze({
    deploy: Object.freeze(['build']),
    smoke: Object.freeze(['build', 'deploy']),
  }),
  'release.yml': Object.freeze({
    build: Object.freeze(['resolve']),
    sign: Object.freeze(['resolve', 'build']),
    publish: Object.freeze(['resolve', 'sign']),
  }),
});

/**
 * The exact job-level env of every release job. A key that is not listed is a
 * grant: GH_HOST with GH_ENTERPRISE_TOKEN redirects gh and sends the job token
 * to another host, so neither an added GH_* key nor any other key is allowed.
 */
export const RELEASE_JOB_ENV = Object.freeze({
  resolve: Object.freeze({}),
  build: Object.freeze({
    TAG: '${{ needs.resolve.outputs.tag }}',
    SHA: '${{ needs.resolve.outputs.sha }}',
    VERSION: '${{ needs.resolve.outputs.version }}',
    ANDROID_PLATFORM: 'android-36',
    ANDROID_BUILD_TOOLS: '36.0.0',
  }),
  sign: Object.freeze({
    TAG: '${{ needs.resolve.outputs.tag }}',
    VERSION: '${{ needs.resolve.outputs.version }}',
    SHA: '${{ needs.resolve.outputs.sha }}',
    UNSIGNED_SHA256: '${{ needs.build.outputs.unsigned_sha256 }}',
    EXPECTED_CERT: '${{ vars.RELEASE_CERT_SHA256 }}',
    ANDROID_PLATFORM: 'android-36',
    ANDROID_BUILD_TOOLS: '36.0.0',
  }),
  publish: Object.freeze({
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    TAG: '${{ needs.resolve.outputs.tag }}',
    VERSION: '${{ needs.resolve.outputs.version }}',
    SHA: '${{ needs.resolve.outputs.sha }}',
  }),
});

/** The exact matrix of checks.yml's web leg; a shorter list is less coverage. */
export const EXPECTED_MATRIX = Object.freeze({
  'checks.yml': Object.freeze({
    web: Object.freeze({
      'fail-fast': false,
      matrix: Object.freeze({ node: Object.freeze(['22', '24', '26']) }),
    }),
  }),
});

/**
 * The exact permission map of every workflow and job. A write scope a job does
 * not need is a grant the token holder can exercise; equality, not a minimum
 * check, is the only way a widening edit shows up here.
 */
export const EXPECTED_PERMISSIONS = Object.freeze({
  'actionlint.yml': Object.freeze({ top: Object.freeze({ contents: 'read' }), jobs: Object.freeze({}) }),
  'checks.yml': Object.freeze({ top: Object.freeze({ contents: 'read' }), jobs: Object.freeze({}) }),
  'codeql.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({ analyze: Object.freeze({ 'security-events': 'write', contents: 'read', actions: 'read' }) }),
  }),
  'dependency-review.yml': Object.freeze({
    top: Object.freeze({ contents: 'read', 'pull-requests': 'write' }),
    jobs: Object.freeze({}),
  }),
  'pages.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      build: null,
      deploy: Object.freeze({ pages: 'write', 'id-token': 'write' }),
      smoke: Object.freeze({ contents: 'read' }),
    }),
  }),
  'release.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      resolve: null,
      build: Object.freeze({ contents: 'read' }),
      sign: Object.freeze({ contents: 'read', 'id-token': 'write', attestations: 'write' }),
      publish: Object.freeze({ contents: 'write' }),
    }),
  }),
  'scorecard.yml': Object.freeze({
    top: Object.freeze({ contents: 'read' }),
    jobs: Object.freeze({
      analysis: Object.freeze({ 'security-events': 'write', 'id-token': 'write', contents: 'read', actions: 'read' }),
    }),
  }),
  'stale.yml': Object.freeze({ top: Object.freeze({ issues: 'write', 'pull-requests': 'write' }), jobs: Object.freeze({}) }),
});

/** The exact concurrency group of every workflow; `release` is reserved. */
export const EXPECTED_CONCURRENCY = Object.freeze({
  'actionlint.yml': Object.freeze({ group: 'actionlint-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'checks.yml': Object.freeze({ group: 'checks-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'codeql.yml': Object.freeze({ group: 'codeql-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true }),
  'dependency-review.yml': Object.freeze({ group: 'dependency-review-${{ github.ref }}', 'cancel-in-progress': true }),
  'pages.yml': Object.freeze({ group: 'pages', 'cancel-in-progress': false }),
  'release.yml': Object.freeze({ group: 'release', 'cancel-in-progress': false }),
  'scorecard.yml': Object.freeze({ group: 'scorecard', 'cancel-in-progress': false }),
  'stale.yml': Object.freeze({ group: 'stale', 'cancel-in-progress': false }),
});

/**
 * Environment variables that change what a trusted script executes or where it
 * writes. They are rejected at workflow, job and step level.
 */
export const INJECTION_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'HOME',
  'SHELL',
  'IFS',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_OUTPUT',
]);

/**
 * Every workflow this repository owns. A candidate can add `.github/workflows/
 * release.yaml`, which GitHub runs exactly like `release.yml` but which the
 * release-specific policy would never inspect. The set is therefore closed:
 * an added, renamed or removed workflow is a finding.
 */
export const OWNED_WORKFLOWS = Object.freeze([
  'actionlint.yml',
  'checks.yml',
  'codeql.yml',
  'dependency-review.yml',
  'pages.yml',
  'release.yml',
  'scorecard.yml',
  'stale.yml',
]);

/**
 * The only actions this repository may use, each pinned to one commit. A
 * version comment may travel beside the SHA; the SHA is what runs.
 */
export const PINNED_ACTIONS = Object.freeze({
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1',
  'actions/setup-java': 'd1374f8ac74474200d16ef8ecee22c7ae7a51880',
  'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'actions/download-artifact': '9000827ccba6bdab643e8b6fd33ac0654aef8333',
  'actions/attest-build-provenance': '4d101475d8b20a2381f78447822ac1eab6504dd8',
  'actions/dependency-review-action': 'a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  'actions/configure-pages': '45bfe0192ca1faeb007ade9deae92b16b8254a0d',
  'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
  'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346',
  'github/codeql-action': '33d7b85da1a04171e211befe2c739303b9a4c066',
  'ossf/scorecard-action': 'fa7117db83c52d787ae5a89f350999701505d78e',
  'actions/stale': '4391f3da665fdf50b6810c1a66712fb9ba21aa93',
});

/**
 * The exact commands each merge-gate job must run.
 *
 * This table is the owner of what the gate *is*. The workflow is checked
 * against it, never the other way around: a command can be weakened in the
 * workflow without weakening the expectation. Each command is matched as one
 * logical shell command (backslash continuations joined, `&&`/`||`/`;`/`|`
 * split, comments removed), so `npm run test:unit || true` is two commands and
 * the extra `true` is caught.
 */
/** Commands that are a no-op or that discard the command they follow. */
const MASK_COMMANDS = new Set(['true', ':', 'exit 0']);
const SHA = /^[0-9a-f]{40}$/;
/** A masked gate step is rejected in both workflows that hold authority. */
const MASKABLE_WORKFLOWS = new Set(['checks.yml', RELEASE_FILE]);
/** A secret reference in any job that is not the one signing job. */
const SECRET_REFERENCE = /secrets\s*(?:\.|\[)/i;
/** The exact opt-in a gated step may put before its registered command. */
const GATE_PREAMBLE = 'set -euo pipefail';
/** The one owner of the CI throwaway key; both unprivileged jobs call it. */
export const CI_KEYSTORE_COMMAND = 'node scripts/ci-keystore.mjs';

/** YAML may hold a scalar or a list in either form; callers want a list. */
function list(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse one workflow with the merge and duplicate-key semantics GitHub uses.
 *
 * `stringKeys` keeps a quoted job key and a bare one the same map key;
 * `uniqueKeys` turns a duplicate key into an error instead of silently keeping
 * one; `merge` resolves `<<` merge keys.
 *
 * @param {string} text
 * @returns {{workflow: object|null, findings: string[]}}
 */
export function parseWorkflow(text) {
  const doc = parseDocument(String(text), { stringKeys: true, uniqueKeys: true, merge: true });
  const findings = doc.errors.map((error) => {
    const line = error.linePos?.[0]?.line;
    return `${error.code ?? 'YAML'}${line ? ` at line ${line}` : ''}: ${error.message.split('\n')[0]}`;
  });
  if (findings.length) return { workflow: null, findings };
  try {
    return { workflow: doc.toJS({ maxAliasCount: 200 }), findings: [] };
  } catch (error) {
    return { workflow: null, findings: [`YAML: ${error.message.split('\n')[0]}`] };
  }
}

/**
 * Remove one shell trailing comment, keeping `#` inside a quoted argument.
 *
 * @param {string} line
 * @returns {string}
 */
function stripShellCommentLine(line) {
  const text = String(line);
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function stripShellComments(text) {
  return String(text)
    .split(/\r?\n/)
    .map(stripShellCommentLine)
    .join('\n');
}

/**
 * Split a shell script into simple commands, respecting quotes and escapes.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitShellCommands(command) {
  const parts = [];
  let current = '';
  let quote = null;
  const text = String(command);
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index];
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      current += character + text[++index];
      continue;
    }
    const pair = text.slice(index, index + 2);
    if (character === ';' || character === '|' || character === '\n' || pair === '&&' || pair === '||') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (pair === '&&' || pair === '||') index++;
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Collapse runs of whitespace outside quotes. Shell treats them as one
 * separator, and a backslash continuation adds indentation that must not make
 * an otherwise identical gate command look different.
 *
 * @param {string} command
 * @returns {string}
 */
export function normalizeCommand(command) {
  const text = String(command);
  let output = '';
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      output += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      if (pendingSpace && output) output += ' ';
      pendingSpace = false;
      quote = character;
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) output += ' ';
    pendingSpace = false;
    output += character;
  }
  return output;
}

/**
 * The logical commands in one `run:` string.
 *
 * A backslash continuation joins the next physical line before the command is
 * examined; otherwise `--verify-tag` on a line of its own looked present even
 * when it was not part of the `gh release create` invocation.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function logicalCommands(text) {
  const cleaned = stripShellComments(text).replace(/\\\r?\n[ \t]*/g, ' ');
  return splitShellCommands(cleaned).map((command) => normalizeCommand(command.trim())).filter(Boolean);
}

/**
 * Tokenize one shell command. Quotes delimit tokens; they are not part of the
 * token, and whitespace inside them does not split.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  const text = String(command);
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index];
        continue;
      }
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      current += text[++index];
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** Every `run:` string in a workflow, in job order. */
function runStrings(text) {
  const { workflow, findings } = parseWorkflow(text);
  if (!workflow || findings.length || !isMap(workflow.jobs)) return [];
  const runs = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of list(job?.steps)) {
      if (typeof step?.run === 'string') runs.push(step.run);
    }
  }
  return runs;
}

/** The logical commands in every `run:` string of a workflow. */
export function shellCommands(text) {
  return runStrings(text).flatMap((run) => logicalCommands(run));
}

/** Whether one logical command is the real publish command. */
function isPublishCommand(command) {
  const tokens = shellTokens(command);
  return tokens[0] === 'gh' && tokens[1] === 'release' && tokens[2] === 'create';
}

/**
 * The real `gh release create` commands in a workflow, extracted from the
 * parsed `run:` strings. The test suite executes what this returns, so a test
 * cannot drift from the workflow.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function publishCommands(text) {
  return shellCommands(text).filter(isPublishCommand);
}

/**
 * Every `permissions:` declaration must be a scope map. A scalar is the
 * `write-all`/`read-all` shorthand; YAML folds, tags and anchors all resolve to
 * that same string before this runs.
 */
function permissionFindings(permissions, file, where) {
  const findings = [];
  if (permissions == null) return findings;
  if (!isMap(permissions)) {
    findings.push(`${file}: ${where}permissions must be a scope map, not ${JSON.stringify(permissions)}`);
    return findings;
  }
  for (const [scope, level] of Object.entries(permissions)) {
    if (level === 'write-all' || level === 'read-all') {
      findings.push(`${file}: ${where}permission ${scope} is ${level}; declare each scope`);
    } else if (!['read', 'write', 'none'].includes(level)) {
      findings.push(`${file}: ${where}permission ${scope} has invalid value ${JSON.stringify(level)}`);
    }
  }
  return findings;
}

/** Whether a parsed trigger document mentions a key anywhere. */
function mentionsKey(value, wanted) {
  if (!isMap(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === wanted) return true;
    if (mentionsKey(child, wanted)) return true;
  }
  return false;
}

/** The job names in a parsed workflow, including quoted and spaced keys. */
export function jobNames(workflow) {
  return isMap(workflow?.jobs) ? Object.keys(workflow.jobs) : [];
}

/** Whether two plain maps have the same keys and values (order-insensitive). */
function sameMap(actual, expected) {
  if (actual == null && expected == null) return true;
  if (!isMap(actual) || !isMap(expected)) return false;
  const entries = (map) => Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries(actual)) === JSON.stringify(entries(expected));
}

/** The exact permission table, applied to every owned workflow. */
function permissionTableFindings(workflow, file) {
  const table = EXPECTED_PERMISSIONS[file];
  if (!table) return [];
  const findings = [];
  if (!sameMap(workflow?.permissions, table.top)) {
    findings.push(`${file}: top-level permissions must be exactly ${JSON.stringify(table.top)}`);
  }
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const expected = Object.hasOwn(table.jobs, name) ? table.jobs[name] : null;
    if (!sameMap(job.permissions, expected)) {
      findings.push(
        `${file}: job "${name}" permissions must be exactly ${JSON.stringify(expected)}, not ${JSON.stringify(job.permissions ?? null)}`
      );
    }
  }
  return findings;
}

/** The exact concurrency group, so a checks run cannot join `release`. */
function concurrencyFindings(workflow, file) {
  const expected = EXPECTED_CONCURRENCY[file];
  if (!expected) return [];
  const findings = [];
  if (workflow?.concurrency?.group !== expected.group) {
    findings.push(
      `${file}: concurrency group must be exactly "${expected.group}", not ${JSON.stringify(workflow?.concurrency?.group ?? null)}`
    );
  }
  if (workflow?.concurrency?.['cancel-in-progress'] !== expected['cancel-in-progress']) {
    findings.push(`${file}: concurrency cancel-in-progress must be ${expected['cancel-in-progress']}`);
  }
  return findings;
}

/** Reject every env key that changes what the trusted scripts execute. */
function injectionFindings(workflow, file) {
  const findings = [];
  const check = (env, where) => {
    if (!isMap(env)) return;
    for (const key of Object.keys(env)) {
      // npm reads its config from `npm_config_*` and the spelling's case is not
      // a guarantee: `npm_config_script_shell=/bin/true` turns `npm run <gate>`
      // into a no-op.
      if (INJECTION_KEYS.includes(key) || key.toLowerCase().startsWith('npm_config_')) {
        findings.push(`${file}: ${where} must not set ${key}`);
      }
    }
  };
  check(workflow?.env, 'the workflow env');
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    check(job?.env, `job "${name}" env`);
    for (const step of stepsOf(job)) check(step.env, `job "${name}" step env`);
  }
  return findings;
}

/** Normalize one GitHub expression for an exact comparison. */
export function conditionText(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

/** Require one exact job or step condition. */
export function exactConditionFindings(value, expected, file, where) {
  if (conditionText(value) === expected) return [];
  return [`${file}: ${where} must be exactly "${expected}", not ${JSON.stringify(conditionText(value) || null)}`];
}

/**
 * The exact trusted step list. Any added, missing, reordered or reshaped step
 * is a finding, as is a job-level `defaults`, `container`, `env` or
 * `continue-on-error`.
 */
/**
 * One exact step list. Any added, missing, reordered or reshaped step is a
 * finding, as is a job-level `defaults`, `container`, `services`,
 * `continue-on-error`, or an unapproved job `env`.
 */
function expectedStepFindings(job, file, jobName, expected, { allowJobEnv = false } = {}) {
  if (!expected) return [];
  if (!isMap(job)) return [`${file}: job "${jobName}" is missing`];
  const findings = [];
  for (const key of ['defaults', 'container', 'services']) {
    if (job[key] != null) findings.push(`${file}: job "${jobName}" must not declare ${key}`);
  }
  if (!allowJobEnv && job.env != null) findings.push(`${file}: job "${jobName}" must not declare job-level env`);
  if (job['continue-on-error'] != null && job['continue-on-error'] !== false) {
    findings.push(`${file}: job "${jobName}" must not set continue-on-error`);
  }
  const steps = stepsOf(job);
  if (steps.length !== list(job.steps).length) {
    findings.push(`${file}: job "${jobName}" steps must all be mappings`);
  }
  if (steps.length !== expected.length) {
    findings.push(`${file}: job "${jobName}" must have exactly ${expected.length} steps; found ${steps.length}`);
  }
  const allowed = ['name', 'if', 'uses', 'with', 'run', 'env', 'id', 'working-directory'];
  for (let index = 0; index < Math.min(steps.length, expected.length); index++) {
    const step = steps[index];
    const wanted = expected[index];
    const where = `job "${jobName}" step ${index + 1} ("${wanted.name}")`;
    for (const key of Object.keys(step)) {
      if (!allowed.includes(key)) findings.push(`${file}: ${where} must not set ${key}`);
    }
    if (step.name !== wanted.name) {
      findings.push(`${file}: ${where} has the name ${JSON.stringify(step.name ?? null)}`);
      continue;
    }
    if (conditionText(step.if) !== conditionText(wanted.if)) {
      findings.push(`${file}: ${where} condition must be ${JSON.stringify(conditionText(wanted.if) || null)}`);
    }
    if (step.uses !== wanted.uses) {
      findings.push(`${file}: ${where} must use ${JSON.stringify(wanted.uses ?? null)}`);
    }
    if (!sameMap(step.with, wanted.with)) {
      findings.push(`${file}: ${where} with: must be exactly ${JSON.stringify(wanted.with ?? null)}`);
    }
    if (!sameMap(step.env, wanted.env)) {
      findings.push(`${file}: ${where} env: must be exactly ${JSON.stringify(wanted.env ?? null)}`);
    }
    if ((step['working-directory'] ?? '') !== (wanted['working-directory'] ?? '')) {
      findings.push(
        wanted['working-directory'] == null
          ? `${file}: ${where} must not set working-directory`
          : `${file}: ${where} working-directory must be ${JSON.stringify(wanted['working-directory'])}`
      );
    }
    if ((step.id ?? '') !== (wanted.id ?? '')) {
      findings.push(`${file}: ${where} id must be ${JSON.stringify(wanted.id ?? null)}`);
    }
    if ((step.run == null ? '' : String(step.run).trim()) !== (wanted.run == null ? '' : String(wanted.run).trim())) {
      findings.push(`${file}: ${where} run: must be the exact body, not ${JSON.stringify(step.run ?? null)}`);
    }
  }
  return findings;
}

function trustedStepFindings(job, file, jobName) {
  return expectedStepFindings(job, file, jobName, TRUSTED_STEPS[jobName], { allowJobEnv: false });
}

/**
 * The exact job set of one workflow. An added job is another place to run code
 * under the workflow's token even when it declares no permissions of its own.
 */
function expectedJobFindings(workflow, file) {
  const expected = EXPECTED_JOBS[file];
  if (!expected) return [];
  const actual = jobNames(workflow);
  const findings = [];
  for (const name of actual) {
    if (!expected.includes(name)) findings.push(`${file}: job "${name}" is not part of ${file}`);
  }
  for (const name of expected) {
    if (!actual.includes(name)) findings.push(`${file}: job "${name}" is missing`);
  }
  return findings;
}

/** The exact ordered `needs:` list of every job in the table. */
function expectedNeedsFindings(workflow, file) {
  const table = EXPECTED_NEEDS[file];
  if (!table) return [];
  const findings = [];
  for (const [name, expected] of Object.entries(table)) {
    const job = workflow?.jobs?.[name];
    if (!isMap(job)) continue;
    const actual = needsOf(job);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      findings.push(
        `${file}: job "${name}" needs must be exactly [${expected.join(', ')}], not [${actual.join(', ')}]`
      );
    }
  }
  return findings;
}

/**
 * The exact job-level env map. A missing or changed key is a grant the policy
 * did not approve; an extra key is how GH_HOST and GH_ENTERPRISE_TOKEN would
 * redirect gh and carry the job token to another host.
 */
function jobEnvExactFindings(job, file, jobName, expected) {
  const findings = [];
  if (job?.env != null && !isMap(job.env)) {
    findings.push(`${file}: job "${jobName}" env must be a map`);
    return findings;
  }
  const actual = job?.env ?? {};
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) findings.push(`${file}: job "${jobName}" env ${name} must be exactly ${value}`);
  }
  for (const name of Object.keys(actual)) {
    if (!Object.hasOwn(expected, name)) findings.push(`${file}: job "${jobName}" must not set env ${name}`);
  }
  return findings;
}

/** Canonical JSON so an exact map comparison ignores key order. */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isMap(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function sameValue(actual, expected) {
  return JSON.stringify(canonicalValue(actual)) === JSON.stringify(canonicalValue(expected));
}

/** The exact strategy and matrix of the jobs that publish a coverage answer. */
function matrixFindings(workflow, file) {
  const table = EXPECTED_MATRIX[file];
  if (!table) return [];
  const findings = [];
  for (const [name, expected] of Object.entries(table)) {
    const job = workflow?.jobs?.[name];
    if (!isMap(job)) continue;
    if (!sameValue(job.strategy, expected)) {
      findings.push(
        `${file}: job "${name}" strategy must be exactly ${JSON.stringify(expected)}, not ${JSON.stringify(job.strategy ?? null)}`
      );
    }
  }
  return findings;
}

/** The exact steps of every privileged job outside release.yml and checks.yml. */
function guardedStepFindings(workflow, file) {
  const table = file === 'pages.yml' ? PAGES_JOBS_STEPS : GUARDED_JOBS_STEPS[file];
  if (!table) return [];
  const findings = [];
  for (const [name, expected] of Object.entries(table)) {
    const job = workflow?.jobs?.[name];
    if (!isMap(job)) continue;
    findings.push(...expectedStepFindings(job, file, name, expected, { allowJobEnv: false }));
  }
  return findings;
}

/** The Pages deploy job is exactly one pinned action: no shell, no second step. */
function pagesDeployFindings(workflow, file) {
  if (file !== 'pages.yml') return [];
  const job = workflow?.jobs?.deploy;
  if (!isMap(job)) return [];
  const steps = stepsOf(job);
  const findings = [];
  if (steps.length !== 1) findings.push(`${file}: job "deploy" must have exactly 1 step; found ${steps.length}`);
  if (steps.some((step) => step.run != null)) findings.push(`${file}: job "deploy" must not run a shell`);
  return findings;
}

/**
 * check-apk is the last step that reads the APK before the unsigned upload.
 * Anything after it can change the bytes it approved.
 */
function buildGateOrderFindings(job, file, jobName) {
  const steps = stepsOf(job);
  const gate = steps.findIndex((step) =>
    stepCommands(step).some((command) => command.startsWith('node scripts/check-apk.mjs'))
  );
  if (gate < 0) return [];
  const findings = [];
  const commands = stepCommands(steps[gate]);
  const position = commands.findIndex((command) => command.startsWith('node scripts/check-apk.mjs'));
  if (position !== commands.length - 1) {
    findings.push(`${file}: job "${jobName}" must run nothing after node scripts/check-apk.mjs in its step`);
  }
  for (let index = gate + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (!String(step.uses ?? '').startsWith('actions/upload-artifact@')) {
      findings.push(
        `${file}: job "${jobName}" must run nothing after node scripts/check-apk.mjs; found "${step.name}"`
      );
    }
  }
  if (steps.length !== gate + 2) {
    findings.push(`${file}: job "${jobName}" must upload the unsigned artifact immediately after node scripts/check-apk.mjs`);
  }
  return findings;
}

/** overwrite deletes a same-name artifact and re-creates it under the same name. */
function releaseUploadFindings(workflow, file) {
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of stepsOf(job)) {
      if (!String(step.uses ?? '').startsWith('actions/upload-artifact@')) continue;
      if (step.with?.overwrite != null) {
        findings.push(`${file}: job "${name}" must not set overwrite on upload-artifact`);
      }
    }
  }
  return findings;
}

/** The build exposes the unsigned digest the sign job compares against. */
function buildOutputFindings(job, file) {
  const expected = {
    unsigned_sha256: '${{ steps.package.outputs.unsigned_sha256 }}',
  };
  const actual = isMap(job?.outputs) ? job.outputs : {};
  const findings = [];
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) findings.push(`${file}: job "build" output ${name} must be exactly ${value}`);
  }
  for (const name of Object.keys(actual)) {
    if (!Object.hasOwn(expected, name)) findings.push(`${file}: job "build" must not expose the unused output ${name}`);
  }
  return findings;
}

/** Reject the write token outside the release workflow. */
function tokenFindings(workflow, file) {
  if (file === RELEASE_FILE) return [];
  if (JSON.stringify([workflow?.env ?? {}, workflow?.jobs ?? {}]).includes('github.token')) {
    return [`${file}: must not read github.token; the trusted jobs need no write capability`];
  }
  return [];
}

/** Reject `source`/`.` in a shell body; both execute repository data. */
function sourceFindings(job, file, jobName) {
  const findings = [];
  for (const command of stepsOf(job).flatMap(stepCommands)) {
    const tokens = shellTokens(command);
    if (tokens[0] === 'source' || tokens[0] === '.') {
      findings.push(`${file}: job "${jobName}" must not source a file: "${command}"`);
    }
  }
  return findings;
}

/** The `needs:` list of one parsed job. */
export function needsOf(job) {
  return list(job?.needs).map(String);
}

function stepsOf(job) {
  return list(job?.steps).filter(isMap);
}

/**
 * Gate and release logic must be a shell `run:` step, not an opaque script
 * passed to an action. `with.script` is still inspected: moving the aggregate,
 * the policy or the publish command there is refused.
 */
function withScriptFindings(workflow, file) {
  if (!MASKABLE_WORKFLOWS.has(file)) return [];
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of stepsOf(job)) {
      const script = step.with?.script;
      if (typeof script !== 'string') continue;
      if (/(?:toJSON\(needs\)|check-required|check-workflows|gh release create|--verify-tag|npm run test:|npm run verify)/.test(script)) {
        findings.push(`${file}: job "${name}" must keep gate or release logic in a run: step, not with.script`);
      }
    }
  }
  return findings;
}

/** One step's logical shell commands (only `run:` is shell). */
function stepCommands(step) {
  return typeof step.run === 'string' ? logicalCommands(step.run) : [];
}

/** Every logical shell command in a parsed workflow. */
function workflowCommands(workflow) {
  return Object.values(workflow?.jobs ?? {}).flatMap((job) => stepsOf(job).flatMap(stepCommands));
}

function usesFindings(step, file, jobName) {
  const findings = [];
  if (step.uses == null) return findings;
  if (typeof step.uses !== 'string') {
    findings.push(`${file}: job "${jobName}" has a uses: that is not a string`);
    return findings;
  }
  const value = step.uses;
  if (value.startsWith('./')) {
    // A local action is candidate or repository code, not a pinned action. In
    // the trusted `policy` job the candidate checkout is present, so a local
    // action there would run candidate code before the gate.
    findings.push(`${file}: job "${jobName}" must not run a local action: ${value}`);
    return findings;
  }
  const at = value.lastIndexOf('@');
  const action = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? '' : value.slice(at + 1);
  if (!SHA.test(ref)) {
    findings.push(`${file}: ${value} is not pinned to a 40-character commit`);
    return findings;
  }
  const repo = action.split('/').slice(0, 2).join('/');
  if (!Object.hasOwn(PINNED_ACTIONS, repo)) {
    findings.push(`${file}: ${repo} is not on the pinned action allowlist`);
  } else if (PINNED_ACTIONS[repo] !== ref) {
    findings.push(`${file}: ${repo} must be pinned to ${PINNED_ACTIONS[repo]}`);
  }
  if (repo === 'actions/checkout' && step.with?.['persist-credentials'] !== false) {
    findings.push(`${file}: checkout must set persist-credentials: false`);
  }
  return findings;
}

/** Reject a step that can silently skip or mask the command it owns. */
function maskedStepFindings(step, file, jobName, commands) {
  const findings = [];
  if (step['continue-on-error'] != null && step['continue-on-error'] !== false) {
    findings.push(`${file}: job "${jobName}" step must not set continue-on-error`);
  }
  if (step.if != null) {
    findings.push(`${file}: job "${jobName}" gate step must not carry an if:`);
  }
  if (step.shell != null) {
    findings.push(`${file}: job "${jobName}" gate step must use the default shell, not ${JSON.stringify(step.shell)}`);
  }
  for (const command of commands) {
    const tokens = shellTokens(command);
    if (MASK_COMMANDS.has(command) || MASK_COMMANDS.has(tokens[0])) {
      findings.push(`${file}: job "${jobName}" gate step contains the masking command "${command}"`);
    } else if (tokens[0] === 'echo' || tokens[0] === 'printf') {
      findings.push(`${file}: job "${jobName}" gate step echoes instead of running the gate: "${command}"`);
    }
  }
  return findings;
}

/**
 * The aggregate job: it must list every other job, run even when a leg failed,
 * and derive its result from the whole `needs` map by calling the tested
 * script. A second hand-written map or a `needs.<name>` read is drift.
 */
function aggregateFindings(workflow, jobs, file) {
  const findings = [];
  const aggregate = jobs[AGGREGATE_JOB];
  if (!aggregate) return findings;

  const needed = needsOf(aggregate);
  for (const name of Object.keys(jobs)) {
    if (name !== AGGREGATE_JOB && !needed.includes(name)) {
      findings.push(`${file}: job "${name}" is not listed in ${AGGREGATE_JOB}.needs`);
    }
  }
  for (const name of needed) {
    if (name === AGGREGATE_JOB) continue;
    const leg = jobs[name];
    if (!leg) {
      findings.push(`${file}: ${AGGREGATE_JOB}.needs names the missing job "${name}"`);
      continue;
    }
    if (leg.if != null) {
      const condition = typeof leg.if === 'string' ? leg.if.replace(/\$\{\{|\}\}/g, '').trim() : '';
      if (!/^(?:always\(\)|!cancelled\(\))$/.test(condition)) {
        findings.push(`${file}: job "${name}" must run on every trigger (including a tag push); the aggregate needs it`);
      }
    }
  }

  const condition = typeof aggregate.if === 'string' ? aggregate.if.replace(/\$\{\{|\}\}/g, '').trim() : '';
  if (!/^(?:always\(\)|!cancelled\(\))$/.test(condition)) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must run with if: always() (or !cancelled())`);
  }

  const steps = stepsOf(aggregate);
  const scriptStep = steps.find((step) => stepCommands(step).includes('node scripts/check-required.mjs'));
  if (!scriptStep) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must call node scripts/check-required.mjs`);
  } else if (String(scriptStep.env?.NEEDS ?? '').trim() !== '${{ toJSON(needs) }}') {
    findings.push(`${file}: job "${AGGREGATE_JOB}" must pass NEEDS: \${{ toJSON(needs) }} to the script`);
  }
  findings.push(...gateStepFindings(aggregate, file, AGGREGATE_JOB, ['node scripts/check-required.mjs']));

  const logic = steps
    .flatMap((step) => [...stepCommands(step), JSON.stringify(step.env ?? {}), typeof step.with?.script === 'string' ? step.with.script : ''])
    .join('\n');
  if (/needs\.[A-Za-z0-9_-]+/.test(logic)) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" hardcodes a leg name; use toJSON(needs)`);
  }
  return findings;
}

/**
 * Check one parsed workflow against the general policy.
 *
 * @param {object} workflow
 * @param {string} file
 * @returns {string[]}
 */
export function parsedWorkflowFindings(workflow, file) {
  const findings = [];
  const jobs = workflow?.jobs;
  if (!isMap(jobs) || !Object.keys(jobs).length) return [`${file}: no jobs`];

  findings.push(...permissionFindings(workflow.permissions, file, ''));
  findings.push(...permissionTableFindings(workflow, file));
  findings.push(...concurrencyFindings(workflow, file));
  findings.push(...injectionFindings(workflow, file));
  findings.push(...tokenFindings(workflow, file));
  if (workflow.permissions == null) findings.push(`${file}: no top-level permissions block`);
  if (workflow.concurrency == null) findings.push(`${file}: no top-level concurrency block`);
  if (mentionsKey(workflow.on, 'pull_request_target')) findings.push(`${file}: pull_request_target is banned`);
  if (workflow.defaults != null) findings.push(`${file}: must not declare workflow-level defaults (a run shell override could no-op a gate)`);

  for (const [name, job] of Object.entries(jobs)) {
    if (!isMap(job)) {
      findings.push(`${file}: job "${name}" is not a mapping`);
      continue;
    }
    if (!Number.isInteger(job['timeout-minutes']) || job['timeout-minutes'] <= 0) {
      findings.push(`${file}: job "${name}" has no timeout-minutes`);
    }
    // A trusted job must run on the image the gate proved. A self-hosted,
    // Windows or macOS label changes the shell and the tools silently.
    if (job['runs-on'] !== 'ubuntu-24.04') {
      findings.push(`${file}: job "${name}" must run on ubuntu-24.04, not ${JSON.stringify(job['runs-on'] ?? null)}`);
    }
    if (job['continue-on-error'] != null && job['continue-on-error'] !== false) {
      findings.push(`${file}: job "${name}" must not set continue-on-error`);
    }
    findings.push(...permissionFindings(job.permissions, file, `job "${name}" `));
    if (job.uses != null) {
      findings.push(`${file}: job "${name}" must not call a reusable workflow (secrets: inherit is the bypass this policy removes)`);
    }
    for (const step of stepsOf(job)) {
      findings.push(...usesFindings(step, file, name));
      if (MASKABLE_WORKFLOWS.has(file) && step['continue-on-error'] != null && step['continue-on-error'] !== false) {
        findings.push(`${file}: job "${name}" step must not set continue-on-error`);
      }
    }
  }

  findings.push(...aggregateFindings(workflow, jobs, file));
  findings.push(...withScriptFindings(workflow, file));
  findings.push(...environmentFindings(workflow, file));
  findings.push(...secretFindings(workflow, file));
  findings.push(...expectedJobFindings(workflow, file));
  findings.push(...expectedNeedsFindings(workflow, file));
  findings.push(...matrixFindings(workflow, file));
  findings.push(...guardedStepFindings(workflow, file));
  findings.push(...pagesDeployFindings(workflow, file));
  if (file === RELEASE_FILE) {
    for (const [name, expected] of Object.entries(RELEASE_JOB_ENV)) {
      const job = jobs[name];
      if (isMap(job)) findings.push(...jobEnvExactFindings(job, file, name, expected));
    }
  }
  if (file === 'checks.yml') {
    const on = isMap(workflow.on) ? workflow.on : {};
    if (!list(on.push?.tags).includes('v*')) findings.push(`${file}: Checks must run on v* tag pushes so the release can resolve them`);
    if (!list(on.push?.branches).includes('main')) findings.push(`${file}: Checks must run on main`);
    if (!Object.hasOwn(on, 'pull_request')) findings.push(`${file}: Checks must run on pull requests`);
    for (const [name, job] of Object.entries(jobs)) {
      if (name === AGGREGATE_JOB) continue;
      if (job.if != null) findings.push(`${file}: job "${name}" must not carry an if: (the gate runs on every trigger)`);
    }
    findings.push(...trustedStepFindings(jobs.policy, file, 'policy'));
    findings.push(...trustedStepFindings(jobs.required, file, 'required'));
    // The unprivileged legs publish the merge gate's answer. An extra step is a
    // place to run something else, so their step lists are exact too.
    for (const name of ['web', 'browser', 'android']) {
      findings.push(...expectedStepFindings(jobs[name], file, name, CHECKS_STEPS[name], { allowJobEnv: true }));
    }
    findings.push(...keystoreOrderFindings(jobs.android, file, 'android'));
  }
  if (file === 'checks.yml' && !jobs[AGGREGATE_JOB]) {
    findings.push(`${file}: job "${AGGREGATE_JOB}" is missing`);
  }
  return findings;
}

/**
 * The one gate-step grammar.
 *
 * A gate step's shell body must be exactly a contiguous slice of the job's
 * registered command list, optionally prefixed by `set -euo pipefail`. The
 * slices, in step order, must concatenate to the whole list exactly.
 *
 * Matching text is not enough: `if false; then <gate>; fi`, a here-doc, a
 * pipeline (`| cat`), `|| /bin/true`, a subshell, a brace group or a `sh -c`
 * wrapper all put commands around the registered one that a substring scan
 * never sees. Those forms add tokens, so the body is no longer the registered
 * sequence and the step is rejected. `set -euo pipefail` is the only accepted
 * preamble; every other command in a gate step is a finding.
 */
function gateStepFindings(job, file, jobName, required) {
  const findings = [];
  const observed = [];
  for (const step of stepsOf(job)) {
    const commands = stepCommands(step);
    if (!commands.length) continue;
    const body = commands[0] === GATE_PREAMBLE ? commands.slice(1) : commands;
    if (!body.some((command) => required.includes(command))) continue;

    findings.push(...maskedStepFindings(step, file, jobName, commands));
    const start = body.length ? required.indexOf(body[0]) : -1;
    const expected = start < 0 ? [] : required.slice(start, start + body.length);
    const exact =
      start >= 0 && body.length === expected.length && body.every((command, index) => command === expected[index]);
    if (!exact) {
      findings.push(
        `${file}: job "${jobName}" gate step must run only the registered commands; found ${JSON.stringify(body)}`
      );
      continue;
    }
    observed.push(...body);
  }
  if (observed.join('\n') !== required.join('\n')) {
    findings.push(
      `${file}: job "${jobName}" must run exactly these commands in order: ${required.join(' | ')}; found ${
        observed.join(' | ') || 'none'
      }`
    );
  }
  return findings;
}

/**
 * The throwaway key must be created before the build that consumes it. A
 * reordered workflow leaves `CI=true` with no key, which is a hard failure,
 * or worse, tempts someone to relax that rule instead.
 */
function keystoreOrderFindings(job, file, jobName) {
  const steps = stepsOf(job);
  const keystore = steps.findIndex((step) => stepCommands(step).includes(CI_KEYSTORE_COMMAND));
  const build = steps.findIndex((step) => stepCommands(step).includes('npm run build:android'));
  if (build < 0) return [];
  if (keystore < 0) {
    return [`${file}: job "${jobName}" must create the throwaway key with ${CI_KEYSTORE_COMMAND} before ${'npm run build:android'}`];
  }
  if (keystore > build) {
    return [`${file}: job "${jobName}" must create the throwaway key before npm run build:android`];
  }
  return [];
}

/** The one non-release environment the repository owns: Pages deployment. */
const PAGES_ENVIRONMENT = Object.freeze({
  name: 'github-pages',
  url: '${{ steps.deployment.outputs.page_url }}',
});

/**
 * Only `release.yml`'s `sign` job may enter the release environment, and only
 * as the literal string. A map or expression (`name: ${{ ... }}`) can resolve
 * to `release` at run time, so it is rejected everywhere else. The one other
 * declared environment is the Pages deployment's fixed map; anything else is a
 * secret grant this policy does not approve.
 */
function environmentFindings(workflow, file) {
  const findings = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!isMap(job) || job.environment == null) continue;
    const signOwner = file === RELEASE_FILE && name === 'sign' && job.environment === RELEASE_ENVIRONMENT;
    const pagesOwner = file === 'pages.yml' && name === 'deploy' && sameMap(job.environment, PAGES_ENVIRONMENT);
    if (signOwner || pagesOwner) continue;
    findings.push(
      `${file}: job "${name}" must not declare environment; only ${RELEASE_FILE}'s "sign" (release) and pages.yml's "deploy" (github-pages) may`
    );
  }
  return findings;
}

/**
 * A secret reference anywhere (workflow env, job env or condition, step env,
 * `with:`, `if:` or the `run:` body) is a grant of the secret. Only the signing
 * job may read one. The workflow env is read by every job, so it may never name
 * a secret even though `sign` is allowed to.
 */
function secretFindings(workflow, file) {
  const findings = [];
  if (SECRET_REFERENCE.test(JSON.stringify(workflow?.env ?? {}))) {
    findings.push(`${file}: the workflow env must not read secrets; only ${RELEASE_FILE}'s "sign" job may`);
  }
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!isMap(job)) continue;
    // An output is forwarded to another job. No job needs to forward a secret,
    // and the sign job is the one place a secret may be named at all.
    if (SECRET_REFERENCE.test(JSON.stringify(job.outputs ?? {}))) {
      findings.push(`${file}: job "${name}" outputs must not read secrets; only ${RELEASE_FILE}'s "sign" job may read one`);
    }
    if (file === RELEASE_FILE && name === 'sign') continue;
    const text = JSON.stringify([
      job.env ?? {},
      job.if ?? '',
      job.outputs ?? {},
      stepsOf(job).map((step) => ({ env: step.env ?? {}, with: step.with ?? {}, run: step.run ?? '', if: step.if ?? '' })),
    ]);
    if (SECRET_REFERENCE.test(text)) {
      findings.push(`${file}: job "${name}" must not read secrets; only ${RELEASE_FILE}'s "sign" job may`);
    }
  }
  return findings;
}

/**
 * The throwaway identity has one owner: `scripts/ci-keystore.mjs`. A workflow
 * that spells the password, DN or a raw `keytool -genkeypair` is a second
 * owner, so it is rejected even if it would work.
 */
function keystoreOwnershipFindings(text, file) {
  const findings = [];
  const source = String(text);
  if (source.includes(CI_THROWAWAY.password)) {
    findings.push(`${file}: must not hardcode the CI throwaway password; call ${CI_KEYSTORE_COMMAND}`);
  }
  if (source.includes(CI_THROWAWAY.dn)) {
    findings.push(`${file}: must not hardcode the CI throwaway DN; call ${CI_KEYSTORE_COMMAND}`);
  }
  if (/keytool\s+-genkeypair/.test(source)) {
    findings.push(`${file}: must not run a raw keytool -genkeypair; call ${CI_KEYSTORE_COMMAND}`);
  }
  return findings;
}

/**
 * Check one workflow's text against the general policy.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {string[]}
 */
export function checkWorkflow(text, { file = 'workflow' } = {}) {
  const { workflow, findings } = parseWorkflow(text);
  if (!workflow) return findings.map((finding) => `${file}: ${finding}`);
  return [
    ...findings.map((finding) => `${file}: ${finding}`),
    ...keystoreOwnershipFindings(text, file),
    ...parsedWorkflowFindings(workflow, file),
  ];
}

function jobEnvText(job) {
  return JSON.stringify([job?.env ?? {}, ...stepsOf(job).map((step) => step.env ?? {})]);
}

function jobLogic(workflow, name) {
  const job = workflow?.jobs?.[name];
  return stepsOf(job).flatMap(stepCommands).join('\n');
}

function triggerObject(workflow) {
  return isMap(workflow?.on) ? workflow.on : {};
}

function resolveBlock(workflow) {
  const job = workflow?.jobs?.resolve;
  return isMap(job) ? job : null;
}

function triggerFindings(workflow, file) {
  const findings = [];
  const on = triggerObject(workflow);
  if (!isMap(workflow?.on)) {
    return [`${file}: release must declare workflow_run and workflow_dispatch triggers`];
  }
  const run = on.workflow_run;
  if (!isMap(run)) {
    findings.push(`${file}: release must trigger on the Checks workflow`);
  } else {
    if (!list(run.workflows).includes('Checks')) findings.push(`${file}: the release workflow_run must name Checks`);
    if (!list(run.types).includes('completed')) findings.push(`${file}: the release workflow_run must wait for completion`);
  }
  if (!isMap(on.workflow_dispatch)) {
    findings.push(`${file}: release must allow workflow_dispatch`);
  } else {
    const inputs = on.workflow_dispatch.inputs;
    if (!isMap(inputs) || !isMap(inputs.tag) || inputs.tag.required !== true || inputs.tag.type !== 'string') {
      findings.push(`${file}: workflow_dispatch must require a tag or commit string input`);
    }
    if (!isMap(inputs?.publish) || inputs.publish.type !== 'boolean' || inputs.publish.default !== false) {
      findings.push(`${file}: workflow_dispatch publish must default to false`);
    }
  }
  for (const forbidden of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_call']) {
    if (on[forbidden] != null) findings.push(`${file}: release must not trigger on ${forbidden}`);
  }
  return findings;
}

function resolveFindings(workflow, file) {
  const findings = [];
  const job = resolveBlock(workflow);
  if (!job) return [`${file}: job "resolve" is missing`];
  if (job.environment != null) findings.push(`${file}: job "resolve" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "resolve" must not read secrets`);

  const expectedCondition =
    "github.event_name == 'workflow_dispatch' || (github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success')";
  findings.push(...exactConditionFindings(job.if, expectedCondition, file, 'job "resolve" if:'));
  findings.push(...expectedStepFindings(job, file, 'resolve', RELEASE_JOBS_STEPS.resolve, { allowJobEnv: true }));

  const outputs = isMap(job.outputs) ? job.outputs : {};
  const expectedOutputs = ['publish', 'ref', 'sha', 'tag', 'version'];
  for (const name of expectedOutputs) {
    const expected = `\${{ steps.tag.outputs.${name} }}`;
    if (outputs[name] !== expected) {
      findings.push(`${file}: job "resolve" output ${name} must be exactly ${expected}, not ${JSON.stringify(outputs[name] ?? null)}`);
    }
  }
  for (const name of Object.keys(outputs)) {
    if (!expectedOutputs.includes(name)) findings.push(`${file}: job "resolve" must not expose the unused output ${name}`);
  }

  const steps = stepsOf(job);
  if (!steps.some((step) => step.id === 'tag')) {
    findings.push(`${file}: job "resolve" must give the resolving step id: tag`);
  }
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) {
    findings.push(`${file}: job "resolve" must check out main`);
  } else {
    if (
      !sameMap(checkout.with, { ref: 'main', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false })
    ) {
      findings.push(`${file}: job "resolve" checkout must name exactly main with full history, tags and no credentials`);
    }
  }

  const logic = steps.flatMap(stepCommands).join('\n');
  const required = [
    [/git tag --points-at/, 'derive the tag from the resolved commit with git tag --points-at'],
    [/out "ref=/, 'report the ref the build checks out'],
    [/git merge-base --is-ancestor/, 'verify the commit is an ancestor of origin/main'],
    [/package\.json/, 'verify the tag version against package.json'],
    [/workflow_dispatch/, 'handle the manual dry run'],
    [/publish=true requires a release tag/, 'refuse publish=true with a commit SHA'],
    [/40-character SHA/, 'refuse a short commit SHA'],
  ];
  for (const [pattern, message] of required) {
    if (!pattern.test(logic)) findings.push(`${file}: job "resolve" must ${message}`);
  }
  if (!logic.includes('v[0-9]+\\.[0-9]+\\.[0-9]+')) {
    findings.push(`${file}: job "resolve" must keep only strict vMAJOR.MINOR.PATCH tags`);
  }
  if (logic.includes('head_branch')) {
    findings.push(`${file}: job "resolve" must derive the tag from the commit, not head_branch`);
  }
  if (jobEnvText(job).includes('head_branch') || String(job.if ?? '').includes('head_branch')) {
    findings.push(`${file}: job "resolve" must not depend on head_branch`);
  }
  return findings;
}

function jobGateFindings(workflow, file, name, required) {
  const job = workflow?.jobs?.[name];
  if (!isMap(job)) return [`${file}: job "${name}" is missing`];
  const findings = gateStepFindings(job, file, name, required);
  const steps = stepsOf(job);
  for (const command of required) {
    const holder = steps.find((step) => stepCommands(step).includes(command));
    if (holder && holder['working-directory'] !== '${{ env.RELEASE_TREE }}') {
      findings.push(`${file}: job "${name}" must run "${command}" in the resolved worktree`);
    }
  }
  return findings;
}

function buildFindings(workflow, file) {
  const required = [
    'test "$(git rev-parse HEAD)" = "$SHA"',
    'npm ci',
    'node scripts/find-chrome.mjs',
    'npm run verify:all',
    'node scripts/release-notes.mjs --tag "$TAG" --commit "$SHA" --out dist/notes.md',
    CI_KEYSTORE_COMMAND,
    'npm run build:android',
    'node scripts/release-provenance.mjs --sha "$SHA" --tag "$TAG" --version "$VERSION" --out dist/provenance.json',
    'git diff --exit-code',
    'test -z "$(git status --porcelain)"',
    'node scripts/check-apk.mjs --apk "dist/drypoint-${VERSION}-unsigned.apk" --aapt2 "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/aapt2" --apksigner "$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS/apksigner"',
  ];
  const findings = jobGateFindings(workflow, file, 'build', required);
  const job = workflow?.jobs?.build;
  if (!isMap(job)) return findings;
  if (job.environment != null) findings.push(`${file}: job "build" must not use the release environment`);
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "build" must not read secrets`);
  findings.push(
    ...exactConditionFindings(
      job.if,
      "needs.resolve.outputs.publish == 'true' || github.event_name == 'workflow_dispatch'",
      file,
      'job "build" if:'
    )
  );
  findings.push(...expectedStepFindings(job, file, 'build', RELEASE_JOBS_STEPS.build, { allowJobEnv: true }));
  findings.push(...buildOutputFindings(job, file));
  findings.push(...buildGateOrderFindings(job, file, 'build'));
  const steps = stepsOf(job);
  const checkout = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (!checkout) findings.push(`${file}: job "build" must check out main`);
  else {
    // The build's own checkout is a fixed ref. A dynamic ref here is the
    // CodeQL cache-poisoning pattern: the resolved tag/SHA must be data for
    // git, materialized below, not an actions/checkout target.
    if (!sameMap(checkout.with, { ref: 'main', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false })) {
      findings.push(`${file}: job "build" checkout must name exactly main with full history, tags and no credentials`);
    }
  }
  const materialize = steps.find((step) => step.env?.REF === '${{ needs.resolve.outputs.ref }}');
  if (!materialize) {
    findings.push(`${file}: job "build" must materialize needs.resolve.outputs.ref`);
  } else {
    const run = String(materialize.run ?? '');
    if (!/git worktree add --detach/.test(run)) {
      findings.push(`${file}: job "build" must materialize the resolved ref as a detached worktree`);
    }
    if (!run.includes('"$REF"')) {
      findings.push(`${file}: job "build" must materialize "$REF", never a movable branch name`);
    }
    if (!run.includes('RELEASE_TREE') || !run.includes('GITHUB_ENV')) {
      findings.push(`${file}: job "build" must export RELEASE_TREE to later steps`);
    }
  }
  if (!steps.some((step) => stepCommands(step).some((command) => command.startsWith('node scripts/check-apk.mjs')))) {
    findings.push(`${file}: job "build" must check the built APK`);
  }
  for (const [flag, target] of [
    ['--version-code', 'dist/version-code.txt'],
    ['--signing-scheme', 'dist/signing.json'],
  ]) {
    if (!steps.some((step) => stepCommands(step).some((command) => command.includes(flag) && command.includes(target)))) {
      findings.push(`${file}: job "build" must publish ${target} from build-android.mjs ${flag}`);
    }
  }
  findings.push(...keystoreOrderFindings(job, file, 'build'));
  if (
    JSON.stringify(job.env ?? {}).includes('ANDROID_ALLOW_TEST_KEY') ||
    steps.some((step) => JSON.stringify(step.env ?? {}).includes('ANDROID_ALLOW_TEST_KEY'))
  ) {
    findings.push(`${file}: job "build" must not set ANDROID_ALLOW_TEST_KEY itself; ${CI_KEYSTORE_COMMAND} owns the flag`);
  }
  const upload = steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  if (!upload) {
    findings.push(`${file}: job "build" must upload the unsigned artifact`);
  } else {
    if (upload.with?.name !== 'drypoint-unsigned') findings.push(`${file}: job "build" must upload the artifact as drypoint-unsigned`);
    if (upload.with?.path !== '${{ env.RELEASE_TREE }}/dist/*') {
      findings.push(`${file}: job "build" upload path must be exactly \${{ env.RELEASE_TREE }}/dist/*`);
    }
  }
  return findings;
}

function signFindings(workflow, file) {
  const findings = [];
  const job = workflow?.jobs?.sign;
  if (!isMap(job)) return [`${file}: job "sign" is missing`];
  if (job.environment !== 'release') findings.push(`${file}: job "sign" must use the release environment`);
  findings.push(
    ...exactConditionFindings(
      job.if,
      "needs.resolve.outputs.publish == 'true' || github.event_name == 'workflow_dispatch'",
      file,
      'job "sign" if:'
    )
  );
  findings.push(...expectedStepFindings(job, file, 'sign', RELEASE_JOBS_STEPS.sign, { allowJobEnv: true }));
  findings.push(...sourceFindings(job, file, 'sign'));
  if (job.permissions?.contents !== 'read') findings.push(`${file}: job "sign" permissions must include contents: read`);
  if (job.permissions?.['id-token'] !== 'write') findings.push(`${file}: job "sign" must request id-token: write`);
  if (job.permissions?.attestations !== 'write') findings.push(`${file}: job "sign" must request attestations: write`);
  if (!jobEnvText(job).includes('vars.RELEASE_CERT_SHA256')) {
    findings.push(`${file}: job "sign" must compare the signer with vars.RELEASE_CERT_SHA256`);
  }
  if (!jobEnvText(job).includes('vars.ANDROID_KEY_ALIAS')) {
    findings.push(`${file}: job "sign" must read the alias from vars.ANDROID_KEY_ALIAS, not a secret`);
  }
  if (!jobEnvText(job).includes('secrets.ANDROID_KEYSTORE_BASE64')) {
    findings.push(`${file}: job "sign" must decode the keystore from the release environment`);
  }
  const signText = JSON.stringify(job);
  for (const [needle, message] of [
    ['ANDROID_ALLOW_TEST_KEY', 'must never set ANDROID_ALLOW_TEST_KEY'],
    ['ci-keystore', 'must never run the CI throwaway keystore script'],
    [CI_THROWAWAY.password, 'must never contain the CI throwaway password'],
  ]) {
    if (signText.includes(needle)) findings.push(`${file}: job "sign" ${message}`);
  }
  // The exact step table above owns every byte of the sign script. These
  // checks remain structural invariants: the signing job must never check out
  // or execute repository code, whatever the table says.
  for (const step of stepsOf(job)) {
    if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
      findings.push(`${file}: job "sign" must not check out repository code`);
    }
    for (const command of stepCommands(step)) {
      const tokens = shellTokens(command);
      if (tokens[0] === 'npm' || tokens[0] === 'node' || tokens[0] === 'npx') {
        findings.push(`${file}: job "sign" must not execute repository code: "${command}"`);
      }
      if (command.includes('scripts/')) {
        findings.push(`${file}: job "sign" must not execute repository scripts: "${command}"`);
      }
    }
  }
  return findings;
}

function publishFindings(workflow, file) {
  const findings = [];
  const job = workflow?.jobs?.publish;
  if (!isMap(job)) return [`${file}: job "publish" is missing`];
  if (job.permissions?.contents !== 'write') findings.push(`${file}: job "publish" must hold contents: write`);
  for (const [scope, level] of Object.entries(job.permissions ?? {})) {
    if (scope !== 'contents' && level === 'write') findings.push(`${file}: job "publish" must not hold ${scope}: write`);
  }
  if (jobEnvText(job).includes('secrets.')) findings.push(`${file}: job "publish" must not read secrets`);
  if (job.env?.GH_REPO !== '${{ github.repository }}') {
    findings.push(
      `${file}: job "publish" must set GH_REPO to \${{ github.repository }}; it has no checkout for gh to discover one`
    );
  }
  findings.push(...exactConditionFindings(job.if, "needs.resolve.outputs.publish == 'true'", file, 'job "publish" if:'));
  findings.push(...expectedStepFindings(job, file, 'publish', RELEASE_JOBS_STEPS.publish, { allowJobEnv: true }));
  findings.push(...sourceFindings(job, file, 'publish'));
  for (const step of stepsOf(job)) {
    if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
      findings.push(`${file}: job "publish" must not check out repository code`);
    }
    const commands = stepCommands(step);
    for (const command of commands) {
      const tokens = shellTokens(command);
      if (tokens[0] === 'npm' || tokens[0] === 'node' || tokens[0] === 'npx') {
        findings.push(`${file}: job "publish" must not execute repository code: "${command}"`);
      }
      if (command.includes('scripts/')) findings.push(`${file}: job "publish" must not execute repository scripts: "${command}"`);
    }
  }
  // Publish is a command allowlist. `gh release upload --clobber` can replace
  // an asset after the byte comparison; delete/api/raw shell can do worse.
  // `gh attestation verify` is the one non-release command: it only checks the
  // existing bundle and must name the bundle, the repository and the signer.
  const allowedRelease = new Set(['view', 'download', 'create', 'edit']);
  for (const command of stepsOf(job).flatMap(stepCommands)) {
    const tokens = shellTokens(command);
    if (['curl', 'wget', 'eval', 'bash', 'sh', 'zsh'].includes(tokens[0])) {
      findings.push(`${file}: job "publish" must not run ${tokens[0]}: "${command}"`);
    }
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] !== 'gh') continue;
      if (tokens[index + 1] === 'attestation') {
        if (tokens[index + 2] !== 'verify') {
          findings.push(`${file}: job "publish" may only run gh attestation verify`);
          break;
        }
        for (const flag of ['--bundle', '-R', '--signer-workflow', '--predicate-type', '--format']) {
          if (!tokens.includes(flag)) findings.push(`${file}: job "publish" gh attestation verify must pass ${flag}`);
        }
        const bundle = tokens[tokens.indexOf('--bundle') + 1];
        if (bundle !== '$existing_bundle') {
          findings.push(`${file}: job "publish" gh attestation verify must read the downloaded existing bundle`);
        }
        if (!tokens.includes('LLM-4-People/drypoint/.github/workflows/release.yml')) {
          findings.push(`${file}: job "publish" gh attestation verify must pin the signer workflow`);
        }
        if (!tokens.includes('https://slsa.dev/provenance/v1')) {
          findings.push(`${file}: job "publish" gh attestation verify must pin the SLSA v1 predicate type`);
        }
        continue;
      }
      if (tokens[index + 1] !== 'release') {
        findings.push(`${file}: job "publish" may only run gh release commands: "${command}"`);
        break;
      }
      const subcommand = tokens[index + 2];
      if (!allowedRelease.has(subcommand)) {
        findings.push(`${file}: job "publish" must not run gh release ${subcommand}`);
        break;
      }
      if (subcommand === 'edit' && !tokens.includes('--notes-file')) {
        findings.push(`${file}: job "publish" may only edit the notes body`);
      }
      if (tokens.includes('--clobber') && subcommand !== 'download') {
        findings.push(`${file}: job "publish" may only use --clobber on gh release download`);
      }
    }
  }
  const logic = jobLogic(workflow, 'publish');
  if (logic.includes('GITHUB_REF_NAME')) findings.push(`${file}: job "publish" must use $TAG, never GITHUB_REF_NAME`);
  const publishes = workflowCommands(workflow).filter(isPublishCommand);
  if (publishes.length !== 1) {
    findings.push(`${file}: job "publish" must contain exactly one gh release create command`);
  }
  return findings;
}

function existingReleaseFindings(workflow, file) {
  const findings = [];
  const publish = workflow?.jobs?.publish;
  if (!isMap(publish)) return findings;
  const logic = jobLogic(workflow, 'publish');
  for (const [pattern, message] of [
    [/gh release view "\$TAG"/, 'detect an existing release'],
    [/gh release download "\$TAG"/, 'download the existing assets'],
    [/cmp -s/, 'compare the existing APK and checksum byte-for-byte'],
    [/differs from this build/, 'fail when an existing asset differs'],
    [/gh attestation verify "\$existing_apk"/, 'verify the existing bundle signature and signer'],
    [/--format json > "\$RUNNER_TEMP\/verified\.json"/, 'parse only the existing attestations gh verified'],
    [/existing_bundle="\$RUNNER_TEMP\/existing\//, 'verify the bundle the release downloaded'],
    [/does not bind the published APK/, 'fail when the existing attestation binds another commit'],
    [/any\(\$statements\[\];/, 'accept a verified statement that binds the resolved commit'],
    [/exit 0/, 'treat an identical existing release as a pass'],
    [/--latest/, 'mark the release latest'],
    [/--notes-file/, 'publish the generated notes'],
    [/gh release edit "\$TAG"[^\n]*--notes-file/, 'refresh the notes on a re-run instead of exiting with a stale body'],
  ]) {
    if (!pattern.test(logic)) findings.push(`${file}: job "publish" must ${message}`);
  }
  return findings;
}

/**
 * Check the release workflow: trusted triggers, resolved publish command and
 * the split build/sign/publish authority.
 *
 * @param {string} text
 * @param {{file?: string}} [options]
 * @returns {string[]}
 */
export function checkReleaseWorkflow(text, { file = RELEASE_FILE } = {}) {
  const { workflow, findings: parseFindings } = parseWorkflow(text);
  if (!workflow) return parseFindings.map((finding) => `${file}: ${finding}`);
  const findings = [...parseFindings.map((finding) => `${file}: ${finding}`)];
  findings.push(...triggerFindings(workflow, file));
  findings.push(...resolveFindings(workflow, file));
  findings.push(...buildFindings(workflow, file));
  findings.push(...signFindings(workflow, file));
  findings.push(...publishFindings(workflow, file));
  findings.push(...existingReleaseFindings(workflow, file));
  findings.push(...releaseUploadFindings(workflow, file));

  const publishes = publishCommands(text);
  const quoted = shellCommands(text).filter((command) => /^\s*(['"])gh\1\s+release\s+create\b/.test(command));
  for (const command of quoted) findings.push(`${file}: the gh command name must not be quoted: "${command}"`);
  const wrapped = shellCommands(text).filter(
    (command) => /^\s*(?:eval|bash|sh|zsh)\b/.test(command) && /\bgh\s+release\s+create\b/.test(command)
  );
  for (const command of wrapped) findings.push(`${file}: the publish command must not be wrapped in eval or a shell: "${command}"`);
  const decoys = shellCommands(text).filter(
    (command) => !isPublishCommand(command) && shellTokens(command).includes('--verify-tag')
  );
  for (const command of decoys) {
    findings.push(`${file}: --verify-tag must appear only on the gh release create command: "${command}"`);
  }
  if (!publishes.length) {
    findings.push(`${file}: no gh release create command found`);
  } else if (publishes.length !== 1) {
    findings.push(`${file}: exactly one gh release create command is allowed, found ${publishes.length}`);
  } else if (!shellTokens(publishes[0]).includes('--verify-tag')) {
    findings.push(`${file}: the release must pass --verify-tag on the gh release create command itself`);
  }
  if (text.includes('GITHUB_REF_NAME')) findings.push(`${file}: the release must not use GITHUB_REF_NAME`);
  return findings;
}

/**
 * Check every workflow in a tree.
 *
 * @param {{root?: string, workflows?: string}} [options]
 *   `workflows` is an explicit directory to scan as data; `root` is the
 *   repository root used for the default directory.
 * @returns {Promise<{findings: string[], files: string[]}>}
 */
export async function checkWorkflows({ root = ROOT, workflows } = {}) {
  const directory = workflows ? resolve(workflows) : join(root, WORKFLOW_DIR);
  const names = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const findings = [];
  for (const name of names) {
    if (!OWNED_WORKFLOWS.includes(name)) {
      findings.push(
        `${name}: workflow is not owned; GitHub runs every .yml/.yaml file, so the owned set is exactly ${OWNED_WORKFLOWS.join(', ')}`
      );
    }
  }
  for (const name of OWNED_WORKFLOWS) {
    if (!names.includes(name)) findings.push(`${name}: owned workflow is missing`);
  }
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');
    // The general policy (environment, secrets, permissions, pins, masks) is
    // applied to every file, not only the release workflow.
    findings.push(...checkWorkflow(text, { file: name }));
    if (basename(name) === RELEASE_FILE) findings.push(...checkReleaseWorkflow(text, { file: name }));
  }
  if (!names.length) findings.push(`${directory}: no workflows found`);
  return { findings, files: names };
}

async function main(argv) {
  let list = false;
  let workflows = '';
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--list') list = true;
    else if (argument === '--workflows') {
      workflows = argv[++index] ?? '';
      if (!workflows) {
        console.error('workflows: --workflows needs a directory');
        return 2;
      }
    } else {
      console.error(`workflows: unknown option ${argument}`);
      console.error('usage: node scripts/check-workflows.mjs [--list] [--workflows <dir>]');
      return 2;
    }
  }
  const { findings, files } = await checkWorkflows(workflows ? { workflows } : {});
  if (list) console.log(`workflows: ${files.length} files checked`);
  if (!findings.length) return 0;
  for (const finding of findings) console.error(finding);
  console.error(`workflows: ${findings.length} finding(s) in ${files.length} files`);
  return 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`workflows: ${error.message}`);
      process.exitCode = 1;
    }
  );
}
