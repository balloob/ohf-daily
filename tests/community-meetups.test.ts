import assert from "node:assert/strict";
import test from "node:test";
import { collectCommunityMeetups, deduplicateCommunityMeetups, parseCommunityCalendar, upcomingCommunityMeetups } from "../src/lib/community-meetups";

const source = { id: "community", name: "Community", url: "https://api.luma.com/feed", calendar_url: "https://luma.com/community" };
const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\r\n");
function event(id: string, extra = "", start = "20261107T170000Z", end = "20261107T190000Z") {
  return ["BEGIN:VEVENT", `UID:${id}`, `DTSTART:${start}`, `DTEND:${end}`, "SUMMARY:Community\\, meetup", `DESCRIPTION:Get up-to-date information at: https://luma.com/${id}`, "LOCATION:A hall\\, Main Street", extra, "END:VEVENT"].filter(Boolean).join("\r\n");
}

test("reads folded Luma descriptions and escaped text without discarding overlapping meetups", () => {
  const text = calendar(event("one").replace("https://luma.com/one", "https://luma.com/o\r\n ne"), event("two"));
  const parsed = parseCommunityCalendar(text, source);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, "https://luma.com/one");
  assert.equal(parsed[0].title, "Community, meetup");
  assert.equal(parsed[0].location, "A hall, Main Street");
  assert.equal(parsed[0].date, "2026-11-07");
});

test("uses the publication timezone for timed events and treats all-day end dates as exclusive", () => {
  const allDay = ["BEGIN:VEVENT", "UID:all-day", "DTSTART;VALUE=DATE:20260917", "DTEND;VALUE=DATE:20260920", "SUMMARY:Three day meetup", "URL:https://luma.com/all-day", "END:VEVENT"].join("\r\n");
  const parsed = parseCommunityCalendar(calendar(event("overnight", "", "20260917T233000Z", "20260919T220000Z"), allDay), source);
  assert.equal(parsed[0].date, "2026-09-18");
  assert.equal(parsed[0].endDate, "2026-09-19");
  assert.equal(parsed[1].date, "2026-09-17");
  assert.equal(parsed[1].endDate, "2026-09-19");
  assert.equal(parsed[1].startAt, "2026-09-17T00:00:00.000Z");
  assert.equal(upcomingCommunityMeetups(parsed, "2026-09-19").length, 2);
  assert.equal(upcomingCommunityMeetups(parsed, "2026-09-20").length, 0);
});

test("deduplicates event IDs and event links across calendars but retains shared calendar links", () => {
  const a = parseCommunityCalendar(calendar(event("one")), source)[0];
  const b = { ...a, id: "other-id", calendarUrls: ["https://luma.com/another-calendar"] };
  const result = deduplicateCommunityMeetups([a, b]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].calendarUrls, [source.calendar_url, "https://luma.com/another-calendar"]);
  assert.equal(deduplicateCommunityMeetups([{ ...a, url: source.calendar_url }, { ...a, id: "two", url: source.calendar_url }]).length, 2);
  assert.throws(() => deduplicateCommunityMeetups([a, { ...b, startAt: "2026-11-08T17:00:00.000Z" }]), /disagree/);
});

test("honors latest cancellations and revised dates without resurrecting older revisions", () => {
  const parsed = parseCommunityCalendar(calendar(
    event("cancelled", "SEQUENCE:2\r\nSTATUS:CANCELLED"),
    event("cancelled", "SEQUENCE:1"),
    event("revised", "SEQUENCE:1"),
    event("revised", "SEQUENCE:2", "20261108T170000Z", "20261108T190000Z"),
  ), source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].date, "2026-11-08");
});

test("includes the full horizon and excludes expired or distant meetups", () => {
  const parsed = parseCommunityCalendar(calendar(
    event("past", "", "20260914T170000Z", "20260914T190000Z"),
    event("last-day", "", "20261214T170000Z", "20261214T190000Z"),
    event("outside", "", "20261215T170000Z", "20261215T190000Z"),
  ), source);
  assert.deepEqual(upcomingCommunityMeetups(parsed, "2026-09-15").map((m) => m.id), ["last-day"]);
});

test("rejects truncated feeds, unsupported recurrence and missing timezone instead of publishing partial counts", () => {
  assert.throws(() => parseCommunityCalendar(calendar(event("one")).replace("END:VCALENDAR", ""), source), /incomplete/);
  assert.throws(() => parseCommunityCalendar(calendar(event("one", "RRULE:FREQ=WEEKLY")), source), /individual event occurrences/);
  assert.throws(() => parseCommunityCalendar(calendar(event("one", "", "20261107T170000", "20261107T190000")), source), /timezone/);
});

test("collects all configured calendars, deduplicates, and fails when any feed fails", async () => {
  const fetcher: typeof fetch = async () => new Response(calendar(event("one")), { headers: { "Content-Type": "text/calendar" } });
  const options = { sources: [source, { ...source, id: "second", calendar_url: "https://luma.com/second" }], editionDate: "2026-09-15", fetcher };
  assert.equal((await collectCommunityMeetups(options)).length, 1);
  await assert.rejects(collectCommunityMeetups({ ...options, fetcher: async () => new Response("", { status: 503 }) }), /HTTP 503/);
  assert.deepEqual(await collectCommunityMeetups({ ...options, sources: [{ ...source, enabled: false }], fetcher: async () => { throw new Error("must not fetch"); } }), []);
});
