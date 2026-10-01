import express from "express";
import { mkdirSync, writeFileSync } from "node:fs";

const DIR = "recordings";
mkdirSync(DIR, { recursive: true });

let counter = 0;
const app = express();

// Raw body only: no JSON parsing, no assumptions about the payload shape.
app.post("/webhook", express.raw({ type: () => true, limit: "50mb" }), (req, res) => {
  const receivedAt = new Date().toISOString();
  const file = `${DIR}/${receivedAt.replace(/[:.]/g, "-")}-${String(++counter).padStart(4, "0")}.json`;
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  writeFileSync(
    file,
    JSON.stringify({ receivedAt, method: req.method, url: req.originalUrl, headers: req.headers, rawBody }, null, 2),
  );
  console.log(`recorded ${file} (${rawBody.length} chars)`);
  res.sendStatus(204);
});

app.listen(3000, "127.0.0.1", () => console.log("receiver listening on http://127.0.0.1:3000/webhook"));
