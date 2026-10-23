import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page reads the session and the database at request time, so the
  // previous (fully dynamic) rendering model is the simplest fit. Cache
  // Components would require a Suspense boundary around every cookie read.
  cacheComponents: false,
  experimental: {
    serverActions: {
      // The .eml upload on /requests/new posts the file through a server action.
      // The default cap is 1MB. The user-facing limit is the 10 MB file check
      // in the action (MAX_EML_BYTES in requests/new/actions.ts); this is the
      // hard ceiling above it. Next counts the multipart boundaries, part
      // headers, and action id in the raw body, so the two must not be equal
      // or a 10 MB file gets a 413 instead of the action's message.
      bodySizeLimit: "11mb",
    },
  },
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
