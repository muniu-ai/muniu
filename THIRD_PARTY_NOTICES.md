# Third-party notices

Muniu is licensed under Apache License 2.0 except where a file or directory
states otherwise. Runtime dependency licenses remain the property of their
respective copyright holders and are included in release SBOM and notice
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

Any copied or adapted file must retain its upstream copyright and MIT notice.
Muniu and 木牛 are independent project names. Use of DeepSeek Harness source
does not grant rights to DeepSeek names, logos, or trademarks and does not
imply endorsement.

At this baseline no DeepSeek Harness source file is copied into a Muniu
workspace package. Later sub-plans must add a per-file provenance entry before
committing each copied or adapted file.

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

