import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || "3210");
const indexHtml = readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

const server = createServer((req, res) => {
  if (req.url === "/api/message") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ message: "hello from the backend" }));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log("listening on", port);
});
