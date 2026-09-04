// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

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
    if (wrapped.keyId !== this.#keyId || wrapped.provider !== this.#provider) {
      throw new Error("Wrapped key belongs to a different key provider");
    }
    return decryptWithKey(wrapped, this.#masterKey, wrapped.context);
  }
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

function runSecurity(args: readonly string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `security exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}

export interface MacOsKeychainKeyProviderOptions {
  readonly account: string;
  readonly service?: string;
  readonly command?: KeychainCommand;
}

export class MacOsKeychainKeyProvider implements KeyProvider {
  readonly #account: string;
  readonly #service: string;
  readonly #command: KeychainCommand;
  #masterKey?: Buffer;

  constructor(options: MacOsKeychainKeyProviderOptions) {
    this.#account = options.account;
    this.#service = options.service ?? "com.muniu.agent-os.v2";
    if (!this.#service.includes("v2")) throw new TypeError("Keychain service must be isolated for v2");
    this.#command = options.command ?? runSecurity;
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
    const provider = new InMemoryKeyProvider(await this.#loadMasterKey(), {
      provider: "macos-keychain",
      keyId: `${this.#service}:${this.#account}`
    });
    return provider.wrapKey(dataKey, context);
  }

  async unwrapKey(wrapped: WrappedDataKey): Promise<Buffer> {
    const provider = new InMemoryKeyProvider(await this.#loadMasterKey(), {
      provider: "macos-keychain",
      keyId: `${this.#service}:${this.#account}`
    });
    return provider.unwrapKey(wrapped);
  }
}
