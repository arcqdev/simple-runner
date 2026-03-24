import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = new URL(".", import.meta.url);
const distDir = new URL("./dist/", root);
const publicDir = new URL("./dist/public/", root);

mkdirSync(distDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });
cpSync(new URL("./src/server.mjs", root), new URL("./dist/server.mjs", root));
cpSync(new URL("./src/index.html", root), new URL("./dist/public/index.html", root));

console.log(path.resolve(new URL("./dist", root).pathname));
