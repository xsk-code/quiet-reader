# Third-party resources

The project's MIT license applies to its own code and documentation. The following
resources retain their respective licenses.

## PT Serif

- Copyright 2010 ParaType Ltd.; reserved names: PT Sans, PT Serif and ParaType.
- License: SIL Open Font License 1.1, included in [OFL.txt](public/fonts/pt-serif/OFL.txt).
- Provenance and embedded metadata: [SOURCE.txt](public/fonts/pt-serif/SOURCE.txt).
- Upstream: <https://github.com/google/fonts/tree/main/ofl/ptserif>.
- The bundled files are the unmodified Google Fonts "latin" WOFF2 subsets; source
  URLs and SHA-256 checksums are listed in SOURCE.txt. The reader uses
  project-authored CSS in `public/reading.css`.

## Runtime dependencies

Installed through `npm ci`; exact versions and integrity hashes are recorded in
`package-lock.json`. Their license files remain in their packages under `node_modules/`.

| Package | License |
| --- | --- |
| @mozilla/readability | Apache-2.0 |
| DOMPurify | MPL-2.0 OR Apache-2.0 |
| JSDOM | MIT |
| Marked | MIT |
| Turndown | MIT |
| turndown-plugin-gfm | MIT |

Dependency code is not copied into this repository. The local server serves the
installed Marked and DOMPurify browser builds from `node_modules/`. If you redistribute
a bundle containing dependencies, preserve their own license and notice files,
including those of transitive dependencies.

## FxTwitter / FxEmbed (external service, not bundled)

- Project: FxEmbed, home of FxTwitter — <https://github.com/FxEmbed/FxEmbed>,
  documentation at <https://docs.fxembed.com>.
- License: MIT. Copyright (c) 2022-2026 dangered wolf and FxEmbed contributors.
- What this project uses: the public JSON endpoints at `https://api.fxtwitter.com`,
  called at runtime when a pasted X link only exposes its body to signed-in
  browsers. No FxEmbed source code is copied into this repository.
- Configuration: `READER_X_API` points at a self-hosted deployment; `off`
  disables the request and the reader falls back to clipboard import.
- Why it is credited: the endpoint and its schema are FxEmbed's work, and the
  reader's X support depends on that service staying available.

Imported articles, original images and model outputs remain in the user's local
`data/` directory. They are not included in the source distribution, and the project's
MIT license does not grant rights to third-party article content.
