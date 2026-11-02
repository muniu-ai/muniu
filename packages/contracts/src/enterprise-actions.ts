// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { canonicalJson } from './integrity.js';
import { ENTERPRISE_SCHEMAS } from './enterprise-schema.js';
import { parseEnterpriseContract } from './enterprise-contracts.js';
import type { ActionIntent, ActionReceipt } from './enterprise-types.js';
export function actionIntentView(value: ActionIntent): ActionIntent {
  const properties = ENTERPRISE_SCHEMAS.ActionIntent!.properties as Record<string, unknown>;
  const record = value as unknown as Record<string, unknown>;
  return parseEnterpriseContract('ActionIntent', structuredClone(Object.fromEntries(Object.keys(properties).filter(key => record[key] !== undefined).map(key => [key, record[key]]))));
}
export function computeActionIntentDigest(value: ActionIntent): string {
  const { status: _status, streamVersion: _version, executionApprovalRef: _approval, ...committed } = actionIntentView(value);
  return createHash('sha256').update(canonicalJson(committed)).digest('hex');
}
export function computeActionReceiptDigest(value: ActionReceipt): string {
  const { receivedAt: _receivedAt, ...fact } = parseEnterpriseContract('ActionReceipt', value);
  return createHash('sha256').update(canonicalJson(fact)).digest('hex');
}
