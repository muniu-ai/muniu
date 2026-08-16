// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { EventId } from "@mn/agent-protocol";

const SAFE_QUATERNARY_ALPHABET = "wxyz";

/** Produce a random identifier whose representation cannot resemble protected numeric material. */
export function createSafeRandomEventId(): EventId {
  const encoded = randomUUID().replaceAll("-", "").replace(/[0-9a-f]/gu, (character) => {
    const value = Number.parseInt(character, 16);
    return `${SAFE_QUATERNARY_ALPHABET[value >> 2]}${SAFE_QUATERNARY_ALPHABET[value & 3]}`;
  });
  return EventId(`evt-${encoded}`);
}
