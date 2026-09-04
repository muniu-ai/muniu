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
