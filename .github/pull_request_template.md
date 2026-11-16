## Summary

What changed, and why. Link the issue when there is one: Fixes #123.

## Target branch

- [ ] This pull request targets `main`, not another branch.

## Verification

Paste the output of the commands you actually ran. Do not tick a box for a
command you did not run.

- [ ] `npm ci`: installs the one dev-only dependency (the workflow policy parser)
- [ ] `npm run verify`: brand, precache, privacy, tests, docs, workflows
- [ ] `npm run test:browser`: the measured browser suites (needs Chromium)
- [ ] `npm run build:android`: the APK still builds and signs
- [ ] `node scripts/build-pages.mjs`: the Pages tree still stages
- [ ] Nothing here: explain why, and what you verified instead.

```
paste the relevant output here
```

## Breaking change

- [ ] No.
- [ ] Yes: what breaks, and who has to adapt:

## Docs and safety

- [ ] I did not edit a generated file by hand (`manifest.webmanifest`,
      `src/core/brand.js`, `assets/icon.svg`, `assets/precache.js`, the `sw.js`
      build stamp, `android/.../strings.xml`); I edited its owner and
      regenerated.
- [ ] New or renamed files are in the module map in `docs/ARCHITECTURE.md`, and
      new `package.json` scripts are documented in the README.
- [ ] No secrets, keystores, printer serials, Bluetooth addresses or home
      directory paths are included.
- [ ] If this touches the print gate, a protocol decoder, the signing path or
      the app-surface allowlist, I explained above how I verified the failure
      and the fix.
- [ ] Documentation is updated where public behaviour, commands or the support
      matrix changed.
