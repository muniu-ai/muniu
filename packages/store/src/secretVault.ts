import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID
} from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { maskSecret, type ProviderSecretRef } from "@mn/provider-catalog";

export type SecretVaultBackend = "local_encrypted" | "keychain";

export type SecurityCommandRunner = (args: string[]) => Promise<string>;

export interface KeychainSecretVaultOptions {
  service?: string;
  accountPrefix?: string;
  securityBin?: string;
  keychainPath?: string;
  runSecurity?: SecurityCommandRunner;
}

export interface LocalSecretVaultOptions {
  backend?: SecretVaultBackend;
  keychain?: KeychainSecretVaultOptions;
}

interface EncryptedSecretFile {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

const keychainRefPrefix = "keychain:";

export class LocalSecretVault {
  readonly rootDir: string;
  readonly secretsDir: string;
  readonly keyFile: string;
  readonly backend: SecretVaultBackend;
  private readonly keychain: KeychainSecretVault;

  constructor(rootDir: string, options: LocalSecretVaultOptions = {}) {
    this.rootDir = rootDir;
    this.secretsDir = join(rootDir, "secrets");
    this.keyFile = join(rootDir, "secret-key.json");
    this.backend = options.backend ?? "local_encrypted";
    this.keychain = new KeychainSecretVault(options.keychain);
  }

  async saveSecret(secret: string): Promise<ProviderSecretRef> {
    if (this.backend === "keychain") {
      return this.keychain.saveSecret(secret);
    }
    return this.saveLocalEncryptedSecret(secret);
  }

  async readSecret(
    ref: string,
    type: Extract<ProviderSecretRef["type"], "local_encrypted" | "keychain"> = ref.startsWith(keychainRefPrefix)
      ? "keychain"
      : "local_encrypted"
  ): Promise<string | undefined> {
    if (type === "keychain") {
      return this.keychain.readSecret(ref);
    }
    return this.readLocalEncryptedSecret(ref);
  }

  async deleteSecret(
    ref: string,
    type: Extract<ProviderSecretRef["type"], "local_encrypted" | "keychain"> = ref.startsWith(keychainRefPrefix)
      ? "keychain"
      : "local_encrypted"
  ): Promise<void> {
    if (type === "keychain") {
      await this.keychain.deleteSecret(ref);
      return;
    }
    await rm(join(this.secretsDir, `${ref}.json`), { force: true });
  }

  private async saveLocalEncryptedSecret(secret: string): Promise<ProviderSecretRef> {
    const key = await this.loadOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    const ref = randomUUID();
    const payload: EncryptedSecretFile = {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    await mkdir(this.secretsDir, { recursive: true });
    const secretPath = join(this.secretsDir, `${ref}.json`);
    await writePrivateJson(secretPath, payload);
    return {
      type: "local_encrypted",
      ref,
      maskedValue: maskSecret(secret)
    };
  }

  private async readLocalEncryptedSecret(ref: string): Promise<string | undefined> {
    const key = await this.loadOrCreateKey();
    try {
      const raw = await readFile(join(this.secretsDir, `${ref}.json`), "utf8");
      const payload = JSON.parse(raw) as EncryptedSecretFile;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64")
      );
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final()
      ]);
      return plaintext.toString("utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    try {
      const raw = await readFile(this.keyFile, "utf8");
      const payload = JSON.parse(raw) as { key: string };
      return Buffer.from(payload.key, "base64");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    await mkdir(this.rootDir, { recursive: true });
    const key = randomBytes(32);
    await writePrivateJson(this.keyFile, { key: key.toString("base64") });
    return key;
  }
}

export class KeychainSecretVault {
  readonly service: string;
  readonly accountPrefix: string;
  readonly securityBin: string;
  readonly keychainPath?: string;
  private readonly runSecurity: SecurityCommandRunner;

  constructor(options: KeychainSecretVaultOptions = {}) {
    this.service = options.service ?? "dev.muniu.secrets";
    this.accountPrefix = options.accountPrefix ?? "secret:";
    this.securityBin = options.securityBin ?? "/usr/bin/security";
    this.keychainPath = options.keychainPath;
    this.runSecurity = options.runSecurity ?? defaultSecurityRunner(this.securityBin);
  }

  async saveSecret(secret: string): Promise<ProviderSecretRef> {
    const account = `${this.accountPrefix}${randomUUID()}`;
    await this.runSecurity(this.withKeychain([
      "add-generic-password",
      "-s",
      this.service,
      "-a",
      account,
      "-w",
      secret,
      "-U"
    ]));
    return {
      type: "keychain",
      ref: encodeKeychainRef(account),
      maskedValue: maskSecret(secret)
    };
  }

  async readSecret(ref: string): Promise<string | undefined> {
    const account = decodeKeychainRef(ref);
    try {
      const value = await this.runSecurity(this.withKeychain([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w"
      ]));
      return value.replace(/\r?\n$/, "");
    } catch (error) {
      if (isKeychainNotFound(error)) return undefined;
      throw error;
    }
  }

  async deleteSecret(ref: string): Promise<void> {
    const account = decodeKeychainRef(ref);
    try {
      await this.runSecurity(this.withKeychain([
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        account
      ]));
    } catch (error) {
      if (!isKeychainNotFound(error)) throw error;
    }
  }

  private withKeychain(args: string[]): string[] {
    return this.keychainPath ? [...args, this.keychainPath] : args;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

function encodeKeychainRef(account: string): string {
  return `${keychainRefPrefix}${Buffer.from(account, "utf8").toString("base64url")}`;
}

function decodeKeychainRef(ref: string): string {
  if (!ref.startsWith(keychainRefPrefix)) return ref;
  return Buffer.from(ref.slice(keychainRefPrefix.length), "base64url").toString("utf8");
}

function defaultSecurityRunner(securityBin: string): SecurityCommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(securityBin, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          reject(error);
          return;
        }
        resolve(stdout);
      });
    });
}

function isKeychainNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  return (
    candidate.code === 44 ||
    String(candidate.stderr ?? candidate.message ?? "").includes("could not be found")
  );
}
