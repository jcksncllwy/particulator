import path from "node:path";
import type { NextConfig } from "next";

// Static export so the site can be hosted from any static file host.
// NEXT_PUBLIC_BASE_PATH lets it live under a sub-path (e.g. "/for-chris").
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  // The particulator packages are workspace TypeScript sources.
  transpilePackages: ["particulator", "@particulator/dotter"],
  turbopack: { root: path.resolve(process.cwd(), "../../..") },
};

export default nextConfig;
