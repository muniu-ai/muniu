# Data redaction policy

Muniu treats business content and security credentials as different data
classes. This distinction is normative for API, CLI, desktop, persisted event,
diagnostic, evidence, and release-output implementations.

## Business content

Only the following business-content values are redacted:

- mobile/cellular phone numbers;
- government-issued identity card numbers (including PRC resident ID).

Names, email addresses, postal addresses, filesystem paths, ordinary
usernames, and model-generated text are not redacted merely because they are
business content. A feature must not silently expand this list without an
explicit policy change and compatibility review.

## Credentials

API keys, access or refresh tokens, passwords, private keys, and equivalent
authentication material are always hidden. Credential hiding applies even
when a raw, debug, verbose, export, replay, or administrator option is enabled;
such an option must never bypass the credential boundary.

Repository secret scanning and release credential gates remain fail-closed and
are not relaxed by the narrow business-content rule. Phase 02 records this
policy only. Central implementation and transport contract tests belong to
phase 03, product-surface consistency belongs to phase 05, and artifact/log
acceptance scans belong to phase 06.
