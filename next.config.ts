import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page reads the session and the database at request time, so the
  // previous (fully dynamic) rendering model is the simplest fit. Cache
  // Components would require a Suspense boundary around every cookie read.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
