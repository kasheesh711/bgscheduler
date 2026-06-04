import { defineConfig } from "vitest/config";
import path from "path";

process.env.TZ = "Asia/Bangkok";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/tests/**",
        "src/app/**/*.tsx",
      ],
      reporter: ["text", "html"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          globals: true,
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: ["src/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          globals: true,
          include: ["src/**/*.integration.test.ts"],
          pool: "forks",
          // Vitest 4 removed poolOptions; this is the singleFork: true equivalent.
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
