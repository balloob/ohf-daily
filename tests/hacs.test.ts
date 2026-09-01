import assert from "node:assert/strict";
import test from "node:test";
import { hacsNewIntegrationSearchQuery, isHacsIndexAddition, isHacsIntegrationAddition } from "../src/lib/hacs";

const integration = {
  repository: "hacs/default",
  title: "Adds new integration [example/example]",
  labels: ["New default repository"],
};

test("classifies HACS index additions and integration additions", () => {
  assert.equal(isHacsIndexAddition(integration), true);
  assert.equal(isHacsIntegrationAddition(integration), true);
  assert.equal(isHacsIndexAddition({ ...integration, title: "Adds new plugin [example/card]" }), true);
  assert.equal(isHacsIntegrationAddition({ ...integration, title: "Adds new plugin [example/card]" }), false);
  assert.equal(isHacsIndexAddition({ ...integration, labels: [] }), true);
  assert.equal(isHacsIndexAddition({ ...integration, title: "Improve validation checks", labels: [] }), false);
  assert.equal(isHacsIndexAddition({ ...integration, repository: "hacs/integration" }), false);
});

test("builds a bounded authoritative HACS integration-count query", () => {
  assert.equal(
    hacsNewIntegrationSearchQuery(new Date("2026-08-30T22:00:00.000Z"), new Date("2026-08-31T21:59:59.999Z")),
    "repo:hacs/default is:public is:pr is:merged label:\"New default repository\" in:title \"Adds new integration\" merged:2026-08-30T22:00:00.000Z..2026-08-31T21:59:59.999Z",
  );
});
