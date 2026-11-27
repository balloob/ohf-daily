import ICAL from "ical.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Edition, ReleaseEvent } from "./types";

export interface ReleaseCalendarSource {
  url: string;
  // Version annotations identify an occurrence, not its scheduled date. A
  // RECURRENCE-ID exception can move the date without losing the version.
  versions?: Array<{ uid: string; occurrence: string; version: string }>;
}

const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

function calendarDate(value: ICAL.Time, timeZone: string): string {
  if (value.isDate || value.zone.tzid === "floating") return value.toString().slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value.toJSDate());
}

function releaseIdentity(summary: string): Pick<ReleaseEvent, "product" | "kind" | "accent"> | null {
  if (!/\brelease\b|\bbeta\b/i.test(summary)) return null;
  const product = /^Home Assistant\b/i.test(summary) ? "Home Assistant"
    : /^ESPHome\b/i.test(summary) ? "ESPHome"
    : /^Music Assistant\b/i.test(summary) ? "Music Assistant" : null;
  if (!product) return null;
  return { product, kind: /\bbeta\b/i.test(summary) ? "Beta" : "Release", accent: product === "Home Assistant" ? "blue" : product === "ESPHome" ? "green" : "rust" };
}

/** Expand the official schedule, including moved/cancelled occurrences. */
export function parseReleaseCalendar(
  body: string, source: ReleaseCalendarSource, editionDate: string, horizonDays = 45, timeZone = "Europe/Amsterdam",
): ReleaseEvent[] {
  if (!/END:VCALENDAR\s*$/i.test(body.trim())) throw new Error("Incomplete release calendar.");
  const calendar = new ICAL.Component(ICAL.parse(body));
  if (calendar.name !== "vcalendar") throw new Error("Invalid release calendar.");
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const tzid = String(zone.getFirstPropertyValue("tzid"));
    ICAL.TimezoneService.register(new ICAL.Timezone({ component: zone, tzid }));
  }
  // Keep the highest-sequence revision for each master/exception.
  const revisions = new Map<string, ICAL.Component>();
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const key = `${component.getFirstPropertyValue("uid")}/${component.getFirstPropertyValue("recurrence-id") ?? "master"}`;
    const old = revisions.get(key);
    if (!old || Number(component.getFirstPropertyValue("sequence") ?? 0) >= Number(old.getFirstPropertyValue("sequence") ?? 0)) revisions.set(key, component);
  }
  const components = [...revisions.values()];
  const horizon = shiftDate(editionDate, horizonDays);
  // Look beyond the visible horizon to label betas with the next stable
  // version (e.g. a late-December beta is for January).
  const expandedHorizon = shiftDate(horizon, 62);
  const occurrences: ReleaseEvent[] = [];
  let recognized = 0;
  for (const master of components.filter((component) => !component.hasProperty("recurrence-id"))) {
    if (!releaseIdentity(String(master.getFirstPropertyValue("summary") ?? ""))) continue;
    recognized++;
    if (master.getFirstPropertyValue("status") === "CANCELLED") continue;
    const uid = String(master.getFirstPropertyValue("uid") ?? "");
    if (!uid || !master.hasProperty("dtstart")) throw new Error("Release calendar event lacks UID or DTSTART.");
    const exceptions = components.filter((component) => component.hasProperty("recurrence-id") && component.getFirstPropertyValue("uid") === uid);
    // A far-future occurrence can be moved into the current window.
    const iterationEnd = exceptions.reduce((end, component) => {
      const date = String(component.getFirstPropertyValue("recurrence-id")).slice(0, 10);
      return date > end ? date : end;
    }, expandedHorizon);
    const event = new ICAL.Event(master, { exceptions, strictExceptions: true });
    const iterator = event.iterator();
    let complete = false;
    for (let count = 0; count < 50_000; count++) {
      const occurrence = iterator.next();
      if (!occurrence || occurrence.toString().slice(0, 10) > iterationEnd) { complete = true; break; }
      const details = event.getOccurrenceDetails(occurrence);
      if (details.item.component.getFirstPropertyValue("status") === "CANCELLED") continue;
      const identity = releaseIdentity(details.item.summary);
      if (!identity) continue;
      const date = calendarDate(details.startDate, timeZone);
      if (date < editionDate || date > expandedHorizon) continue;
      const originalDate = occurrence.toString().slice(0, 10);
      const version = source.versions?.find((entry) => entry.uid === uid && entry.occurrence === originalDate)?.version;
      occurrences.push({ ...identity, date, ...(version ? { version } : {}), sourceId: `ical:${uid}/${originalDate}` });
    }
    if (!complete) throw new Error("Release calendar recurrence limit exceeded.");
  }
  if (!recognized) throw new Error("Release calendar contains no recognized release schedules.");
  const ordered = occurrences.sort((a, b) => a.date.localeCompare(b.date) || a.product.localeCompare(b.product));
  for (const event of ordered) {
    if (event.version || !["Home Assistant", "ESPHome"].includes(event.product)) continue;
    const stable = event.kind === "Release" ? event : ordered.find((candidate) => candidate.product === event.product && candidate.kind === "Release" && candidate.date >= event.date);
    if (stable) {
      const [year, month] = stable.date.split("-").map(Number);
      event.version = `${year}.${month}`;
    }
  }
  return [...new Map(ordered.filter((event) => event.date <= horizon).map((event) => [`${event.product}/${event.kind}/${event.date}`, event])).values()];
}

export async function collectReleaseCalendar(options: {
  source: ReleaseCalendarSource; editionDate: string; horizonDays?: number; timeZone?: string;
  cacheDirectory: string; editionDirectory: string; fetcher?: typeof fetch;
}): Promise<ReleaseEvent[]> {
  const { source, editionDate, cacheDirectory, editionDirectory } = options;
  const horizonDays = options.horizonDays ?? 45;
  let events: ReleaseEvent[];
  let audit: Record<string, unknown>;
  try {
    const response = await (options.fetcher ?? fetch)(source.url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Release calendar returned HTTP ${response.status}.`);
    const body = await response.text();
    events = parseReleaseCalendar(body, source, editionDate, horizonDays, options.timeZone);
    audit = { mode: "live", url: source.url, collectedAt: new Date().toISOString(), events };
  } catch (error) {
    const previousDate = shiftDate(editionDate, -1);
    const previous = JSON.parse(await readFile(resolve(editionDirectory, `${previousDate}.json`), "utf8")) as Edition;
    if (previous.date !== previousDate || !Array.isArray(previous.releases)) throw new Error("Previous edition lacks a release calendar snapshot.");
    events = previous.releases.filter((event) => event.kind !== "Event" && event.date >= editionDate && event.date <= shiftDate(editionDate, horizonDays));
    audit = { mode: "previous-edition", previousDate, reason: error instanceof Error ? error.message : String(error), events };
  }
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(resolve(cacheDirectory, `${editionDate}.json`), `${JSON.stringify(audit, null, 2)}\n`);
  return events;
}
