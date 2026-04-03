import { copyFileSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const external = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

const copyQuerySessionHelperPlugin = {
  name: "copy-query-session-helper",
  writeBundle() {
    const distDir = path.resolve("dist");
    mkdirSync(distDir, { recursive: true });
    copyFileSync(
      path.resolve("src/runtime/query-session-helper.mjs"),
      path.join(distDir, "query-session-helper.mjs"),
    );
    copyFileSync(
      path.resolve("src/runner-acp-client.mjs"),
      path.join(distDir, "runner-acp-client.mjs"),
    );
  },
};

export default defineConfig({
  build: {
    minify: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        cli: "src/cli.ts",
        "runner-acp": "src/runner-acp.ts",
        "viewer-cli": "src/viewer-cli.ts",
      },
      external: Array.from(external),
      output: {
        entryFileNames: "[name].js",
        banner: "#!/usr/bin/env node",
      },
    },
    sourcemap: true,
    target: "node20",
  },
  plugins: [copyQuerySessionHelperPlugin],
  test: {
    fileParallelism: false,
  },
});
