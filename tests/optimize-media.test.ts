import assert from "node:assert/strict";
import test from "node:test";
import { isExternalImageUrl, mediaStem, responsiveWidths } from "../scripts/optimize-media";

test("accepts public HTTPS media and rejects local or non-HTTPS URLs", () => {
  assert.equal(isExternalImageUrl("https://raw.githubusercontent.com/org/repo/sha/image.png"), true);
  assert.equal(isExternalImageUrl("https://github.com/user-attachments/assets/example"), true);
  assert.equal(isExternalImageUrl("https://user-images.githubusercontent.com/123/example.png"), true);
  assert.equal(isExternalImageUrl("https://github-production-user-asset-6210df.s3.amazonaws.com/123/example.png"), true);
  assert.equal(isExternalImageUrl("https://unrelated-bucket.s3.amazonaws.com/example.png"), false);
  assert.equal(isExternalImageUrl("https://example.com/image.png"), false);
  assert.equal(isExternalImageUrl("http://example.com/image.png"), false);
  assert.equal(isExternalImageUrl("https://127.0.0.1/image.png"), false);
  assert.equal(isExternalImageUrl("https://192.168.1.10/image.png"), false);
  assert.equal(isExternalImageUrl("https://[::1]/image.png"), false);
  assert.equal(isExternalImageUrl("/media/already-local.webp"), false);
});

test("chooses responsive widths without upscaling or exceeding the desktop cap", () => {
  assert.deepEqual(responsiveWidths(1800), [480, 960, 1600]);
  assert.deepEqual(responsiveWidths(960), [480, 960]);
  assert.deepEqual(responsiveWidths(320), [320]);
  assert.deepEqual(responsiveWidths(0), []);
  assert.deepEqual(responsiveWidths(1000, [800, 400, 800, 1200]), [400, 800, 1000]);
});

test("builds stable, filesystem-safe media stems", () => {
  const first = mediaStem("iOS energy: gas & batteries", "https://example.com/a.png?size=large");
  const second = mediaStem("iOS energy: gas & batteries", "https://example.com/a.png?size=large");
  assert.equal(first, second);
  assert.match(first, /^ios-energy-gas-batteries-[a-f0-9]{12}$/);
  assert.notEqual(first, mediaStem("iOS energy: gas & batteries", "https://example.com/b.png"));
});
