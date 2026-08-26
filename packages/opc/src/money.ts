// SPDX-License-Identifier: Apache-2.0

import type { MoneyV1 } from "./types.js";
import { canonicalFrozenClone } from "./shared.js";

const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MINOR_UNITS_PATTERN = /^(?:0|-?[1-9][0-9]*)$/u;

export function createMoney(currency: string, minorUnits: string): MoneyV1 {
  if (!CURRENCY_PATTERN.test(currency)) throw new TypeError("currency must be a three-letter uppercase ISO 4217 code");
  if (!MINOR_UNITS_PATTERN.test(minorUnits)) throw new TypeError("minorUnits must be a canonical decimal integer string");
  return canonicalFrozenClone({ currency, minorUnits });
}
