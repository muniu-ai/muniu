/*
 * Adapted from DeepSeek Harness at fixed commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 * Original path: packages/llm/llm/src/brand.ts
 * Copyright (c) 2026 DeepSeek
 * SPDX-License-Identifier: MIT
 *
 * Adaptation: the Cordis-independent v0.1 protocol owns a closed set of IDs.
 */

declare const brand: unique symbol;
export type Branded<Name extends string> = string & { readonly [brand]: Name };

export type SessionId = Branded<"SessionId">;
export type EventId = Branded<"EventId">;
export type MessageId = Branded<"MessageId">;
export type CallId = Branded<"CallId">;
export type RunId = Branded<"RunId">;
export type CandidateId = Branded<"CandidateId">;
export type Digest = Branded<"Digest">;

export const SessionId = (value: string): SessionId => value as SessionId;
export const EventId = (value: string): EventId => value as EventId;
export const MessageId = (value: string): MessageId => value as MessageId;
export const CallId = (value: string): CallId => value as CallId;
export const RunId = (value: string): RunId => value as RunId;
export const CandidateId = (value: string): CandidateId => value as CandidateId;
export const Digest = (value: string): Digest => value as Digest;
