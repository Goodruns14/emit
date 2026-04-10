import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["emit-cli/**", "test-repos/**", ".claude/**", "node_modules/**"],
  },
});
