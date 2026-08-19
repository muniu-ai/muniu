# Architecture

Muniu executes `task → run → candidate → gate → evidence`. Each candidate owns a durable Agent session and an `AgentExecutionBindingV1` that binds runtime, provider/model, Harness, governance, effect policy, and sandbox capability digests.

Cordis loads configuration in the order base bundle, deployment profile, user patch, CLI patch. API, Worker, and Desktop have isolated root Contexts; every Agent session isolates its host, session, tools, and model services. Effects are cleaned up in reverse order during reload or shutdown.

Enterprise session sequence/digest indexes live in PostgreSQL. Protected events and exact runtime overlays live in S3 and are verified against byte length, SHA-256, event digest, and chain on load.

Executable plugins have host-process authority.

In Kubernetes, the API stores a content-addressed source snapshot in S3. An actively leased Worker retrieves and verifies it, materializes it on the shared PVC, and creates one tokenless, network-denied candidate Pod. The builtin model stream and provider credentials stay in the API. Bounded workspace tool calls travel over the active-claim protocol to the Worker and execute only in that inspected Pod. Unacknowledged calls are redelivered with the same `callId`; the Worker caches the result and the API accepts only an identical idempotent commit. The API independently verifies the Pod and replays Gates in a second immutable authority Pod. Candidate Pods never access S3, model credentials, or the Kubernetes API.

Active tool-broker state is currently process-local to one API replica. PostgreSQL-backed cross-replica routing and failover remain release work, so this path is experimental and does not yet satisfy the multi-replica acceptance criterion.
