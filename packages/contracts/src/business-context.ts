// SPDX-License-Identifier: Apache-2.0
import type { GoalResourceRefV2 } from "./goals.js";

export interface BusinessContextTargetV2 {
  readonly kind: "customer" | "order" | "delivery" | "review";
  readonly resourceId: string;
}

export interface BusinessObjectContextV2 extends BusinessContextTargetV2 {
  readonly title: string;
  readonly sourceRef: GoalResourceRefV2;
  readonly content: string;
}
