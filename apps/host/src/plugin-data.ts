// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { JsonObject, KernelEventV1, Workspace, WorkspaceMembership } from "@mn/contracts";
import { appendKernelEvent, KernelError, sha256, type KernelStore, type KernelTransaction } from "@mn/kernel";
import { assertPluginEventPayload, cloneJson, reducePluginProjection, type InstalledPluginRecord, type PluginDataPortV1,
  type PluginDomainEventV1, type PluginProjectionRecordV1 } from "@mn/plugin-sdk";
import { readProtectedJson, storeProtectedJson, type ContentAddressedStorage, type KeyProvider, type ProtectedJsonKeyRecordV1 } from "@mn/storage";
import { PLUGIN_LIFECYCLE_PROJECTION, PLUGIN_OPERATION_PROJECTION } from "./plugin-installation.js";
import { KernelPluginProjectionManager, PLUGIN_DATA_HEAD_NAMESPACE, pluginProjectionKey, pluginProjectionNamespace, type PluginDataHead } from "./plugin-projections.js";

interface Protection { readonly cas: ContentAddressedStorage; readonly keyProvider: KeyProvider }

export async function readPluginDomainEvent(store: KernelStore, event: KernelEventV1, protection?: Protection): Promise<PluginDomainEventV1> {
  const pluginId = event.aggregateType.slice("plugin:".length);
  const { workspaceId, resourceId } = event.publicPayload;
  if (!event.aggregateType.startsWith("plugin:") || typeof workspaceId !== "string" || typeof resourceId !== "string"
    || event.aggregateId !== pluginProjectionKey(workspaceId, resourceId) || event.publicPayload.pluginId !== pluginId
    || !event.protectedPayloadRef || !protection) throw new Error("插件事实缺少加密内容或身份绑定");
  const keyRecord = await store.transact(event.tenantId, tx => tx.getProjection<ProtectedJsonKeyRecordV1>("protectedPayloadKey", event.protectedPayloadRef!));
  if (!keyRecord) throw new Error("插件事实数据密钥不可用");
  const value = await readProtectedJson({ ...protection, tenantId: event.tenantId, workspaceId, ownerType: event.aggregateType,
    ownerId: event.aggregateId, protectedPayloadRef: event.protectedPayloadRef, keyRecord });
  if (value.pluginId !== pluginId || value.workspaceId !== workspaceId || value.resourceId !== resourceId || value.eventType !== event.type
    || typeof value.payload !== "object" || !value.payload || Array.isArray(value.payload)) throw new Error("插件事实加密内容与身份不一致");
  return { id: event.id, tenantId: event.tenantId, workspaceId, resourceId, type: event.type, position: event.position,
    streamVersion: event.streamVersion, payload: value.payload as JsonObject };
}

export function createPluginDataPort(input: { readonly store: KernelStore; readonly tenantId: string; readonly workspaceId: string;
  readonly pluginId: string; readonly actorId: string; readonly commandId: string; readonly idempotencyKey: string;
  readonly manager: KernelPluginProjectionManager; readonly protection?: Protection; readonly now: () => string }): PluginDataPortV1 {
  const { store, tenantId, workspaceId, pluginId, manager, now } = input;
  const current = (tx: KernelTransaction): InstalledPluginRecord => {
    const record = tx.getProjection<InstalledPluginRecord>(PLUGIN_LIFECYCLE_PROJECTION, pluginId);
    const workspace = tx.getProjection<Workspace>("workspace", workspaceId);
    const membership = tx.getProjection<WorkspaceMembership>("membership", `${workspaceId}:${input.actorId}`);
    if (!membership || membership.removedAt || !["owner", "operator"].includes(membership.workspaceRole)) {
      throw new KernelError("WORKSPACE_ACCESS_DENIED", "无权操作此工作区", "联系工作区所有者授予权限");
    }
    if (!record || record.status !== "active" || !workspace?.activePluginIds.includes(pluginId)
      || tx.getProjection(PLUGIN_OPERATION_PROJECTION, pluginId)) throw new KernelError("PLUGIN_NOT_ACTIVE", "插件当前不可写入或读取", "等待插件操作完成后重试");
    return record;
  };
  const resource = (id: string) => {
    if (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f]/u.test(id)) {
      throw new KernelError("PLUGIN_DATA_INVALID", "插件记录标识无效", "使用非空的稳定记录标识");
    }
    return pluginProjectionKey(workspaceId, id);
  };
  return {
    async get(view, resourceId) {
      const key = resource(resourceId);
      return store.transact(tenantId, tx => {
        const record = current(tx);
        if (!manager.programs(record.manifest).has(view)) throw new KernelError("PLUGIN_DATA_INVALID", "插件未声明该投影", "选择签名清单中的投影");
        const result = tx.getProjection<PluginProjectionRecordV1>(pluginProjectionNamespace(pluginId, record.projectionNamespace, view), key);
        if (result && (result.workspaceId !== workspaceId || result.tenantId !== tenantId || result.id !== resourceId)) throw new Error("插件投影数据范围不一致");
        return result;
      });
    },
    async append(submitted) {
      const request = cloneJson(submitted);
      const aggregateId = resource(request.resourceId);
      if (!request.key || request.key.length > 128 || !Number.isSafeInteger(request.expectedStreamVersion) || request.expectedStreamVersion < 0) {
        throw new KernelError("PLUGIN_DATA_INVALID", "插件写入步骤或事件版本无效", "填写稳定步骤键和 expectedStreamVersion");
      }
      const scope = `plugin.data:${sha256([workspaceId, pluginId, input.commandId])}`;
      const key = sha256([input.idempotencyKey, request.key]);
      const requestDigest = sha256(request);
      const previous = await store.transact(tenantId, tx => { current(tx); return tx.getIdempotency(scope, key); });
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new KernelError("IDEMPOTENCY_KEY_REUSED", "插件步骤键已用于不同写入", "使用新的步骤键");
        return previous.response as PluginDomainEventV1;
      }
      const installation = await store.transact(tenantId, current);
      const schema = installation.manifest.eventSchemas[request.eventType];
      try {
        if (!schema) throw new Error("未声明事件类型");
        assertPluginEventPayload(schema, request.payload);
      } catch { throw new KernelError("PLUGIN_DATA_INVALID", "插件事件内容不符合签名结构定义", "检查事件类型和内容"); }
      if (!input.protection) throw new KernelError("PLUGIN_DATA_UNAVAILABLE", "插件加密存储不可用", "配置 CAS 和密钥服务后重试");
      const prepared = await storeProtectedJson({ ...input.protection, tenantId, workspaceId, ownerType: `plugin:${pluginId}`,
        ownerId: aggregateId, protectedPayloadRef: randomUUID(), createdAt: now(), value: { pluginId, workspaceId,
          resourceId: request.resourceId, eventType: request.eventType, payload: request.payload } });
      return store.transact(tenantId, tx => {
        const record = current(tx);
        if (record.manifest.packageSha256 !== installation.manifest.packageSha256) throw new KernelError("PLUGIN_DATA_CHANGED", "写入期间插件版本发生变化", "刷新插件后重新操作");
        const raced = tx.getIdempotency(scope, key);
        if (raced) {
          if (raced.requestDigest !== requestDigest) throw new KernelError("IDEMPOTENCY_KEY_REUSED", "插件步骤键已用于不同写入", "使用新的步骤键");
          return raced.response as PluginDomainEventV1;
        }
        const event = appendKernelEvent(tx, { tenantId, aggregateType: `plugin:${pluginId}`, aggregateId,
          expectedStreamVersion: request.expectedStreamVersion, type: request.eventType, actorId: input.actorId,
          generation: record.manifest.release.sequence, correlationId: sha256([scope, key]), protectedPayloadRef: prepared.protectedPayloadRef,
          publicPayload: { pluginId, workspaceId, resourceId: request.resourceId, packageSha256: record.manifest.packageSha256 } });
        const domain: PluginDomainEventV1 = { id: event.id, tenantId, workspaceId, resourceId: request.resourceId, type: event.type,
          position: event.position, streamVersion: event.streamVersion, payload: request.payload };
        tx.putProjection("protectedPayloadKey", prepared.protectedPayloadRef, prepared.keyRecord);
        for (const [view, program] of manager.programs(record.manifest)) {
          const namespace = pluginProjectionNamespace(pluginId, record.projectionNamespace, view);
          const next = reducePluginProjection(program, tx.getProjection(namespace, aggregateId), domain);
          if (next) tx.putProjection(namespace, aggregateId, next); else tx.deleteProjection(namespace, aggregateId);
        }
        const head = tx.getProjection<PluginDataHead>(PLUGIN_DATA_HEAD_NAMESPACE, pluginId);
        tx.putProjection(PLUGIN_DATA_HEAD_NAMESPACE, pluginId, { streamVersion: (head?.streamVersion ?? 0) + 1, position: event.position } satisfies PluginDataHead);
        tx.putProjection(PLUGIN_LIFECYCLE_PROJECTION, pluginId, { ...record, eventsAfterSwitch: record.eventsAfterSwitch + 1 });
        tx.putIdempotency({ tenantId, scope, key, requestDigest, response: domain, createdAt: now() });
        return domain;
      });
    },
  };
}
