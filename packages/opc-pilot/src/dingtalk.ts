// SPDX-License-Identifier: Apache-2.0

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual
} from "node:crypto";
import { canonicalFrozenClone, sha256Digest, type SpecJsonValue } from "@mn/specs";

import type {
  DingTalkHttpCallbackV1,
  DingTalkHttpEncryptedEnvelopeV1
} from "./types.js";

const SIGNATURE = /^[a-f0-9]{40}$/u;
const AES_KEY = /^[A-Za-z0-9+/]{43}$/u;
const TIMESTAMP = /^[1-9][0-9]{0,12}$/u;
const TOKEN = /^[A-Za-z0-9]{3,32}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function callbackAesKey(value: string): Buffer {
  if (!AES_KEY.test(value)) throw new TypeError("DingTalk encodingAesKey must contain 43 base64 characters");
  const key = Buffer.from(`${value}=`, "base64");
  if (key.byteLength !== 32) throw new TypeError("DingTalk encodingAesKey must decode to 32 bytes");
  return key;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

export function createDingTalkHttpSignature(
  tokenValue: string,
  timestamp: string,
  nonceValue: string,
  encryptValue: string
): string {
  const token = callbackToken(tokenValue);
  const nonce = boundedText(nonceValue, "DingTalk nonce", 256);
  const encrypt = boundedText(encryptValue, "DingTalk encrypt", 2_097_152);
  if (!TIMESTAMP.test(timestamp)) throw new TypeError("DingTalk timestamp is invalid");
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypt].sort().join(""), "utf8")
    .digest("hex");
}

function callbackToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new TypeError("DingTalk token must contain 3 to 32 letters or digits");
  }
  return value;
}

function assertSignature(expected: string, actual: string): void {
  if (!SIGNATURE.test(actual)) throw new TypeError("DingTalk callback signature is invalid");
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
    throw new Error("DingTalk callback signature is invalid");
  }
}

function padded(value: Buffer): Buffer {
  const padding = 32 - (value.byteLength % 32);
  return Buffer.concat([value, Buffer.alloc(padding, padding)]);
}

function unpadded(value: Buffer): Buffer {
  const padding = value.at(-1);
  if (padding === undefined || padding < 1 || padding > 32 || padding > value.byteLength) {
    throw new Error("DingTalk callback padding is invalid");
  }
  for (const byte of value.subarray(value.byteLength - padding)) {
    if (byte !== padding) throw new Error("DingTalk callback padding is invalid");
  }
  return value.subarray(0, value.byteLength - padding);
}

export function encryptDingTalkHttpResponse(input: {
  readonly token: string;
  readonly encodingAesKey: string;
  readonly ownerKey: string;
  readonly plaintext: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly random: Buffer;
}): DingTalkHttpEncryptedEnvelopeV1 {
  const token = callbackToken(input.token);
  const ownerKey = boundedText(input.ownerKey, "DingTalk ownerKey", 256);
  const plaintext = boundedText(input.plaintext, "DingTalk plaintext", 1_048_576);
  const nonce = boundedText(input.nonce, "DingTalk nonce", 256);
  if (!TIMESTAMP.test(input.timestamp)) throw new TypeError("DingTalk timestamp is invalid");
  if (input.random.byteLength !== 16) throw new TypeError("DingTalk encryption random must contain 16 bytes");
  const key = callbackAesKey(input.encodingAesKey);
  const message = Buffer.from(plaintext, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const clear = padded(Buffer.concat([
    input.random,
    length,
    message,
    Buffer.from(ownerKey, "utf8")
  ]));
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypt = Buffer.concat([cipher.update(clear), cipher.final()]).toString("base64");
  return Object.freeze({
    msgSignature: createDingTalkHttpSignature(token, input.timestamp, nonce, encrypt),
    timeStamp: input.timestamp,
    nonce,
    encrypt
  });
}

export function decryptDingTalkHttpCallback(input: {
  readonly token: string;
  readonly encodingAesKey: string;
  readonly ownerKey: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly encrypt: string;
  readonly nowMs: number;
  readonly maxClockSkewMs: number;
}): DingTalkHttpCallbackV1 {
  const token = callbackToken(input.token);
  const ownerKey = boundedText(input.ownerKey, "DingTalk ownerKey", 256);
  const nonce = boundedText(input.nonce, "DingTalk nonce", 256);
  const encrypt = boundedText(input.encrypt, "DingTalk encrypt", 2_097_152);
  if (!TIMESTAMP.test(input.timestamp)) throw new TypeError("DingTalk callback timestamp is invalid");
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.maxClockSkewMs)
    || input.maxClockSkewMs < 0) {
    throw new TypeError("DingTalk callback clock bounds are invalid");
  }
  const callbackMs = Number(input.timestamp) * 1_000;
  if (!Number.isSafeInteger(callbackMs) || Math.abs(input.nowMs - callbackMs) > input.maxClockSkewMs) {
    throw new Error("DingTalk callback timestamp is outside the accepted window");
  }
  assertSignature(createDingTalkHttpSignature(token, input.timestamp, nonce, encrypt), input.signature);
  const key = callbackAesKey(input.encodingAesKey);
  if (!BASE64.test(encrypt)) throw new TypeError("DingTalk callback encrypt is not canonical base64");
  const encrypted = Buffer.from(encrypt, "base64");
  if (encrypted.toString("base64") !== encrypt) {
    throw new TypeError("DingTalk callback encrypt is not canonical base64");
  }
  if (encrypted.byteLength === 0 || encrypted.byteLength % 16 !== 0) {
    throw new TypeError("DingTalk callback ciphertext length is invalid");
  }
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const clear = unpadded(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  if (clear.byteLength < 20) throw new Error("DingTalk callback payload is truncated");
  const messageLength = clear.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > clear.byteLength) throw new Error("DingTalk callback message length is invalid");
  const owner = clear.subarray(messageEnd);
  const expectedOwner = Buffer.from(ownerKey, "utf8");
  if (owner.byteLength !== expectedOwner.byteLength || !timingSafeEqual(owner, expectedOwner)) {
    throw new Error("DingTalk callback owner binding is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clear.subarray(20, messageEnd).toString("utf8")) as unknown;
  } catch (error) {
    throw new TypeError("DingTalk callback plaintext is not JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("DingTalk callback payload must be an object");
  }
  const payload = canonicalFrozenClone(parsed) as Readonly<Record<string, SpecJsonValue>>;
  const payloadDigest = sha256Digest(payload);
  return canonicalFrozenClone({
    payload,
    payloadDigest,
    idempotencyKey: sha256Digest({
      protocol: "dingtalk.http.callback.v1",
      timestamp: input.timestamp,
      nonce,
      signature: input.signature,
      encryptDigest: sha256Digest(encrypt)
    })
  });
}
