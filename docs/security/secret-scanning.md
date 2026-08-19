# Secret scanning policy

Muniu CI runs gitleaks 8.30.1 against the complete Git history and then runs the repository scanner against the current tree. The gitleaks release archive is verified with the checksum published for that release. Checkout depth is zero so the history gate cannot silently degrade to a shallow scan.

Allowlist entries must combine a rule ID, an anchored path, and an exact value expression. Exceptions for imported history are additionally restricted to the single commit that introduced the finding. Directory-wide, rule-wide, and entropy-wide exclusions are not accepted.

## Reviewed baseline findings

The imported source snapshot at commit `5f97c6e0816b373494668d78018b50d85c155ff7` and the data-policy fixture introduced at commit `cc24a870c529a6c9d2ce3d77ba5246f241a5186d` produce eleven findings: ten `generic-api-key` findings and one `jwt` finding. No value was accepted merely because it lived under a test directory.

| Scope | Findings | Review evidence |
| --- | ---: | --- |
| Data-policy keychain reference tests | 2 | Both findings are the same fixed base64 text inside synthetic keychain URI fixtures. The test verifies that references survive business-data redaction and never contacts a keychain or remote service. |
| Loop measurement and sandbox-attestation tests | 3 | Fixed literals are passed only to deterministic signing/verification helpers inside isolated unit tests. They contain patterned hexadecimal test material and have no provider prefix or external account. |
| Artifact remote-store test | 1 | The extracted value is a TypeScript helper identifier imported from the module under test, not credential data. |
| Worker security-gate test | 1 | The test deliberately writes a synthetic key-shaped literal, asserts that the security gate fails, and asserts that evidence does not contain the literal. |
| Usage redaction test | 3 | Three findings are the same synthetic key-shaped message fixture, repeated in input and expected output to verify local-session parsing and redaction. |
| Harness hardening test | 1 | The structurally JWT-shaped value is synthetic header/payload text with a literal test signature and is injected to verify rejection of secret-bearing context. |

All reviewed values are non-secret test data. The committed configuration records the exact values because gitleaks must match them, while reports and release notes must redact them. Any new or uncertain finding blocks the build until it is investigated; it must never be added to the allowlist solely to make CI pass.

Credential detection is independent of business-content redaction. The
narrow business rule in `redaction-policy.md` does not weaken gitleaks, this
repository scanner, or the requirement to hide every API key, token, password,
and private key.
