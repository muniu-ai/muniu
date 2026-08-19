# Architecture

Muniu executes `task → run → candidate → gate → evidence`. Each candidate owns a durable Agent session and an `AgentExecutionBindingV1` that binds runtime, provider/model, Harness, governance, effect policy, and sandbox capability digests.

Cordis loads configuration in the order base bundle, deployment profile, user patch, CLI patch. API, Worker, and Desktop have isolated root Contexts; every Agent session isolates its host, session, tools, and model services. Effects are cleaned up in reverse order during reload or shutdown.

Enterprise session sequence/digest indexes live in PostgreSQL. Protected events and exact runtime overlays live in S3 and are verified against byte length, SHA-256, event digest, and chain on load.

Executable plugins have host-process authority.

In Kubernetes, the API stores a content-addressed source snapshot in S3. An actively leased Worker retrieves and verifies it, materializes it on the shared PVC, and creates one tokenless, network-denied candidate Pod. The API resolves that exact Pod independently through its own credentials, verifies its image and security projection, and replays Gates in a second immutable authority Pod. Candidate Pods never access S3 or the Kubernetes API. This boundary is experimental in v0.1.0 and is covered by a Kind + Calico execution probe.
