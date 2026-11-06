import { defineConfig } from "vite";
import { particulatorStudio } from "@particulator/cli/vite";

// The studio's save server, mounted in the dev server at /__particulator.
export default defineConfig({
  base: "./", // relative URLs, so a build can be hosted under any path
  plugins: [particulatorStudio({ effect: "src/effect.json", assets: "public/particulator" })],
});
