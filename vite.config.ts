import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

export default defineConfig({
  build: {
    minify: false,
    outDir: "dist",
    rollupOptions: {
      input: {
        cli: "src/cli.ts",
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
});
