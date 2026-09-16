import assert from "node:assert/strict";
import test from "node:test";
import { previousEditionLabel } from "../src/lib/edition-navigation";

test("Yesterday follows the reader's date when Amsterdam has already passed midnight", () => {
  const now = new Date("2026-09-16T03:34:00Z");
  assert.equal(previousEditionLabel("2026-09-15", "2026-09-14", now, "America/New_York"), "Yesterday");
  assert.equal(previousEditionLabel("2026-09-15", "2026-09-14", now, "Europe/Amsterdam"), "Previous");
  assert.equal(previousEditionLabel("2026-09-16", "2026-09-15", now, "Europe/Amsterdam"), "Yesterday");
});

test("older editions and gaps retain Previous, including across daylight saving changes", () => {
  const now = new Date("2026-11-02T04:30:00Z");
  assert.equal(previousEditionLabel("2026-11-01", "2026-10-31", now, "America/New_York"), "Yesterday");
  assert.equal(previousEditionLabel("2026-11-01", "2026-10-30", now, "America/New_York"), "Previous");
  assert.equal(previousEditionLabel("2026-10-31", "2026-10-30", now, "America/New_York"), "Previous");
  assert.equal(previousEditionLabel(undefined, "2026-10-31", now, "America/New_York"), "Previous");
});
