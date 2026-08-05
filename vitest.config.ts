import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // `eve dev` keeps a source snapshot per build under `.eve/dev-runtime`, each
    // one a full copy of `tests/`. Without this the suite silently re-runs the
    // same tests once per snapshot — against stale code, and reporting a test
    // count that grows with every rebuild.
    exclude: ["node_modules/**", ".eve/**", ".output/**", "evals/**"],
  },
});
