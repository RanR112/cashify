// Preloaded with `node -r` before OpenWA starts.
// OpenWA 4.76.0 hardcodes a Chrome/104 user agent, which makes WhatsApp Web show
// "update Chrome" and never expose window.Debug (initializer times out after 30s).
// The CLI flag --custom-user-agent is ignored outside Docker, so overwrite the
// constant that browser.js reads at call time.
const path = require("node:path");

const configPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@open-wa",
  "wa-automate",
  "dist",
  "config",
  "puppeteer.config.js",
);

const config = require(configPath);
config.useragent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
