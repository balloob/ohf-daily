import ICAL from "ical.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommunityMeetup, Edition } from "./types";

export interface CommunityCalendarSource {
  id: string;
  name: string;
  url: string;
  calendar_url: string;
  enabled?: boolean;
}

export function dateInCalendarZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function upcomingCommunityMeetups(meetups: CommunityMeetup[], date: string, horizonDays = 90): CommunityMeetup[] {
  const end = new Date(`${date}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + horizonDays);
  const horizon = end.toISOString().slice(0, 10);
  return meetups.filter((meetup) => meetup.endDate >= date && meetup.date <= horizon)
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.title.localeCompare(b.title));
}

function publicEventUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !["luma.com", "lu.ma"].includes(url.hostname)) return;
    url.hostname = "luma.com";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch { return; }
}

/** Luma supplies individual occurrences, with UTC times or exclusive all-day ends. */
export function parseCommunityCalendar(text: string, source: CommunityCalendarSource, timeZone = "Europe/Amsterdam"): CommunityMeetup[] {
  if (!text.trimEnd().endsWith("END:VCALENDAR")) throw new Error(`${source.name}: incomplete calendar feed.`);
  const calendar = new ICAL.Component(ICAL.parse(text));
  if (calendar.name !== "vcalendar") throw new Error(`${source.name}: expected an iCalendar feed.`);
  const revisions = new Map<string, ICAL.Component>();
  for (const item of calendar.getAllSubcomponents("vevent")) {
    const uid = String(item.getFirstPropertyValue("uid") ?? "");
    if (!uid) throw new Error(`${source.name}: event is missing its UID.`);
    if (item.hasProperty("rrule") || item.hasProperty("rdate") || item.hasProperty("recurrence-id")) {
      throw new Error(`${source.name}: feed must provide individual event occurrences.`);
    }
    const previous = revisions.get(uid);
    if (!previous || Number(item.getFirstPropertyValue("sequence") ?? 0) >= Number(previous.getFirstPropertyValue("sequence") ?? 0)) revisions.set(uid, item);
  }
  return [...revisions.entries()].flatMap(([id, item]) => {
    if (String(item.getFirstPropertyValue("status")).toUpperCase() === "CANCELLED") return [];
    const title = String(item.getFirstPropertyValue("summary") ?? "").trim();
    const start = item.getFirstPropertyValue("dtstart");
    const end = item.getFirstPropertyValue("dtend");
    if (!title || !(start instanceof ICAL.Time) || !(end instanceof ICAL.Time)) throw new Error(`${source.name}: event has incomplete name or dates.`);
    for (const time of [start, end]) {
      if (!time.isDate && time.zone.tzid === "floating") throw new Error(`${source.name}: event time has no supported timezone.`);
    }
    if (start.isDate !== end.isDate) throw new Error(`${source.name}: mixed all-day and timed event dates.`);
    const startAt = start.isDate ? new Date(Date.UTC(start.year, start.month - 1, start.day)) : start.toJSDate();
    const endAt = end.isDate ? new Date(Date.UTC(end.year, end.month - 1, end.day)) : end.toJSDate();
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) throw new Error(`${source.name}: invalid event interval.`);
    const description = String(item.getFirstPropertyValue("description") ?? "");
    const candidates = [String(item.getFirstPropertyValue("url") ?? ""), ...description.matchAll(/https:\/\/(?:luma\.com|lu\.ma)\/[^\s<>]+/g)].map((value) => typeof value === "string" ? value : value[0]);
    const url = candidates.map(publicEventUrl).find(Boolean);
    if (!url) throw new Error(`${source.name}: event is missing a public Luma link.`);
    const location = String(item.getFirstPropertyValue("location") ?? "").trim();
    return [{
      id, title, url, startAt: startAt.toISOString(), endAt: endAt.toISOString(), allDay: start.isDate,
      date: start.isDate ? start.toString() : dateInCalendarZone(startAt, timeZone),
      // DTEND is exclusive, including midnight at the end of an all-day event.
      endDate: start.isDate ? new Date(endAt.getTime() - 1).toISOString().slice(0, 10) : dateInCalendarZone(new Date(endAt.getTime() - 1), timeZone),
      ...(location ? { location } : {}), calendarUrls: [source.calendar_url],
    }];
  });
}

export function deduplicateCommunityMeetups(meetups: CommunityMeetup[]): CommunityMeetup[] {
  const result: CommunityMeetup[] = [];
  for (const meetup of meetups) {
    // Imported events sometimes link to the calendar itself, not an event page.
    const existing = result.find((entry) => entry.id === meetup.id || (
      entry.url === meetup.url && !entry.calendarUrls.includes(entry.url) && !meetup.calendarUrls.includes(meetup.url)
    ));
    if (existing) {
      if (existing.startAt !== meetup.startAt || existing.endAt !== meetup.endAt) throw new Error(`Community calendars disagree on the dates for ${meetup.url}.`);
      existing.calendarUrls = [...new Set([...existing.calendarUrls, ...meetup.calendarUrls])];
    } else result.push({ ...meetup, calendarUrls: [...meetup.calendarUrls] });
  }
  return result;
}

export async function collectCommunityMeetups(options: {
  sources: CommunityCalendarSource[];
  editionDate: string;
  timeZone?: string;
  horizonDays?: number;
  cacheDirectory?: string;
  /** Yesterday's published listings are the approved fallback for a feed outage. */
  editionDirectory?: string;
  fetcher?: typeof fetch;
}): Promise<CommunityMeetup[]> {
  const sources = options.sources.filter((source) => source.enabled !== false);
  if (sources.some((source) => !/^[a-z0-9-]+$/.test(source.id))) throw new Error("Invalid community calendar source ID.");
  try {
    const outcomes = await Promise.allSettled(sources.map(async (source) => {
      const response = await (options.fetcher ?? fetch)(source.url, { signal: AbortSignal.timeout(30_000), headers: { Accept: "text/calendar" } });
      if (!response.ok) throw new Error(`${source.name}: calendar HTTP ${response.status}.`);
      const text = await response.text();
      if (Buffer.byteLength(text) > 2_000_000) throw new Error(`${source.name}: calendar feed is too large.`);
      const meetups = parseCommunityCalendar(text, source, options.timeZone);
      if (options.cacheDirectory) {
        await mkdir(options.cacheDirectory, { recursive: true });
        await writeFile(resolve(options.cacheDirectory, `${source.id}.ics`), text);
      }
      return meetups;
    }));
    const results = outcomes.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return upcomingCommunityMeetups(deduplicateCommunityMeetups(results.flat()), options.editionDate, options.horizonDays);
  } catch (error) {
    if (!options.editionDirectory) throw error;
    const previous = new Date(`${options.editionDate}T12:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDate = previous.toISOString().slice(0, 10);
    let edition: Pick<Edition, "date" | "communityMeetups">;
    try {
      edition = JSON.parse(await readFile(resolve(options.editionDirectory, `${previousDate}.json`), "utf8"));
      if (edition.date !== previousDate || !Array.isArray(edition.communityMeetups)) throw new Error("Missing listings");
    } catch {
      throw new Error(`Community calendars unavailable and no saved meetup listings exist for ${previousDate}.`, { cause: error });
    }
    // Use the complete prior snapshot, not a mixture of fresh and stale feeds.
    // This avoids conflicting revisions and preserves cross-feed deduplication.
    const meetups = upcomingCommunityMeetups(deduplicateCommunityMeetups(edition.communityMeetups!), options.editionDate, options.horizonDays);
    if (options.cacheDirectory) {
      await mkdir(options.cacheDirectory, { recursive: true });
      await writeFile(resolve(options.cacheDirectory, `fallback-${options.editionDate}.json`), `${JSON.stringify({
        editionDate: options.editionDate, previousDate, usedAt: new Date().toISOString(),
        sourceIds: sources.map((source) => source.id), meetups: meetups.length,
        reason: "Live calendar refresh failed; publisher-authorized previous-day snapshot used.",
      }, null, 2)}\n`);
    }
    console.log(`Community calendars unavailable; using ${meetups.length} saved meetups from ${previousDate}.`);
    return meetups;
  }
}
