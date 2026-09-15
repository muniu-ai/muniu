// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} 未配置`);
  return value.trim();
}

function safeVaultName(value, name) {
  const result = required(value, name);
  if (!/^[a-zA-Z0-9._-]+$/u.test(result)) throw new Error(`${name} 无效`);
  return result;
}

function encodedContext(context) {
  if (!context || typeof context.tenantId !== "string" || typeof context.purpose !== "string") {
    throw new Error("Vault Transit 密钥上下文无效");
  }
  return Buffer.from(JSON.stringify({ tenantId: context.tenantId, purpose: context.purpose }))
    .toString("base64");
}

export class VaultTransitKeyProvider {
  #address;
  #token;
  #mount;
  #keyName;
  #namespace;
  #fetch;
  #individuallyRevocable;

  constructor({
    address,
    token,
    mount = "transit",
    keyName = "muniu-v2-protected-payloads",
    namespace,
    fetchImplementation = fetch,
    individuallyRevocable = false,
  }) {
    this.#address = new URL(required(address, "MN_VAULT_ADDR"));
    this.#token = required(token, "MN_VAULT_TOKEN");
    this.#mount = safeVaultName(mount, "MN_VAULT_TRANSIT_MOUNT");
    this.#keyName = safeVaultName(keyName, "MN_VAULT_TRANSIT_KEY");
    this.#namespace = namespace?.trim();
    this.#fetch = fetchImplementation;
    this.#individuallyRevocable = individuallyRevocable;
  }

  #url(operation, name = this.#keyName, suffix = "") {
    return new URL(
      `/v1/${encodeURIComponent(this.#mount)}/${operation}/${encodeURIComponent(name)}${suffix}`,
      this.#address,
    );
  }

  #headers() {
    return {
      "content-type": "application/json",
      "x-vault-token": this.#token,
      ...(this.#namespace ? { "x-vault-namespace": this.#namespace } : {}),
    };
  }

  async probe() {
    try {
      const signal = AbortSignal.timeout(2_000);
      const headers = this.#headers();
      const health = await this.#fetch(new URL("/v1/sys/health?standbyok=true", this.#address), {
        headers, redirect: "error", signal,
      });
      await health.body?.cancel();
      if (!health.ok) return false;
      const name = this.#individuallyRevocable ? `${this.#keyName}-00000000-0000-4000-8000-000000000000` : this.#keyName;
      const requirements = {
        [`${this.#mount}/keys/${name}`]: this.#individuallyRevocable ? ["create", "read", "update", "delete"] : ["read"],
        ...(this.#individuallyRevocable ? { [`${this.#mount}/keys/${name}/config`]: ["update"] } : {}),
        [`${this.#mount}/encrypt/${name}`]: ["update"],
        [`${this.#mount}/decrypt/${name}`]: ["update"],
      };
      const response = await this.#fetch(new URL("/v1/sys/capabilities-self", this.#address), {
        method: "POST", headers, body: JSON.stringify({ paths: Object.keys(requirements) }),
        redirect: "error", signal,
      });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const body = await response.json();
      return Object.entries(requirements).every(([path, requiredCapabilities]) => {
        const capabilities = body.data?.[path] ?? body[path];
        return Array.isArray(capabilities) && !capabilities.includes("deny")
          && (capabilities.includes("root") || requiredCapabilities.every(value => capabilities.includes(value)));
      });
    } catch { return false; }
  }

  async #post(operation, body, name = this.#keyName, suffix = "") {
    const response = await this.#fetch(this.#url(operation, name, suffix), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Vault Transit ${operation} 失败：HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  #keyNameFor(wrapped) {
    const prefix = `vault-transit://muniu/v2/${this.#mount}/${this.#keyName}`;
    const expectedProvider = this.#individuallyRevocable ? "vault-transit-individual" : "vault-transit";
    if (wrapped?.algorithm !== "AES-256-GCM" || wrapped?.provider !== expectedProvider
      || typeof wrapped.keyId !== "string" || !wrapped.keyId.startsWith(prefix)) {
      throw new Error("Wrapped key belongs to a different Vault Transit key");
    }
    const suffix = wrapped.keyId.slice(prefix.length);
    if (this.#individuallyRevocable ? !/^-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(suffix) : suffix !== "") {
      throw new Error("Invalid Vault Transit payload key ID");
    }
    encodedContext(wrapped.context);
    return `${this.#keyName}${suffix}`;
  }

  async wrapKey(dataKey, context) {
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32) {
      throw new TypeError("Data key must contain exactly 32 bytes");
    }
    const name = this.#individuallyRevocable ? `${this.#keyName}-${randomUUID()}` : this.#keyName;
    const encoded = encodedContext(context);
    if (this.#individuallyRevocable) {
      await this.#post("keys", { type: "aes256-gcm96", derived: true, exportable: false, allow_plaintext_backup: false }, name);
      await this.#post("keys", { deletion_allowed: true }, name, "/config");
    }
    const body = await this.#post("encrypt", {
      plaintext: Buffer.from(dataKey).toString("base64"),
      context: encoded,
    }, name);
    const ciphertext = body?.data?.ciphertext;
    if (typeof ciphertext !== "string" || !ciphertext) {
      throw new Error("Vault Transit 返回的 wrapped DEK 无效");
    }
    return {
      algorithm: "AES-256-GCM",
      provider: this.#individuallyRevocable ? "vault-transit-individual" : "vault-transit",
      keyId: `vault-transit://muniu/v2/${this.#mount}/${name}`,
      nonce: "",
      ciphertext,
      tag: "",
      context,
    };
  }

  async unwrapKey(wrapped) {
    const name = this.#keyNameFor(wrapped);
    const body = await this.#post("decrypt", {
      ciphertext: wrapped.ciphertext,
      context: encodedContext(wrapped.context),
    }, name);
    const plaintext = body?.data?.plaintext;
    if (typeof plaintext !== "string" || !plaintext) {
      throw new Error("Vault Transit 返回的数据密钥无效");
    }
    const key = Buffer.from(plaintext, "base64");
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new Error("Vault Transit 返回的数据密钥长度无效");
    }
    return key;
  }

  async isKeyRevoked(wrapped) {
    if (!this.#individuallyRevocable) throw new Error("Shared Vault Transit keys cannot be individually revoked");
    const name = this.#keyNameFor(wrapped);
    const response = await this.#fetch(this.#url("keys", name), { method: "GET", headers: this.#headers(),
      redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return true;
    if (!response.ok) throw new Error(`Vault Transit key inspection failed: HTTP ${response.status}`);
    return false;
  }

  async revokeKey(wrapped) {
    if (await this.isKeyRevoked(wrapped)) return;
    const response = await this.#fetch(this.#url("keys", this.#keyNameFor(wrapped)), { method: "DELETE",
      headers: this.#headers(), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Vault Transit key revocation failed: HTTP ${response.status}`);
  }
}

export class UnavailableEnterpriseKeyProvider {
  async probe() { return false; }

  async wrapKey() {
    throw new Error("企业 Vault/KMS 包装密钥未配置");
  }

  async unwrapKey() {
    throw new Error("企业 Vault/KMS 包装密钥未配置");
  }
}

export class VaultModelSecretStore {
  #address;
  #token;
  #mount;
  #namespace;
  #fetch;

  constructor({ address, token, mount = "secret", namespace, fetchImplementation = fetch }) {
    this.#address = new URL(required(address, "MN_VAULT_ADDR"));
    this.#token = required(token, "MN_VAULT_TOKEN");
    this.#mount = required(mount, "MN_VAULT_KV_MOUNT");
    this.#namespace = namespace?.trim();
    this.#fetch = fetchImplementation;
  }

  #url(account) {
    if (!/^[a-zA-Z0-9._-]+$/u.test(account)) throw new Error("Vault 密钥名称无效");
    return new URL(`/v1/${encodeURIComponent(this.#mount)}/data/muniu/v2/models/${account}`, this.#address);
  }

  #headers() {
    return {
      "content-type": "application/json",
      "x-vault-token": this.#token,
      ...(this.#namespace ? { "x-vault-namespace": this.#namespace } : {}),
    };
  }

  async save(connectionId, apiKey) {
    const response = await this.#fetch(this.#url(connectionId), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ data: { apiKey } }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Vault 写入失败：HTTP ${response.status}`);
    return `vault://muniu/v2/models/${connectionId}`;
  }

  async read(reference) {
    const match = reference.match(/^vault:\/\/muniu\/v2\/models\/([a-zA-Z0-9._-]+)$/u);
    if (!match) throw new Error("Vault 密钥引用无效");
    const response = await this.#fetch(this.#url(match[1]), {
      headers: this.#headers(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Vault 读取失败：HTTP ${response.status}`);
    const body = await response.json();
    const apiKey = body?.data?.data?.apiKey;
    if (typeof apiKey !== "string" || !apiKey) throw new Error("Vault 返回的模型密钥无效");
    return apiKey;
  }

  async probe() {
    try {
      const response = await this.#fetch(new URL("/v1/sys/health?standbyok=true", this.#address), {
        headers: this.#headers(),
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class UnavailableEnterpriseSecretStore {
  async save() {
    throw new Error("企业模型密钥存储未配置");
  }

  async read() {
    throw new Error("企业模型密钥存储未配置");
  }
}
