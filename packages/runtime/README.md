# @mn/runtime

Cordis-based application runtime for Muniu. It owns profile loading, typed
lifecycle events, process-scoped plugin audit records, and isolated Agent
session contexts. Executable plugins are trusted code with the same authority
as the host process; this package is not a plugin sandbox.
