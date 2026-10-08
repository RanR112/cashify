import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const rootDir = path.resolve(import.meta.dirname, "..");
const spikeDir = path.join(rootDir, "spike");

dotenv.config({
    path: path.join(rootDir, ".env"),
});

const { OPENWA_API_KEY, OPENWA_SESSION_ID, WEBHOOK_SECRET } = process.env;

if (!OPENWA_API_KEY || !OPENWA_SESSION_ID || !WEBHOOK_SECRET) {
    console.error("Missing required environment variables:");
    console.error("OPENWA_API_KEY");
    console.error("OPENWA_SESSION_ID");
    console.error("WEBHOOK_SECRET");

    process.exit(1);
}

const args = [
    "-r",
    "./src/ua-preload.cjs",
    "node_modules/@open-wa/wa-automate/bin/server.js",
    "-p",
    "8002",
    "-k",
    OPENWA_API_KEY,
    "--session-id",
    OPENWA_SESSION_ID,
    "-w",
    `http://localhost:3000/webhooks/openwa/${WEBHOOK_SECRET}`,
    "--use-chrome",
];

const child = spawn("node", args, {
    cwd: spikeDir,
    stdio: "inherit",
});

child.on("exit", (code) => {
    process.exit(code ?? 0);
});
