import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { isBotLogin, loadContributorCache, lookupContributorDetails, lookupFirstContribution } from "../src/lib/contributors";

test("recognizes common GitHub bot login forms", () => {
  assert.equal(isBotLogin("dependabot[bot]"), true);
  assert.equal(isBotLogin("release-bot"), true);
  assert.equal(isBotLogin("github-actions"), true);
  assert.equal(isBotLogin("esphbot"), true);
  assert.equal(isBotLogin("bluetoothbot"), true);
  assert.equal(isBotLogin("Copilot"), true);
  assert.equal(isBotLogin("human-builder"), false);
});

test("looks up and atomically caches the authoritative first merged contribution", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "ohf-contributors-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "contributors.json");
  const cache = await loadContributorCache(path);
  let requests = 0;
  let requestedUrl = "";
  const client = {
    async get<T>(url: string): Promise<T> {
      requests += 1;
      requestedUrl = url;
      return {
        incomplete_results: false,
        items: [{ number: 17, html_url: "https://github.com/home-assistant/core/pull/17", pull_request: { merged_at: "2024-01-02T03:04:05Z" } }],
      } as T;
    },
  };
  const first = await lookupFirstContribution(client, path, cache, "home-assistant/core", "NewHuman", new Date("2026-08-31T12:00:00Z"));
  assert.deepEqual(first, { mergedAt: "2024-01-02T03:04:05Z", url: "https://github.com/home-assistant/core/pull/17", number: 17 });
  assert.match(decodeURIComponent(requestedUrl), /repo:home-assistant\/core is:pr is:merged author:NewHuman/);
  assert.match(requestedUrl, /sort=created&order=asc&per_page=1/);
  assert.equal(requests, 1);

  assert.deepEqual(await lookupFirstContribution(client, path, cache, "home-assistant/core", "NewHuman"), first);
  assert.equal(requests, 1);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.repositories["home-assistant/core"].NewHuman.number, 17);
  assert.equal(persisted.repositories["home-assistant/core"].NewHuman.fetchedAt, "2026-08-31T12:00:00.000Z");
});

test("rejects bots and incomplete searches without caching claims", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "ohf-contributors-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "contributors.json");
  const cache = await loadContributorCache(path);
  const client = { async get<T>(): Promise<T> { return { incomplete_results: true, items: [] } as T; } };
  await assert.rejects(lookupFirstContribution(client, path, cache, "home-assistant/core", "dependabot[bot]"), /human repository author/);
  await assert.rejects(lookupFirstContribution(client, path, cache, "home-assistant/core", "Human"), /incomplete/);
  assert.deepEqual(cache.repositories, {});
});

test("fetches a public contributor profile once and reuses it across repositories", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "ohf-contributors-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "contributors.json");
  const cache = await loadContributorCache(path);
  const requestedUrls: string[] = [];
  const client = {
    async get<T>(url: string): Promise<T> {
      requestedUrls.push(url);
      if (url.includes("/users/")) {
        return {
          login: "NewHuman",
          name: "New Human",
          avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
          html_url: "https://github.com/NewHuman",
        } as T;
      }
      const number = url.includes("repo%3Aesphome") ? 8 : 17;
      return {
        incomplete_results: false,
        items: [{ number, html_url: `https://github.com/example/repo/pull/${number}`, pull_request: { merged_at: "2024-01-02T03:04:05Z" } }],
      } as T;
    },
  };

  const details = await lookupContributorDetails(client, path, cache, "home-assistant/core", "NewHuman", new Date("2026-08-31T12:00:00Z"));
  assert.deepEqual(details.profile, {
    login: "NewHuman",
    name: "New Human",
    avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
    profileUrl: "https://github.com/NewHuman",
  });
  assert.equal(requestedUrls.filter((url) => url.includes("/users/")).length, 1);

  await lookupContributorDetails(client, path, cache, "esphome/esphome", "newhuman", new Date("2026-09-01T12:00:00Z"));
  assert.equal(requestedUrls.filter((url) => url.includes("/users/")).length, 1);
  assert.equal(requestedUrls.length, 3);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.profiles.newhuman.name, "New Human");
  assert.equal(persisted.profiles.newhuman.avatarUrl, "https://avatars.githubusercontent.com/u/123?v=4");
  assert.equal(persisted.profiles.newhuman.fetchedAt, "2026-08-31T12:00:00.000Z");
});
