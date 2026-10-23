// ESM config (.mts) because package.json has no "type": "module": a .ts config
// would be loaded as CommonJS and Vite warns that its native loader will not
// support that. import.meta.url replaces __dirname, which does not exist in ESM.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    globals: false,
  },
});
