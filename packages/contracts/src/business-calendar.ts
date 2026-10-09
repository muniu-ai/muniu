// SPDX-License-Identifier: Apache-2.0

export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

const businessCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

/** M1 CNY records use Beijing calendar dates; audit timestamps remain UTC. */
export function businessDateAt(timestamp: string): string {
  const parts = businessCalendar.formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
