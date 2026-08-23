// SPDX-License-Identifier: Apache-2.0

import type { JsonRpcMessage } from "@mn/app-server-protocol";

export interface RpcChannel {
  send(message: JsonRpcMessage): Promise<void>;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): void | Promise<void>;
}
