import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createStudioHandler, type StudioHandlerOptions } from "./handler.ts";

export interface StudioServerOptions extends StudioHandlerOptions {
  /** Default 4747. Use 0 for a random free port. */
  port?: number;
  /** Default 127.0.0.1 (loopback only). */
  host?: string;
}

export interface StudioServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 4747;
export const DEFAULT_HOST = "127.0.0.1";

export function startStudioServer(opts: StudioServerOptions): Promise<StudioServer> {
  const { port = DEFAULT_PORT, host = DEFAULT_HOST, ...handlerOpts } = opts;
  const handler = createStudioHandler(handlerOpts);
  const server = createServer((req, res) => handler(req, res));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const actual = (server.address() as AddressInfo).port;
      resolve({
        url: `http://${displayHost(host)}:${actual}`,
        port: actual,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}
