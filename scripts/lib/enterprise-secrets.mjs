// SPDX-License-Identifier: Apache-2.0

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

  constructor({
    address,
    token,
    mount = "transit",
    keyName = "muniu-v2-protected-payloads",
    namespace,
    fetchImplementation = fetch,
  }) {
    this.#address = new URL(required(address, "MN_VAULT_ADDR"));
    this.#token = required(token, "MN_VAULT_TOKEN");
    this.#mount = safeVaultName(mount, "MN_VAULT_TRANSIT_MOUNT");
    this.#keyName = safeVaultName(keyName, "MN_VAULT_TRANSIT_KEY");
    this.#namespace = namespace?.trim();
    this.#fetch = fetchImplementation;
  }

  #url(operation) {
    return new URL(
      `/v1/${encodeURIComponent(this.#mount)}/${operation}/${encodeURIComponent(this.#keyName)}`,
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

  async #post(operation, body) {
    const response = await this.#fetch(this.#url(operation), {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Vault Transit ${operation} 失败：HTTP ${response.status}`);
    return response.json();
  }

  async wrapKey(dataKey, context) {
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32) {
      throw new TypeError("Data key must contain exactly 32 bytes");
    }
    const body = await this.#post("encrypt", {
      plaintext: Buffer.from(dataKey).toString("base64"),
      context: encodedContext(context),
    });
    const ciphertext = body?.data?.ciphertext;
    if (typeof ciphertext !== "string" || !ciphertext) {
      throw new Error("Vault Transit 返回的 wrapped DEK 无效");
    }
    return {
      algorithm: "AES-256-GCM",
      provider: "vault-transit",
      keyId: `vault-transit://muniu/v2/${this.#mount}/${this.#keyName}`,
      nonce: "",
      ciphertext,
      tag: "",
      context,
    };
  }

  async unwrapKey(wrapped) {
    const expectedKeyId = `vault-transit://muniu/v2/${this.#mount}/${this.#keyName}`;
    if (wrapped?.algorithm !== "AES-256-GCM" || wrapped?.provider !== "vault-transit"
      || wrapped?.keyId !== expectedKeyId) {
      throw new Error("Wrapped key belongs to a different Vault Transit key");
    }
    const body = await this.#post("decrypt", {
      ciphertext: wrapped.ciphertext,
      context: encodedContext(wrapped.context),
    });
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
}

export class UnavailableEnterpriseKeyProvider {
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
