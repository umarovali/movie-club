// Local dev server: serves public/ and runs netlify/functions/api.mjs.
// Data is stored as JSON files in .local-data/ (stand-in for Netlify Blobs).
import http from "node:http";
import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

try { process.loadEnvFile(".env"); } catch {}
const PORT = Number(process.env.PORT) || 8888;
const DATA = join(process.cwd(), ".local-data");
await mkdir(DATA, { recursive: true });

const file = (k) => join(DATA, encodeURIComponent(k) + ".json");
globalThis.__devStore = {
  async get(k) { try { return JSON.parse(await readFile(file(k), "utf8")); } catch { return null; } },
  async setJSON(k, v) { await writeFile(file(k), JSON.stringify(v, null, 2)); },
  async delete(k) { await rm(file(k), { force: true }); },
  async list({ prefix = "" } = {}) {
    const keys = (await readdir(DATA)).filter((f) => f.endsWith(".json")).map((f) => decodeURIComponent(f.slice(0, -5)));
    return { blobs: keys.filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
};

const { default: handler } = await import("./netlify/functions/api.mjs");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } else {
      let p = normalize(decodeURIComponent(url.pathname)).replace(/^([\\/])+/, "");
      if (p.includes("..")) throw Object.assign(new Error(), { code: "ENOENT" });
      if (!p || p.endsWith("\\") || p.endsWith("/")) p += "index.html";
      const data = await readFile(join("public", p));
      res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
      res.end(data);
    }
    console.log(req.method, url.pathname, res.statusCode);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(e.code === "ENOENT" ? "Not found" : "Server error");
    if (e.code !== "ENOENT") console.error(e);
  }
})
  .on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(`Порт ${PORT} уже занят — сервер, скорее всего, уже запущен в другом окне.`);
    console.error(`Откройте http://localhost:${PORT} или запустите на другом порту:  PORT=8889 npm run dev`);
    process.exit(1);
  })
  .listen(PORT, () => {
    console.log(`Movie Club dev: http://localhost:${PORT}  (admin: /admin.html)`);
    pollTelegram();
  });

// Telegram can't reach localhost, so locally we pull updates (getUpdates) and pass them
// to the same /api/telegram handler that the webhook uses in production.
async function pollTelegram() {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) return console.log("Telegram: TG_BOT_TOKEN не задан — бот выключен");
  if (!process.env.TG_CHAT_ID) console.log("Telegram: TG_CHAT_ID не задан — запустите  npm run tg:chatid");
  const { createHash } = await import("node:crypto");
  const secret = createHash("sha256").update("tg:" + token).digest("hex").slice(0, 48);
  let offset = 0;
  console.log("Telegram: бот слушает команды (/stats, /last, /open, /close)");
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.timeout(35000) });
      const j = await r.json();
      if (!j.ok) {
        if (j.error_code === 409) return console.log("Telegram: у бота включён webhook (сайт на Netlify) — локальный опрос выключен");
        throw new Error(j.description);
      }
      for (const upd of j.result) {
        offset = upd.update_id + 1;
        await handler(new Request(`http://localhost:${PORT}/api/telegram`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
          body: JSON.stringify(upd),
        }));
      }
    } catch (e) {
      console.error("Telegram:", e.message);
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}
