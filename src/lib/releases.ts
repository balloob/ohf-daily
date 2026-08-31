import type { ReleaseEvent } from "./types";

export interface ReleaseCycle {
  product: string;
  rule: "first-wednesday";
  beta_days_before: number;
  release_offset_days: number;
  accent: string;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function firstWednesday(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month, 1, 12));
  const offset = (3 - first.getUTCDay() + 7) % 7;
  return addDays(first, offset);
}

function calendarDate(value: Date | string): Date {
  if (typeof value !== "string") {
    if (Number.isNaN(value.getTime())) throw new TypeError("Release calendar start must be a valid date.");
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12));
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("Release calendar start must use YYYY-MM-DD format.");
  }
  const result = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(result.getTime()) || dateOnly(result) !== value) {
    throw new TypeError("Release calendar start must be a valid calendar date.");
  }
  return result;
}

export function buildReleaseCalendar(
  from: Date | string,
  cycles: ReleaseCycle[],
  monthsAhead = 4,
): ReleaseEvent[] {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 1) return [];

  const start = calendarDate(from);
  const events: ReleaseEvent[] = [];
  for (let index = 0; index < monthsAhead; index += 1) {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1, 12));
    const base = firstWednesday(cursor.getUTCFullYear(), cursor.getUTCMonth());
    for (const cycle of cycles) {
      const release = addDays(base, cycle.release_offset_days);
      const beta = addDays(release, -cycle.beta_days_before);
      events.push(
        { product: cycle.product, kind: "Beta", date: dateOnly(beta), accent: cycle.accent },
        { product: cycle.product, kind: "Release", date: dateOnly(release), accent: cycle.accent },
      );
    }
  }

  const today = dateOnly(start);
  return events
    .filter((event, index, all) => event.date >= today && all.findIndex((item) => item.product === event.product && item.kind === event.kind && item.date === event.date) === index)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
}
