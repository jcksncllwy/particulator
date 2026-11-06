import { defineConfig } from "vite";
import { particulatorStudio } from "@particulator/cli/vite";

// The studio's save server, mounted in the dev server at /__particulator.
export default defineConfig({
  // The demo build sets BASE to where it's hosted (e.g. /particulator/). Absolute,
  // because hosts serve /particulator without the slash, which breaks relative URLs.
  base: process.env.BASE ?? "/",
  plugins: [particulatorStudio({ effect: "src/effect.json", assets: "public/particulator" })],
});
