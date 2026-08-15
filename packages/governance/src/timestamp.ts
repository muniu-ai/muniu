const STRICT_RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates both the RFC3339 shape and the actual Gregorian calendar value.
 * Date.parse alone is intentionally insufficient because it accepts inputs
 * such as date-only strings, locale dates, and normalized invalid days.
 */
export function isStrictRfc3339Timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !STRICT_RFC3339_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysPerMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const offset = /[+-](\d{2}):(\d{2})$/.exec(value);
  return (
    !offset ||
    (Number(offset[1]) <= 14 &&
      Number(offset[2]) <= 59 &&
      (Number(offset[1]) !== 14 || Number(offset[2]) === 0))
  );
}
