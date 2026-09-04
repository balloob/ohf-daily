import type { StoredContent } from "./content-store";
import type { ReleaseEvent } from "./types";

export interface EditorialEventPlan {
  name: string;
  date: string;
  endDate: string | null;
  accent: "blue" | "green" | "rust";
  contentSourceId: string;
}

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("Calendar event dates must use YYYY-MM-DD format.");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("Calendar event dates must be valid calendar dates.");
  }
  return parsed;
}

function addDays(value: string, days: number): string {
  const parsed = calendarDate(value);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function sourceMentionsDate(source: StoredContent, date: string): boolean {
  const parsed = calendarDate(date);
  const year = parsed.getUTCFullYear();
  const month = monthNames[parsed.getUTCMonth()];
  const day = parsed.getUTCDate();
  const text = `${source.title}\n${source.body ?? ""}`;
  if (!new RegExp(`\\b${year}\\b`).test(text)) return false;
  if (text.includes(date)) return true;

  const monthDay = new RegExp(`\\b${month}\\s+${day}(?!\\d)`, "i");
  const dayMonth = new RegExp(`\\b${day}\\s+${month}\\b`, "i");
  const rangeEnd = new RegExp(`\\b${month}\\s+\\d{1,2}\\s*(?:to|through|until|[-–—])\\s*${day}(?!\\d)`, "i");
  return monthDay.test(text) || dayMonth.test(text) || rangeEnd.test(text);
}

export function calendarEventCandidates(
  content: StoredContent[],
  from: string,
  horizonDays = 90,
): Array<{ source: StoredContent; dates: string[] }> {
  if (!Number.isInteger(horizonDays) || horizonDays < 0) return [];
  const dates = Array.from({ length: horizonDays + 1 }, (_, index) => addDays(from, index));
  const oldestAnnouncement = Date.parse(`${addDays(from, -180)}T00:00:00Z`);
  const editionEnd = Date.parse(`${addDays(from, 1)}T00:00:00Z`);
  const byUrl = new Map<string, StoredContent>();
  for (const source of content) {
    if (source.kind !== "official_post") continue;
    const publishedAt = Date.parse(source.publishedAt);
    if (!Number.isFinite(publishedAt) || publishedAt < oldestAnnouncement || publishedAt >= editionEnd) continue;
    const existing = byUrl.get(source.url);
    if (!existing || (source.body?.length ?? 0) > (existing.body?.length ?? 0)) byUrl.set(source.url, source);
  }
  return [...byUrl.values()].flatMap((source) => {
    const mentioned = dates.filter((date) => sourceMentionsDate(source, date));
    return mentioned.length > 0 ? [{ source, dates: mentioned }] : [];
  });
}

export function resolveEditorialEvents(
  plans: EditorialEventPlan[],
  content: StoredContent[],
  editionDate: string,
  horizonDays = 90,
): ReleaseEvent[] {
  const horizon = addDays(editionDate, horizonDays);
  const sources = new Map(content.map((source) => [source.id, source]));
  const resolved: ReleaseEvent[] = [];

  for (const plan of plans) {
    const name = plan.name?.trim();
    if (!name || name.length > 80) throw new Error("Editorial calendar event names must contain 1–80 characters.");
    const source = sources.get(plan.contentSourceId);
    if (!source || source.kind !== "official_post") {
      throw new Error(`Calendar event ${name} must cite one exact official content source ID.`);
    }
    calendarDate(plan.date);
    const endDate = plan.endDate ?? plan.date;
    calendarDate(endDate);
    if (endDate < plan.date) throw new Error(`Calendar event ${name} ends before it starts.`);
    if (endDate < editionDate || plan.date > horizon) throw new Error(`Calendar event ${name} falls outside the event horizon.`);
    if (!sourceMentionsDate(source, plan.date) || (plan.endDate && !sourceMentionsDate(source, plan.endDate))) {
      throw new Error(`Calendar event ${name} contains a date not found in its cited official source.`);
    }
    resolved.push({
      product: name,
      kind: "Event",
      date: plan.date,
      ...(plan.endDate && plan.endDate !== plan.date ? { endDate: plan.endDate } : {}),
      accent: plan.accent,
      url: source.url,
      sourceId: source.id,
    });
  }

  return resolved
    .filter((event, index, all) => all.findIndex((candidate) => candidate.product.toLowerCase() === event.product.toLowerCase() && candidate.date === event.date) === index)
    .sort((left, right) => left.date.localeCompare(right.date));
}
