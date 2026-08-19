# Third-party notices

Muniu is licensed under Apache License 2.0 except where a file or directory
states otherwise. Locked npm and Cargo dependency licenses remain the property
of their respective copyright holders and are checked by the repository license
policy. Shipped dependency notices are included in release SBOM and notice
artifacts.

## DeepSeek Harness

Selected Agent, Session, Scope, Tool Runtime, System Prompt, and LLM Runtime
source may be adapted from DeepSeek Harness:

- Project: DeepSeek Harness
- Repository: https://github.com/deepseek-ai/deepseek-harness
- Fixed source commit: 47f943859bef60e4160492346772ded9b24f765a
- Copyright: Copyright (c) 2026 DeepSeek
- License: MIT; see LICENSES/MIT.txt
- Provenance: docs/upstream-provenance/deepseek-harness.yaml

The private Cordis framework snapshot is separately fixed to commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Its package-level MIT licenses,
source manifest, local build-only adaptation log, and provenance are recorded
under `vendor/` and `docs/upstream-provenance/deepseek-harness-cordis.yaml`.

Any copied or adapted file must retain its upstream copyright and MIT notice.
Muniu and 木牛 are independent project names. Use of DeepSeek Harness source
does not grant rights to DeepSeek names, logos, or trademarks and does not
imply endorsement.

Muniu v0.1 selectively copies or adapts the protocol, session, LLM, tool,
agent-loop, and prompt files enumerated in the provenance manifest. The
manifest is authoritative for the exact upstream/local path mapping and
adaptation summary; no unlisted upstream directory or Git history is shipped.

## Explicitly excluded upstream payloads

Muniu v0.1.0 does not redistribute the Anthropic Claude Agent SDK or platform
payloads referenced by the upstream notice, DSH CLI/Web, ACP, Linux Landlock
binaries, telemetry, anonymous identifier, or feedback upload modules. The
upstream repository's authorization for a component does not automatically
apply to redistribution by Muniu.

## Other licenses

LICENSES/BSD-3-Clause.txt is provided for components that may use that license.
Its presence is not evidence that an excluded upstream component was shipped.
The release-time license inventory and CycloneDX SBOM are authoritative for
the bytes in each release artifact.

### libphonenumber-js

`@mn/data-policy` uses `libphonenumber-js` 1.13.9 for exact mobile-number
validation. The dependency is licensed under MIT, has no runtime dependencies,
and is represented by the exact lockfile entry and its copyright-bearing MIT
license text in `LICENSES/libphonenumber-js-MIT.txt`.
