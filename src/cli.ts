import process from "node:process";
import { pathToFileURL } from "node:url";

import { runCli } from "./cli/main.js";

export { runCli } from "./cli/main.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
