// Usage: npm run reply -- <chatId> "<text>"   e.g. 628123456789@c.us "halo"
const [to, ...rest] = process.argv.slice(2);
const content = rest.join(" ");

if (!to || !content) {
  console.error('usage: npm run reply -- <chatId> "<text>"');
  process.exit(1);
}

const base = process.env.EASY_API_URL ?? "http://localhost:8002";
const res = await fetch(`${base}/sendText`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ args: { to, content } }),
});
console.log(res.status, await res.text());
