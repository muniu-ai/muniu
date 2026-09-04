export type PluginPolicyErrorCode =
  | "CANONICAL_JSON_INVALID"
  | "REGISTRY_SIGNATURE_INVALID"
  | "REGISTRY_ROOT_UNTRUSTED"
  | "REGISTRY_SEQUENCE_ROLLBACK"
  | "REGISTRY_TIME_INVALID"
  | "REVOCATION_METADATA_STALE"
  | "PLUGIN_MANIFEST_INVALID"
  | "PLUGIN_PACKAGE_INVALID"
  | "MANIFEST_SIGNATURE_INVALID"
  | "PACKAGE_DIGEST_MISMATCH"
  | "RESOURCE_DIGEST_MISMATCH"
  | "REMOTE_RESOURCE_FORBIDDEN"
  | "DIGEST_DOWNGRADE_FORBIDDEN"
  | "INSTALL_HOOK_FORBIDDEN"
  | "REMOTE_JAVASCRIPT_FORBIDDEN"
  | "RELEASE_KEY_UNTRUSTED"
  | "RELEASE_KEY_REVOKED"
  | "PLUGIN_RELEASE_REVOKED"
  | "RELEASE_EXPIRED"
  | "RELEASE_ROLLBACK"
  | "RELEASE_SEQUENCE_REUSED"
  | "DEVELOPMENT_SOURCE_INVALID"
  | "PLUGIN_ALREADY_INSTALLED"
  | "PLUGIN_REGISTRY_UNAVAILABLE"
  | "PLUGIN_RELEASE_NOT_FOUND"
  | "PLUGIN_NOT_INSTALLED"
  | "PLUGIN_NOT_ACTIVE"
  | "PLUGIN_REVOKED"
  | "PLUGIN_UPGRADE_INVALID"
  | "PLUGIN_PURGE_INVALID"
  | "AUTOMATIC_DOWNGRADE_UNSAFE"
  | "PLUGIN_DEFINITION_INVALID"
  | "PLUGIN_CONTRIBUTION_INVALID";

export class PluginPolicyError extends Error {
  readonly code: PluginPolicyErrorCode;
  readonly action: string;

  constructor(code: PluginPolicyErrorCode, message: string, action: string) {
    super(message);
    this.name = "PluginPolicyError";
    this.code = code;
    this.action = action;
  }
}

export class PluginBoundaryError extends Error {
  readonly pluginId: string;
  readonly operation: string;
  override readonly cause: unknown;

  constructor(pluginId: string, operation: string, cause: unknown) {
    super(`插件 ${pluginId} 执行 ${operation} 失败`);
    this.name = "PluginBoundaryError";
    this.pluginId = pluginId;
    this.operation = operation;
    this.cause = cause;
  }
}
