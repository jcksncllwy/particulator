import { defineConfig } from "vite";
import { particulatorStudio } from "@particulator/cli/vite";

// The studio's save server, mounted in the dev server at /__particulator.
export default defineConfig({
  plugins: [particulatorStudio({ effect: "src/effect.json", assets: "public/particulator" })],
});
