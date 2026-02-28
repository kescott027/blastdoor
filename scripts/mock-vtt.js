#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";

const host = process.env.MOCK_VTT_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.MOCK_VTT_PORT || "33100", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MOCK_VTT_PORT must be a valid TCP port.");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const server = http.createServer((req, res) => {
  if ((req.headers.accept || "").includes("application/json")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mock: "foundry-vtt", path: req.url }));
    return;
  }

  const safeUrl = escapeHtml(req.url || "/");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mock Foundry VTT</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(150deg, #101c38, #223f68 55%, #2f6a8c);
        color: #ecf4ff;
        font-family: "Trebuchet MS", sans-serif;
      }
      main {
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(236, 244, 255, 0.25);
        border-radius: 12px;
        padding: 24px 28px;
      }
      code {
        color: #9be7ff;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Mock Foundry VTT</h1>
      <p>Gateway proxy reached <code>${safeUrl}</code></p>
    </main>
  </body>
</html>`);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.end();
});

server.listen(port, host, () => {
  console.log(`Mock Foundry VTT listening on http://${host}:${port}`);
});
