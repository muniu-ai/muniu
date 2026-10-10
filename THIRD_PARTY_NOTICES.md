# Third-party notices

Muniu is licensed under Apache License 2.0 except where a file or directory states otherwise. Locked npm and Cargo dependencies remain the property of their copyright holders. Release artifacts include the applicable license inventories, notices, SBOM, and checksums.

## DeepSeek Harness architecture reference

The Agent OS 0.2 contracts, kernel, and agent runtime use the architecture document below as a reference for Cordis composition, lifecycle scopes, Agent inbox and turn boundaries, and the append-only Session Log and derived Surface:

- Project: DeepSeek Harness
- Repository: https://github.com/deepseek-ai/deepseek-harness
- Fixed reference commit: `141eb6fef83422698aef7a981029e843e8161534`
- Reference path: `docs/architecture.md`
- Copyright: Copyright (c) 2026 DeepSeek
- License: MIT; see `LICENSES/MIT.txt`
- Provenance: `docs/upstream-provenance/deepseek-harness.yaml`

No non-vendored DeepSeek Harness source file is copied or adapted in the current tree. The three referenced Muniu workspaces are clean-room implementations licensed under Apache-2.0. Reference-only entries do not create source-level MIT exceptions; the manifest's `files` list is authoritative for those exceptions.

The private Cordis framework snapshot under `vendor/` is separately fixed to commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Its package-level MIT licenses, source manifest, local build-only adaptation log, and provenance are recorded under `vendor/` and `docs/upstream-provenance/deepseek-harness-cordis.yaml`.

Every copied or adapted file must retain its upstream copyright and MIT notice and have an exact local-path mapping. `vendor/SOURCE_MANIFEST.sha256` verifies the vendored source files. A missing file, stale mapping, unapproved commit, or digest mismatch blocks release.

Muniu and 木牛 are independent project names. Use of DeepSeek Harness source does not grant rights to DeepSeek names, logos, or trademarks and does not imply endorsement.

## Explicitly excluded upstream payloads

Muniu Agent OS 0.2 does not redistribute the Anthropic Claude Agent SDK or platform payloads referenced by upstream notices, DSH Web/CLI, ACP, Linux Landlock binaries, telemetry, anonymous identifiers, or feedback-upload modules. An upstream repository's authorization for a component does not automatically authorize redistribution by Muniu.

## Other licenses

`LICENSES/BSD-3-Clause.txt` is available for components that use that license. Its presence does not prove that any particular component is shipped.

`THIRD_PARTY_NPM_LICENSES.json` and `THIRD_PARTY_CARGO_LICENSES.json` record locked dependency licenses. The release-time inventories and SPDX SBOM are authoritative for the bytes in a release artifact.

## Noto Sans CJK export font

The unmodified `NotoSansCJKsc-Regular.otf` used by local PDF export is from `notofonts/noto-cjk` commit `523d033d6cb47f4a80c58a35753646f5c3608a78`, upstream path `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`. Copyright © 2014–2021 Adobe. It is distributed under SIL Open Font License 1.1, not Apache-2.0. The exact upstream license, SHA-256 hashes and source manifest are retained in `apps/host/assets/fonts/noto-sans-cjk/`. The PDF renderer embeds subsets without modifying the shipped font. No system font is copied and no font is fetched during export.

Local export uses the locked PDFKit, fontkit and yazl packages; their licenses and integrity values are recorded in `THIRD_PARTY_NPM_LICENSES.json`.

PDFKit's transitive dependency `png-js` 2.0.0 includes an MIT license but omits the `license` field in its package metadata. Its unmodified license and copyright notice (Copyright (c) 2017 Devon Govett) are retained in `LICENSES/png-js-MIT.txt`. `docs/upstream-provenance/npm-license-evidence.json` pins the npm tarball URL, integrity and original license SHA-256. The inventory and policy check use this evidence only when both the installed package and retained notice match; other missing or unknown licenses continue to fail the gate.
