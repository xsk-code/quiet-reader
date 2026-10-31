# v0.1.0 release checklist

Use this for the first public release. It assumes the private repository has
already run CI; it does not publish anything by itself.

## Before making the repository public

### Source and history

- [ ] Work tree is clean and `main` is pushed to the private origin.
- [ ] Run a full-history secret scan (`gitleaks` or `trufflehog`), not only a
      working-tree scan.
- [ ] Create the public repository from a reviewed source snapshot or a single
      initial commit; do not expose the private development history.
- [ ] Confirm commit author metadata is acceptable for public view.
- [ ] Confirm `release/` is not uploaded; it contains local validation notes.
- [ ] Confirm `data/`, `.env`, logs, credentials and `node_modules/` are ignored.

### License and provenance

- [ ] Verify `LICENSE`, `THIRD_PARTY_NOTICES.md`, PT Serif OFL and dependency
      licenses.
- [ ] Re-download the bundled fonts from the upstream source and record checksums
      in `public/fonts/pt-serif/SOURCE.txt`; do not rely on a local application
      copy as provenance.
- [ ] Confirm screenshots use project-authored sample content and are real PNG/JPEG.
- [ ] Confirm no article text, private data or real keys appear in docs or tests.

### Verification

- [ ] `npm ci`
- [ ] `npm test` on macOS/Linux and Windows
- [ ] `npm run verify`
- [ ] Fresh install opens the API setup; saving a valid API enables import. Local
      Agent access is verified separately through environment variables.
- [ ] Import provider selector hides with one usable provider and appears with
      multiple providers.
- [ ] Save a key from the setup page; confirm it is not returned, not in
      `settings.json`/localStorage, and environment variables override it.
- [ ] `npm run doctor -- --json --require-model`
- [ ] `npm run doctor -- --probe` against one real text endpoint (may cost)
- [ ] One full translation of `examples/sample.md` through the real API
- [ ] One real vision request if an image provider is advertised
- [ ] `npm run extension:zip`; extract the archive and confirm `manifest.json` is
      at its root, only runtime files are present, and the printed SHA-256 matches
- [ ] Load the unpacked extension in a clean Chrome/Edge profile; import one
      article and confirm the reader opens; stop the service and confirm the
      `/?pending=<url>` fallback
- [ ] Record results in `docs/COMPATIBILITY.md`; mark untested providers clearly

### Repository settings

- [ ] Enable private vulnerability reporting.
- [ ] Enable secret scanning and push protection.
- [ ] Enable Dependabot alerts; keep major upgrades out of automatic PRs unless
      reviewed.
- [ ] After the repository is public, enable branch protection and require the
      CI checks.
- [ ] Optionally enable CodeQL and GitHub Discussions for provider reports.

### Release artifact

- [ ] Update `CHANGELOG.md` and `docs/RELEASE_NOTES_0.1.0.md`.
- [ ] Run `npm run extension:zip`; attach the zip and SHA-256 to the release if
      the extension is distributed outside the source archive.
- [ ] If publishing to Chrome Web Store / Edge Add-ons, upload the zip and verify
      permissions, privacy disclosures and the local-service requirement.
- [ ] Create tag `v0.1.0` from the reviewed commit.
- [ ] Run `npm run release:source`; publish the tarball and SHA-256.
- [ ] Verify the tarball extracts into a clean directory and passes `npm ci`,
      `npm test`, `npm run verify`.
- [ ] Do not upload a stale `release/` snapshot.

## After the first public push

- [ ] Confirm the public CI run is green on all six jobs.
- [ ] Confirm branch protection and required checks are active.
- [ ] Confirm secret scanning, Dependabot and private advisories are active.
- [ ] Monitor the first issues and provider reports.
- [ ] Update `docs/COMPATIBILITY.md` with any newly verified endpoint.
