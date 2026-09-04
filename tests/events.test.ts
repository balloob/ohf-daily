import assert from "node:assert/strict";
import test from "node:test";
import { calendarEventCandidates, resolveEditorialEvents, sourceMentionsDate } from "../src/lib/events";
import type { StoredContent } from "../src/lib/content-store";

const ifa: StoredContent = {
  id: "official:ifa",
  kind: "official_post",
  source: "Open Home Foundation Blog",
  title: "IFA Berlin 2026: Save the date",
  url: "https://www.openhomefoundation.org/blog/ifa-berlin-2026-save-the-date/",
  publishedAt: "2026-06-30T00:00:00Z",
  author: null,
  body: "From September 4 to 8, 2026, the Open Home Foundation will be exhibiting at IFA Berlin.",
  mediaUrls: [],
  schemaVersion: 1,
  revision: 1,
  firstSeenAt: "2026-06-30T00:00:00Z",
  storedAt: "2026-06-30T00:00:00Z",
};

const communityDay: StoredContent = {
  ...ifa,
  id: "official:community-day",
  title: "Community Day 2026: Save the date!",
  url: "https://www.openhomefoundation.org/blog/community-day-2026-save-the-date/",
  publishedAt: "2026-08-13T00:00:00Z",
  body: "Community Day will be held on Saturday, November 7!",
};

test("finds future dates in official posts, including range end dates", () => {
  assert.equal(sourceMentionsDate(ifa, "2026-09-04"), true);
  assert.equal(sourceMentionsDate(ifa, "2026-09-08"), true);
  assert.equal(sourceMentionsDate(communityDay, "2026-11-07"), true);
  assert.deepEqual(calendarEventCandidates([ifa, communityDay], "2026-09-04", 90).map(({ source }) => source.id), ["official:ifa", "official:community-day"]);
  assert.deepEqual(calendarEventCandidates([{ ...ifa, publishedAt: "2025-06-30T00:00:00Z" }], "2026-09-04", 90), []);
});

test("resolves selected events only from exact official evidence", () => {
  const events = resolveEditorialEvents([{
    name: "IFA Berlin",
    date: "2026-09-04",
    endDate: "2026-09-08",
    accent: "blue",
    contentSourceId: ifa.id,
  }, {
    name: "Community Day",
    date: "2026-11-07",
    endDate: null,
    accent: "green",
    contentSourceId: communityDay.id,
  }], [ifa, communityDay], "2026-09-04", 90);

  assert.deepEqual(events.map(({ product, date, endDate, url }) => ({ product, date, endDate, url })), [{
    product: "IFA Berlin",
    date: "2026-09-04",
    endDate: "2026-09-08",
    url: ifa.url,
  }, {
    product: "Community Day",
    date: "2026-11-07",
    endDate: undefined,
    url: communityDay.url,
  }]);
  assert.throws(() => resolveEditorialEvents([{
    name: "Invented event",
    date: "2026-10-12",
    endDate: null,
    accent: "rust",
    contentSourceId: ifa.id,
  }], [ifa], "2026-09-04", 90), /date not found/);
});
