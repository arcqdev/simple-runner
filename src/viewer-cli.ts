import process from "node:process";
import { pathToFileURL } from "node:url";

import { runViewerCli } from "./viewer.js";

export { runViewerCli } from "./viewer.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runViewerCli().then((code) => {
    process.exitCode = code;
  });
}
