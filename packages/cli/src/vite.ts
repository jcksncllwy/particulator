import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createStudioHandler } from "./handler.ts";

export interface ParticulatorStudioOptions {
  /** Effect JSON file, relative to the Vite root. */
  effect: string;
  /** Upload directory for dropped images, relative to the Vite root. Must be inside `publicDir`. */
  assets: string;
  /** Static root, relative to the Vite root. Default: Vite's resolved `publicDir` ("public"). */
  publicDir?: string;
}

export const STUDIO_BASE = "/__particulator";

/** The slice of Vite's Plugin/ViteDevServer we use, so vite stays a type-free optional peer. */
interface DevServerLike {
  config: { root: string; publicDir?: string; logger?: { info(msg: string): void } };
  middlewares: {
    use(fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): unknown;
  };
}

export interface ParticulatorStudioPlugin {
  name: string;
  apply: "serve";
  configureServer(server: DevServerLike): void;
}

/** Vite dev-only plugin: serves the studio save protocol at same-origin `/__particulator`. */
export function particulatorStudio(opts: ParticulatorStudioOptions): ParticulatorStudioPlugin {
  return {
    name: "particulator-studio",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const handler = createStudioHandler({
        effect: path.resolve(root, opts.effect),
        assets: path.resolve(root, opts.assets),
        publicDir: opts.publicDir
          ? path.resolve(root, opts.publicDir)
          : server.config.publicDir || path.resolve(root, "public"),
        base: STUDIO_BASE,
      });
      server.middlewares.use(handler);
      server.config.logger?.info(`  particulator studio save server at ${STUDIO_BASE}`);
    },
  };
}
