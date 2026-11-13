// Prints the chat id of whoever last wrote to the bot, and saves it to .env as TG_CHAT_ID.
import { readFile, writeFile } from "node:fs/promises";

try { process.loadEnvFile(".env"); } catch {}
const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.log("Сначала добавьте в .env строку  TG_BOT_TOKEN=<токен от @BotFather>");
  process.exit(1);
}

const j = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
if (!j.ok) {
  console.log("Telegram ответил ошибкой:", j.description);
  process.exit(1);
}
const msg = j.result.map((u) => u.message).filter(Boolean).at(-1);
if (!msg) {
  console.log("Сообщений нет. Откройте своего бота в Telegram, нажмите Start (или напишите /start) и запустите команду ещё раз.");
  process.exit(1);
}

const id = String(msg.chat.id);
const who = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.username || "";
let env = await readFile(".env", "utf8");
env = /^TG_CHAT_ID=.*$/m.test(env) ? env.replace(/^TG_CHAT_ID=.*$/m, `TG_CHAT_ID=${id}`) : env.replace(/\n?$/, `\nTG_CHAT_ID=${id}\n`);
await writeFile(".env", env);
console.log(`Готово: TG_CHAT_ID=${id} (${who}) записан в .env. Перезапустите  npm run dev`);
