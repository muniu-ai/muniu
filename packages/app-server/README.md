# `@mn/app-server`

Private app-server connection and local transport runtime for Muniu.

The connection requires `initialize`, then the `initialized` notification. It validates requests and responses with `@mn/app-server-protocol`, persists notifications before delivery, and bounds each frame and pending queue to 16 MiB. The pending queue also has a 1,024-message limit.

Local transports support stdio JSONL, owner-only Unix sockets, and loopback WebSocket listeners with random bearer tokens. Enterprise WSS authentication and routing are owned by the gateway package.
