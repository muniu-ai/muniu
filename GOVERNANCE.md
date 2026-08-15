# Project governance

Muniu uses a maintainer-led, contribution-friendly governance model during the
v0.1 Developer Preview.

## Roles

- Contributors submit DCO-signed changes, documentation, reviews, or issue
  reports.
- Reviewers are contributors trusted to provide technical review.
- Maintainers may merge, revert, release, manage security reports, and update
  project policy. Maintainer access is granted by existing maintainers after
  sustained, constructive participation and a security review.

Repository permissions are represented by the protected settings and teams in
the muniu-ai GitHub organization. Access may be removed for inactivity,
security risk, or violation of the Code of Conduct.

## Decisions

Routine decisions use reviewed pull requests and rough consensus. Changes to
public protocols, licensing, security boundaries, governance digests, release
artifacts, or upstream provenance require an ADR or approved design plan and
at least two maintainer approvals once two eligible maintainers exist. Before
then, the initial maintainer records the decision and its rationale publicly.

Security fixes may be developed privately and merged with limited disclosure
until coordinated release. Emergency reverts may bypass normal review but
must receive a retrospective review.

## Releases

Only protected branches and immutable semantic-version tags may create
release artifacts. CI builds the exact bytes, SBOM, checksums, and provenance.
A published version is never overwritten; fixes receive a new patch version.

## Changes to governance

Governance changes use a pull request, explain the motivation and transition,
and remain open for public comment for at least seven days unless they address
an active security incident.
