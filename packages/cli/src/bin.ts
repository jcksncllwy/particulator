#!/usr/bin/env bun
import path from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, startStudioServer } from "./server.ts";

const HELP = `particulator studio — local save server for the Particulator dev studio

Usage:
  particulator studio [options]

Options:
  --effect <path>   effect JSON file to load/save      (default: effect.json)
  --assets <dir>    where dropped images are written   (default: public/particulator)
  --public <dir>    the app's static root; asset paths
                    are relative to it                 (default: public)
  --port <n>        port                               (default: ${DEFAULT_PORT})
  --host <addr>     bind address                       (default: ${DEFAULT_HOST})
  -h, --help        show this help
`;

interface Args {
  effect: string;
  assets: string;
  public: string;
  port: number;
  host: string;
}

function parse(argv: string[]): { command?: string; help: boolean; args: Args } {
  const args: Args = {
    effect: "effect.json",
    assets: "public/particulator",
    public: "public",
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
  };
  let command: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "-h" || raw === "--help") {
      help = true;
      continue;
    }
    if (!raw.startsWith("--")) {
      if (command) fail(`Unexpected argument: ${raw}`);
      command = raw;
      continue;
    }
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq === -1 ? undefined : eq);
    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
    if (value === undefined) fail(`Missing value for --${key}`);
    switch (key) {
      case "effect":
      case "assets":
      case "public":
      case "host":
        args[key] = value;
        break;
      case "port": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`Invalid port: ${value}`);
        args.port = n;
        break;
      }
      default:
        fail(`Unknown option: --${key}`);
    }
  }
  return { command, help, args };
}

function fail(msg: string): never {
  console.error(`${msg}\n\n${HELP}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { command, help, args } = parse(process.argv.slice(2));
  if (help || !command) {
    console.log(HELP);
    process.exit(command || help ? 0 : 1);
  }
  if (command !== "studio") fail(`Unknown command: ${command}`);

  const server = await startStudioServer({
    effect: args.effect,
    assets: args.assets,
    publicDir: args.public,
    port: args.port,
    host: args.host,
  });

  console.log(`particulator studio save server: ${server.url}

  effect  ${path.resolve(args.effect)}
  assets  ${path.resolve(args.assets)}
  public  ${path.resolve(args.public)}

Mount the studio in your app during development:

  if (import.meta.env.DEV)
    import("@particulator/studio").then(({ mountStudio, saveServer }) =>
      mountStudio(stage, { storage: saveServer("${server.url}") }));

Ctrl-C to stop.`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "EADDRINUSE") console.error(`Port already in use. Try --port <n>.`);
  else console.error(err);
  process.exit(1);
});
