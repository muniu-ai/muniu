import { randomBytes } from "node:crypto";
import { runKeychainCommand } from "@mn/storage";

export const V2_KEYCHAIN_SERVICE = "com.muniu.agent-os.v2";

export interface ModelSecretStore {
  save(connectionId: string, apiKey: string): Promise<string>;
  read(secretRef: string): Promise<string>;
}

export type KeychainCommand = (arguments_: readonly string[], stdin?: string) => Promise<string>;

function accountFromRef(reference: string): string {
  const prefix = "keychain://muniu.v2/";
  if (!reference.startsWith(prefix)) throw new Error("模型密钥引用不属于 v2 Keychain");
  const account = reference.slice(prefix.length);
  if (!account || account.includes("/") || account.includes("..")) throw new Error("模型密钥引用无效");
  return account;
}

export class MacOsKeychainSecretStore implements ModelSecretStore {
  constructor(
    private readonly command: KeychainCommand = runKeychainCommand,
    private readonly service = V2_KEYCHAIN_SERVICE,
  ) {
    if (!service.includes("v2")) throw new TypeError("Keychain service 必须与 0.1 隔离");
  }

  async save(connectionId: string, apiKey: string): Promise<string> {
    if (!connectionId.trim() || !apiKey.trim() || /[\r\n\0]/u.test(apiKey)) throw new TypeError("连接名称和密钥不能为空，密钥不得包含控制换行");
    const account = `model-${connectionId}`;
    await this.command([
      "add-generic-password", "-U", "-s", this.service, "-a", account, "-w",
    ], `${apiKey}\n`);
    return `keychain://muniu.v2/${account}`;
  }

  async read(secretRef: string): Promise<string> {
    return this.command([
      "find-generic-password", "-s", this.service, "-a", accountFromRef(secretRef), "-w",
    ]);
  }

  async getOrCreateBytes(account: string, byteLength = 32): Promise<Buffer> {
    try {
      const encoded = await this.command([
        "find-generic-password", "-s", this.service, "-a", account, "-w",
      ]);
      const value = Buffer.from(encoded, "base64");
      if (value.byteLength !== byteLength) throw new Error("Keychain 密钥长度无效");
      return value;
    } catch (error) {
      if (!/not found|could not be found|-25300|errSecItemNotFound/iu.test(String(error))) throw error;
      const value = randomBytes(byteLength);
      await this.command([
        "add-generic-password", "-s", this.service, "-a", account,
        "-w",
      ], `${value.toString("base64")}\n`);
      return value;
    }
  }
}
