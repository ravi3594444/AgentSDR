# Vendored dependencies

## `xlsx-0.20.3.tgz` — SheetJS Community Edition 0.20.3

Every `xlsx` release on the npm registry (last: 0.18.5) is affected by
two advisories that SheetJS fixed only in builds it publishes on its own CDN:

| Advisory | Issue | Fixed in |
| --- | --- | --- |
| [CVE-2023-30533 / GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) | Prototype pollution when reading a crafted file | 0.19.3 |
| [CVE-2024-22363 / GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) | Regular-expression denial of service | 0.20.2 |

`package.json` installs `xlsx` from this file (`file:vendor/xlsx-0.20.3.tgz`),
following [SheetJS's own installation guidance](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
to vendor the tarball so installs and Docker builds do not depend on
cdn.sheetjs.com being reachable.

- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz (downloaded 2026-10-13)
- SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- Integrity recorded in `bun.lock`: `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
- No runtime dependencies and no install scripts.

`src/lib/spreadsheet/read.test.ts` fails if a reinstall puts a release older
than 0.20.2 back. To upgrade: download the new tarball from cdn.sheetjs.com,
replace the file here, `bun add xlsx@file:vendor/<new file>`, update this
note, and run `bun run test`. Do not `bun update xlsx` — that resolves to the
npm registry build.
