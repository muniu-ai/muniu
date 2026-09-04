// SPDX-License-Identifier: Apache-2.0

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} 未配置`);
  return value.trim();
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
