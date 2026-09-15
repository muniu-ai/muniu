// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { runKeychainCommand } from "./keychain-command.js";

import type { JsonObject } from "@mn/contracts";

import { canonicalJson } from "./integrity.js";

export interface KeyContext extends JsonObject {
  readonly tenantId: string;
  readonly purpose: string;
}

export interface WrappedDataKey {
  readonly algorithm: "AES-256-GCM";
  readonly provider: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly context: KeyContext;
}

export interface KeyProvider {
  wrapKey(dataKey: Uint8Array, context: KeyContext): Promise<WrappedDataKey>;
  unwrapKey(wrapped: WrappedDataKey): Promise<Buffer>;
  revokeKey?(wrapped: WrappedDataKey): Promise<void>;
  isKeyRevoked?(wrapped: WrappedDataKey): Promise<boolean>;
}

export interface EncryptedEnvelopeV1 {
  readonly version: 1;
  readonly algorithm: "AES-256-GCM";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
  readonly context: KeyContext;
  readonly wrappedKey: WrappedDataKey;
}

function encryptWithKey(plain: Uint8Array, key: Uint8Array, context: KeyContext) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(context)));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptWithKey(
  encrypted: { readonly nonce: string; readonly ciphertext: string; readonly tag: string },
  key: Uint8Array,
  context: KeyContext
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
  decipher.setAAD(Buffer.from(canonicalJson(context)));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]);
}

export class InMemoryKeyProvider implements KeyProvider {
  readonly #masterKey: Buffer;
  readonly #provider: string;
  readonly #keyId: string;
  readonly #revoked = new Set<string>();

  constructor(masterKey: Uint8Array, options: { provider?: string; keyId?: string } = {}) {
    if (masterKey.byteLength !== 32) throw new TypeError("Wrapping key must contain exactly 32 bytes");
    this.#masterKey = Buffer.from(masterKey);
    this.#provider = options.provider ?? "memory";
    this.#keyId = options.keyId ?? "memory:v1";
  }

  async wrapKey(dataKey: Uint8Array, context: KeyContext): Promise<WrappedDataKey> {
    if (dataKey.byteLength !== 32) throw new TypeError("Data key must contain exactly 32 bytes");
    return {
      algorithm: "AES-256-GCM",
      provider: this.#provider,
      keyId: this.#keyId,
      ...encryptWithKey(dataKey, this.#masterKey, context),
      context
    };
  }

  async unwrapKey(wrapped: WrappedDataKey): Promise<Buffer> {
    if (await this.isKeyRevoked(wrapped)) throw new Error("Data wrapping key was revoked");
    if (wrapped.keyId !== this.#keyId || wrapped.provider !== this.#provider) {
      throw new Error("Wrapped key belongs to a different key provider");
    }
    return decryptWithKey(wrapped, this.#masterKey, wrapped.context);
  }

  /** Process-local fixture behavior only; production revocation uses an external key store. */
  async revokeKey(wrapped: WrappedDataKey): Promise<void> { this.#revoked.add(canonicalJson(wrapped)); }
  async isKeyRevoked(wrapped: WrappedDataKey): Promise<boolean> { return this.#revoked.has(canonicalJson(wrapped)); }
}

export class EnvelopeCipher {
  constructor(readonly keyProvider: KeyProvider) {}

  async encrypt(plaintext: Uint8Array, context: KeyContext): Promise<EncryptedEnvelopeV1> {
    const dataKey = randomBytes(32);
    try {
      const encrypted = encryptWithKey(plaintext, dataKey, context);
      return {
        version: 1,
        algorithm: "AES-256-GCM",
        ...encrypted,
        context,
        wrappedKey: await this.keyProvider.wrapKey(dataKey, context)
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(envelope: EncryptedEnvelopeV1): Promise<Buffer> {
    if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
      throw new Error("Unsupported encryption envelope");
    }
    if (canonicalJson(envelope.context) !== canonicalJson(envelope.wrappedKey.context)) {
      throw new Error("Envelope and wrapped-key contexts do not match");
    }
    const dataKey = await this.keyProvider.unwrapKey(envelope.wrappedKey);
    try {
      return decryptWithKey(envelope, dataKey, envelope.context);
    } finally {
      dataKey.fill(0);
    }
  }
}

export type KeychainCommand = (args: readonly string[], stdin?: string) => Promise<string>;

function isKeychainNotFound(error: unknown): boolean {
  return /not found|could not be found|-25300|errSecItemNotFound/i.test(String(error));
}

function isKeychainDuplicate(error: unknown): boolean {
  return /already exists|-25299|errSecDuplicateItem/i.test(String(error));
}

export interface MacOsKeychainKeyProviderOptions {
  readonly account: string;
  readonly service?: string;
  readonly command?: KeychainCommand;
  readonly individuallyRevocable?: boolean;
}

export class MacOsKeychainKeyProvider implements KeyProvider {
  readonly #account: string;
  readonly #service: string;
  readonly #command: KeychainCommand;
  readonly #individuallyRevocable: boolean;
  #masterKey?: Buffer;

  constructor(options: MacOsKeychainKeyProviderOptions) {
    this.#account = options.account;
    this.#service = options.service ?? "com.muniu.agent-os.v2";
    if (!this.#service.includes("v2")) throw new TypeError("Keychain service must be isolated for v2");
    this.#command = options.command ?? runKeychainCommand;
    this.#individuallyRevocable = options.individuallyRevocable ?? false;
  }

  async #loadMasterKey(): Promise<Buffer> {
    if (this.#masterKey) return this.#masterKey;
    let encoded: string;
    try {
      encoded = await this.#command([
        "find-generic-password",
        "-s",
        this.#service,
        "-a",
        this.#account,
        "-w"
      ]);
    } catch (error) {
      if (!isKeychainNotFound(error)) throw error;
      const generated = randomBytes(32).toString("base64");
      try {
        await this.#command([
          "add-generic-password",
          "-s",
          this.#service,
          "-a",
          this.#account,
          "-w"
        ], `${generated}\n`);
        encoded = generated;
      } catch (createError) {
        if (!isKeychainDuplicate(createError)) throw createError;
        encoded = await this.#command([
          "find-generic-password",
          "-s",
          this.#service,
          "-a",
          this.#account,
          "-w"
        ]);
      }
    }
    const masterKey = Buffer.from(encoded.trim(), "base64");
    if (masterKey.byteLength !== 32) throw new Error("Keychain wrapping key is invalid");
    this.#masterKey = masterKey;
    return masterKey;
  }

  async wrapKey(dataKey: Uint8Array, context: KeyContext): Promise<WrappedDataKey> {
    if (this.#individuallyRevocable) {
      if (dataKey.byteLength !== 32) throw new TypeError("Data key must contain exactly 32 bytes");
      const account = `${this.#account}:payload:${randomUUID()}`;
      const key = randomBytes(32);
      try {
        await this.#command(["add-generic-password", "-s", this.#service, "-a", account, "-w"], `${key.toString("base64")}\n`);
        return { algorithm: "AES-256-GCM", provider: "macos-keychain-individual",
          keyId: `${this.#service}:${account}`, ...encryptWithKey(dataKey, key, context), context };
      } finally { key.fill(0); }
    }
    const provider = new InMemoryKeyProvider(await this.#loadMasterKey(), {
      provider: "macos-keychain",
      keyId: `${this.#service}:${this.#account}`
    });
    return provider.wrapKey(dataKey, context);
  }

  async unwrapKey(wrapped: WrappedDataKey): Promise<Buffer> {
    if (this.#individuallyRevocable) {
      const account = this.#individualAccount(wrapped);
      // Never create or cache an individual key on read: an old backup must not undo revocation.
      const encoded = await this.#command(["find-generic-password", "-s", this.#service, "-a", account, "-w"]);
      const key = Buffer.from(encoded.trim(), "base64");
      try {
        if (key.byteLength !== 32) throw new Error("Keychain wrapping key is invalid");
        return decryptWithKey(wrapped, key, wrapped.context);
      } finally { key.fill(0); }
    }
    const provider = new InMemoryKeyProvider(await this.#loadMasterKey(), {
      provider: "macos-keychain",
      keyId: `${this.#service}:${this.#account}`
    });
    return provider.unwrapKey(wrapped);
  }

  #individualAccount(wrapped: WrappedDataKey): string {
    const prefix = `${this.#service}:${this.#account}:payload:`;
    if (wrapped.algorithm !== "AES-256-GCM" || wrapped.provider !== "macos-keychain-individual"
      || !wrapped.keyId.startsWith(prefix) || !/^[a-f0-9-]{36}$/u.test(wrapped.keyId.slice(prefix.length))) {
      throw new Error("Wrapped key belongs to a different individual Keychain provider");
    }
    return wrapped.keyId.slice(this.#service.length + 1);
  }

  async revokeKey(wrapped: WrappedDataKey): Promise<void> {
    if (!this.#individuallyRevocable) throw new Error("Shared wrapping keys cannot be individually revoked");
    const account = this.#individualAccount(wrapped);
    try { await this.#command(["delete-generic-password", "-s", this.#service, "-a", account]); }
    catch (error) { if (!isKeychainNotFound(error)) throw error; }
  }

  async isKeyRevoked(wrapped: WrappedDataKey): Promise<boolean> {
    if (!this.#individuallyRevocable) throw new Error("Shared wrapping keys cannot be individually revoked");
    const account = this.#individualAccount(wrapped);
    try {
      await this.#command(["find-generic-password", "-s", this.#service, "-a", account]);
      return false;
    } catch (error) { if (isKeychainNotFound(error)) return true; throw error; }
  }
}
