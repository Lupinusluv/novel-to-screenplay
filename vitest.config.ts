import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // react(): JSX/TSX transform for component tests.
  plugins: [react()],
  // Native tsconfig `@/*` path resolution (E7) — supersedes the
  // vite-tsconfig-paths plugin, which Vite now warns is redundant.
  resolve: { tsconfigPaths: true },
  test: {
    // Default node for pure-logic unit tests; component test files opt into
    // jsdom via a `// @vitest-environment jsdom` docblock (E9).
    environment: "node",
    include: [
      "lib/**/*.test.ts",
      "tests/**/*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
    ],
    setupFiles: ["./vitest.setup.ts"],
  },
});
