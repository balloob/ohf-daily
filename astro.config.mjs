import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL || "https://balloob.github.io/ohf-daily",
  base: process.env.BASE_PATH || "/",
  output: "static",
  build: {
    format: "directory",
  },
  vite: {
    build: {
      cssMinify: true,
    },
  },
});
