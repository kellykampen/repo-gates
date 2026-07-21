import { defineConfig } from "tsup";

export default defineConfig({
  // Library entries (importable) + the CLI dispatcher (executable). The individual
  // src/bin/*.ts scripts are NOT built — the `repo-gates` dispatcher supersedes them.
  entry: {
    index: "src/index.ts",
    config: "src/config.ts",
    "eslint-boundaries": "src/eslint-boundaries.ts",
    "bin/repo-gates": "src/bin/repo-gates.ts",
  },
  format: "esm",
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: false,
});
