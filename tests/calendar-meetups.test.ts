import assert from "node:assert/strict";
import test from "node:test";
import { calendarMeetupRows } from "../src/lib/calendar-meetups";
import edition from "../data/editions/2026-09-15.json";
import groups from "../data/community-event-groups.json";
import type { CommunityMeetup, ReleaseEvent } from "../src/lib/types";

const releases = edition.releases as ReleaseEvent[];
const meetups = edition.communityMeetups as CommunityMeetup[];

test("attaches confirmed meetups to their parent event without duplicate calendar rows", () => {
  const rows = calendarMeetupRows(releases, meetups, groups);
  assert.equal(rows.find((row) => row.release?.product === "OHF Summit · Lisbon")?.meetups.length, 1);
  assert.equal(rows.find((row) => row.release?.product === "Open Home Foundation Community Day")?.meetups.length, 20);
  assert.deepEqual(rows.filter((row) => !row.release).map((row) => row.date), ["2026-09-17"]);
  assert.equal(rows.flatMap((row) => row.meetups).length, meetups.length);
});

test("keeps unrelated same-day meetups separate and preserves meetups when a parent is absent", () => {
  const unrelated = { ...meetups[0], id: "unrelated", date: "2026-11-07", endDate: "2026-11-07" };
  const rows = calendarMeetupRows(releases, [...meetups, unrelated], groups);
  assert.deepEqual(rows.find((row) => !row.release && row.date === unrelated.date)?.meetups, [unrelated]);
  const standalone = calendarMeetupRows([], meetups, groups);
  assert.equal(standalone.flatMap((row) => row.meetups).length, meetups.length);
  assert.deepEqual(standalone.map((row) => row.date), ["2026-09-17", "2026-09-23", "2026-11-07"]);
});
