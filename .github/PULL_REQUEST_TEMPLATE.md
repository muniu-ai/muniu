## Summary

Describe the user-visible result and why it is needed.

## Validation

List exact commands run and their results.

## Compatibility and security

Describe public interface, migration, data, permission, sandbox, and secret
handling effects. Write "None" only after checking each category.

## Upstream and licensing

List copied/adapted sources and provenance updates, or state that no upstream
source was copied.

## Checklist

- [ ] Production behavior followed red-green-refactor TDD.
- [ ] Focused and affected tests pass; new logic has at least 70% coverage.
- [ ] npm audit --omit=dev has no Critical or High findings.
- [ ] No credentials, local paths, generated output, or unexpected binaries are included.
- [ ] Copied/adapted files retain notices and provenance is current.
- [ ] Documentation and changelog are updated when user behavior changed.
- [ ] Every commit includes a DCO Signed-off-by line.

