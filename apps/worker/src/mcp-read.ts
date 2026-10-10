// SPDX-License-Identifier: Apache-2.0
import type { JsonValue } from '@mn/contracts';
import type { StoredJob } from '@mn/storage';
import type { WorkerJobContext, WorkerJobHandler } from './index.js';
export interface McpReadWorkerPorts { execute(job: StoredJob, context: WorkerJobContext): Promise<JsonValue> }
/** Transport, credentials and protected Asset composition remain owned by Host. */
export function createMcpReadWorkerHandler(ports: McpReadWorkerPorts): WorkerJobHandler { return (job, context) => ports.execute(job, context); }
