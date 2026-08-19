# Architecture

Muniu executes `task → run → candidate → gate → evidence`. Each candidate owns a durable Agent session and an `AgentExecutionBindingV1` that binds runtime, provider/model, Harness, governance, effect policy, and sandbox capability digests.

Cordis loads configuration in the order base bundle, deployment profile, user patch, CLI patch. API, Worker, and Desktop have isolated root Contexts; every Agent session isolates its host, session, tools, and model services. Effects are cleaned up in reverse order during reload or shutdown.

Enterprise session sequence/digest indexes live in PostgreSQL. Protected events and exact runtime overlays live in S3 and are verified against byte length, SHA-256, event digest, and chain on load.

Executable plugins have host-process authority. Kubernetes deployment resources exist, while the candidate sandbox Pod provisioner remains planned for v0.1.0.
