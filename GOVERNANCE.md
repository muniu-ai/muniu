# Project governance

Muniu Agent OS 0.2 uses a maintainer-led, contribution-friendly governance model.

## Roles

- Contributors submit DCO-signed code, documentation, reviews, designs, or issue reports.
- Reviewers are contributors trusted to provide technical and product review.
- Maintainers may merge, revert, release, manage security reports, rotate plugin trust roots, and update project policy.

Existing maintainers grant reviewer and maintainer access after sustained constructive participation and a security review. Repository permissions are represented by protected settings and teams in the `muniu-ai` GitHub organization. Access may be removed for inactivity, security risk, or a Code of Conduct violation.

## Decisions

Routine decisions use reviewed pull requests and rough consensus. Changes to public contracts, event semantics, trust boundaries, licensing, governance rules, release artifacts, cryptographic formats, plugin supply-chain policy, or upstream provenance require an ADR or approved design plan.

Such changes require two maintainer approvals once two eligible maintainers exist. Until then, the initial maintainer records the decision and rationale publicly. Security fixes may be developed privately until coordinated disclosure. Emergency reverts may bypass normal review but require a retrospective review.

## Releases

Only protected branches and immutable semantic-version tags may create release artifacts. CI builds the exact source archive, binaries, container images, SBOM, checksums, license inventories, and provenance. Published tags and artifacts are never overwritten; fixes receive a new patch version.

Agent OS 0.2 uses a hard version boundary. Enterprise upgrades use blue-green replacement of a matching Host, Worker, engine lock, and plugin lock set; mixed-version rolling updates are not approved.

## Plugin trust

Production plugins are process-equivalent trusted code. Adding or rotating a repository signing key, changing revocation behavior, or approving a new publisher is a security-sensitive governance decision. Every change must preserve an auditable release sequence, exact dependency versions, package hashes, and revocation metadata.

## Changes to governance

Governance changes use a pull request that explains the motivation, security impact, and transition. The proposal remains open for public comment for at least seven days unless it responds to an active security incident.
