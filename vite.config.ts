import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const external = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);

export default defineConfig({
  build: {
    lib: {
      entry: "src/cli.ts",
      formats: ["es"],
      fileName: () => "cli.js",
    },
    minify: false,
    outDir: "dist",
    rollupOptions: {
      external: Array.from(external),
      output: {
        banner: "#!/usr/bin/env node",
      },
    },
    sourcemap: true,
    target: "node20",
  },
});
