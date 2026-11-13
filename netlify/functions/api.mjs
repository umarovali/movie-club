import { getStore } from "@netlify/blobs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

// ---------- helpers ----------
// globalThis.__devStore is set only by dev-server.mjs for local testing
const store = () => globalThis.__devStore ?? getStore({ name: "movieclub", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (error, status = 400) => json({ error }, status);

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const nameKey = (fullName) => hash(fullName.toLowerCase()).slice(0, 32);
const nowIso = () => new Date().toISOString();
const TZ = () => process.env.TZ_NAME || "Asia/Tashkent";
const fmtTime = (iso) => new Date(iso).toLocaleString("ru-RU", { timeZone: TZ(), day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const newPoll = (title) => ({
  id: Date.now().toString(36),
  title: title || "Movie Club",
  createdAt: nowIso(),
  startsAt: nowIso(), // null = без ограничения
  endsAt: null,
});

/** "scheduled" | "open" | "ended" — depends only on startsAt / endsAt */
function pollStatus(p, now = Date.now()) {
  if (p.startsAt && now < Date.parse(p.startsAt)) return "scheduled";
  if (p.endsAt && now >= Date.parse(p.endsAt)) return "ended";
  return "open";
}

const weight = (v) => v.weight || 1;
const voterName = (v) => v.name || `${v.firstName} ${v.lastName}`.trim();

async function getState(s) {
  const st = await s.get("state", { type: "json" });
  if (!st) {
    const fresh = { poll: newPoll(), movies: [], history: [] };
    await s.setJSON("state", fresh);
    return fresh;
  }
  // migrate old open/closed flag to the schedule model
  if ("open" in st.poll) {
    if (!("startsAt" in st.poll)) st.poll.startsAt = st.poll.createdAt;
    if (st.poll.open === false && !st.poll.endsAt) st.poll.endsAt = nowIso();
    delete st.poll.open;
    await s.setJSON("state", st);
  }
  return st;
}

function isAdmin(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  const got = req.headers.get("x-admin-password") || "";
  return timingSafeEqual(Buffer.from(hash(got)), Buffer.from(hash(pw)));
}

async function listVotes(s, pollId) {
  const { blobs } = await s.list({ prefix: `votes/${pollId}/` });
  const votes = await Promise.all(
    blobs.map(async (b) => {
      const v = await s.get(b.key, { type: "json" });
      return v && { source: "student", weight: 1, ...v, name: voterName(v), key: b.key };
    })
  );
  return votes.filter(Boolean).sort((a, b) => a.ts.localeCompare(b.ts));
}

function parseDate(v, label) {
  if (v === null || v === "") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new UserError(`Неверная дата: ${label}`);
  return new Date(t).toISOString();
}
class UserError extends Error {}

function startNow(poll) {
  poll.startsAt = nowIso();
  if (poll.endsAt && Date.parse(poll.endsAt) <= Date.now()) poll.endsAt = null;
}
function stopNow(poll) {
  poll.endsAt = nowIso();
  if (poll.startsAt && Date.parse(poll.startsAt) > Date.now()) poll.startsAt = poll.endsAt;
}

// ---------- telegram ----------
const tgSecret = () => hash("tg:" + process.env.TG_BOT_TOKEN).slice(0, 48);

async function tg(method, payload) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
    return await r.json();
  } catch (e) {
    console.error("telegram", e);
    return null;
  }
}

const tgSend = (text, chatId = process.env.TG_CHAT_ID) =>
  chatId ? tg("sendMessage", { chat_id: chatId, text }) : null;

const STATUS_RU = { open: "идёт", scheduled: "ещё не началось", ended: "завершено" };

function statsText(state, votes) {
  const counts = new Map();
  for (const v of votes) counts.set(v.movieId, (counts.get(v.movieId) || 0) + weight(v));
  const total = votes.reduce((n, v) => n + weight(v), 0);
  const adminTotal = votes.filter((v) => v.source === "admin").reduce((n, v) => n + weight(v), 0);
  const lines = state.movies
    .map((m) => ({ m, n: counts.get(m.id) || 0 }))
    .sort((a, b) => b.n - a.n)
    .map(({ m, n }, i) => `${i + 1}. ${m.title} — ${n}`);
  const p = state.poll;
  return [
    `🎬 ${p.title} (${STATUS_RU[pollStatus(p)]})`,
    p.startsAt || p.endsAt ? `🕒 ${p.startsAt ? fmtTime(p.startsAt) : "…"} — ${p.endsAt ? fmtTime(p.endsAt) : "без окончания"}` : null,
    `Всего голосов: ${total}${adminTotal ? ` (из них от админа: ${adminTotal})` : ""}`,
    "",
    ...(lines.length ? lines : ["Фильмов пока нет"]),
  ].filter((l) => l !== null).join("\n");
}

async function telegramWebhook(req, s) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== tgSecret()) return fail("forbidden", 403);
  const upd = await req.json().catch(() => ({}));
  const msg = upd.message;
  if (!msg?.text || String(msg.chat.id) !== String(process.env.TG_CHAT_ID)) return json({ ok: true });

  const cmd = msg.text.split(/[\s@]/)[0].toLowerCase();
  const state = await getState(s);
  const reply = (t) => tgSend(t, msg.chat.id);

  if (cmd === "/stats") {
    await reply(statsText(state, await listVotes(s, state.poll.id)));
  } else if (cmd === "/last") {
    const votes = (await listVotes(s, state.poll.id)).slice(-10).reverse();
    await reply(
      votes.length
        ? votes
            .map((v) => {
              const tag = v.source === "admin" ? ` [админ ×${weight(v)}]` : "";
              return `• ${v.name}${tag} → ${v.movieTitle} (${fmtTime(v.ts)})${v.reason ? `\n  «${v.reason}»` : ""}`;
            })
            .join("\n")
        : "Голосов пока нет"
    );
  } else if (cmd === "/open" || cmd === "/close") {
    cmd === "/open" ? startNow(state.poll) : stopNow(state.poll);
    await s.setJSON("state", state);
    await reply(cmd === "/open" ? "✅ Голосование начато" : "⛔ Голосование остановлено");
  } else {
    await reply("Команды:\n/stats — итоги\n/last — последние 10 голосов\n/open — начать голосование сейчас\n/close — остановить сейчас");
  }
  return json({ ok: true });
}

// ---------- handler ----------
export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method;
  const s = store();

  try {
    // ---- public ----
    if (route === "poll" && method === "GET") {
      const { poll, movies } = await getState(s);
      return json({ poll: { ...poll, status: pollStatus(poll) }, movies, serverTime: nowIso() });
    }

    if (route === "vote" && method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return fail("Некорректный запрос");
      const state = await getState(s);
      const status = pollStatus(state.poll);
      if (status === "scheduled") return fail(`Голосование начнётся ${fmtTime(state.poll.startsAt)}`, 403);
      if (status === "ended") return fail("Голосование завершено", 403);

      const firstName = clean(body.firstName, 40);
      const lastName = clean(body.lastName, 40);
      if (firstName.length < 2 || lastName.length < 2) return fail("Укажите имя и фамилию");
      const movie = state.movies.find((m) => m.id === body.movieId);
      if (!movie) return fail("Выберите фильм из списка");
      const reason = clean(body.reason, 500);

      const fullName = `${firstName} ${lastName}`;
      const key = `votes/${state.poll.id}/${nameKey(fullName)}`;
      const existing = await s.get(key, { type: "json" });
      if (existing) return fail(`${fullName}, вы уже проголосовали за «${existing.movieTitle}»`, 409);

      await s.setJSON(key, {
        id: randomUUID(),
        pollId: state.poll.id,
        source: "student",
        weight: 1,
        movieId: movie.id,
        movieTitle: movie.title,
        firstName,
        lastName,
        name: fullName,
        reason,
        ts: nowIso(),
      });
      await tgSend(`🗳 ${fullName} → ${movie.title}${reason ? `\n«${reason}»` : ""}`);
      return json({ ok: true, movieTitle: movie.title });
    }

    if (route === "telegram" && method === "POST") return telegramWebhook(req, s);

    // ---- admin ----
    if (route.startsWith("admin/")) {
      if (!process.env.ADMIN_PASSWORD) return fail("На сервере не задан ADMIN_PASSWORD", 500);
      if (!isAdmin(req)) return fail("Неверный пароль", 401);
      const action = route.slice("admin/".length);
      const state = await getState(s);
      const body = method === "GET" || method === "DELETE" ? {} : await req.json().catch(() => ({}));
      const save = () => s.setJSON("state", state);

      if (action === "data" && method === "GET") {
        const pollId = url.searchParams.get("poll") || state.poll.id;
        let poll = state.poll, movies = state.movies;
        if (pollId !== state.poll.id) {
          const arch = await s.get(`archive/${pollId}`, { type: "json" });
          if (!arch) return fail("Голосование не найдено", 404);
          ({ poll, movies } = arch);
        }
        return json({
          current: state.poll.id,
          poll: { ...poll, status: pollStatus(poll) },
          movies,
          history: state.history,
          votes: await listVotes(s, pollId),
          serverTime: nowIso(),
          telegram: Boolean(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID),
        });
      }

      if (action === "movie" && method === "POST") {
        const title = clean(body.title, 120);
        if (!title) return fail("Нужно название фильма");
        state.movies.push({
          id: randomUUID().slice(0, 8),
          title,
          year: clean(body.year, 4),
          poster: /^https?:\/\//.test(body.poster || "") ? clean(body.poster, 500) : "",
          description: clean(body.description, 400),
        });
        await save();
        return json({ ok: true });
      }

      if (action === "movie" && method === "DELETE") {
        state.movies = state.movies.filter((m) => m.id !== url.searchParams.get("id"));
        await save();
        return json({ ok: true });
      }

      // title and/or schedule. startsAt / endsAt: ISO string, or null to remove the limit
      if (action === "poll" && method === "PUT") {
        const p = state.poll;
        if (typeof body.title === "string" && clean(body.title, 120)) p.title = clean(body.title, 120);
        const next = { ...p };
        if ("startsAt" in body) next.startsAt = parseDate(body.startsAt, "начало");
        if ("endsAt" in body) next.endsAt = parseDate(body.endsAt, "окончание");
        if (next.startsAt && next.endsAt && Date.parse(next.endsAt) <= Date.parse(next.startsAt))
          return fail("Окончание должно быть позже начала");
        Object.assign(p, next);
        await save();
        return json({ ok: true });
      }

      if (action === "poll/start" && method === "POST") {
        startNow(state.poll);
        await save();
        return json({ ok: true });
      }

      if (action === "poll/stop" && method === "POST") {
        stopNow(state.poll);
        await save();
        return json({ ok: true });
      }

      // votes added by the admin: any name, any count, marked source="admin"
      if (action === "manual-vote" && method === "POST") {
        const movie = state.movies.find((m) => m.id === body.movieId);
        if (!movie) return fail("Выберите фильм");
        const name = clean(body.name, 80) || "Админ";
        const count = Math.floor(Number(body.count));
        if (!(count >= 1 && count <= 1000)) return fail("Количество голосов: от 1 до 1000");
        const id = randomUUID();
        await s.setJSON(`votes/${state.poll.id}/admin-${id}`, {
          id,
          pollId: state.poll.id,
          source: "admin",
          weight: count,
          movieId: movie.id,
          movieTitle: movie.title,
          name,
          firstName: name,
          lastName: "",
          reason: clean(body.note, 500),
          ts: nowIso(),
        });
        return json({ ok: true });
      }

      if (action === "new-poll" && method === "POST") {
        const old = { ...state.poll };
        if (pollStatus(old) !== "ended") old.endsAt = nowIso();
        await s.setJSON(`archive/${old.id}`, { poll: old, movies: state.movies });
        state.history = [{ id: old.id, title: old.title, createdAt: old.createdAt }, ...(state.history || [])];
        state.poll = newPoll(clean(body.title, 120));
        if (!body.keepMovies) state.movies = [];
        await save();
        return json({ ok: true });
      }

      if (action === "vote" && method === "DELETE") {
        const key = url.searchParams.get("key") || "";
        if (!key.startsWith("votes/")) return fail("Некорректный ключ");
        await s.delete(key);
        return json({ ok: true });
      }

      if (action === "telegram-setup" && method === "POST") {
        if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHAT_ID) return fail("Не заданы TG_BOT_TOKEN / TG_CHAT_ID");
        const r = await tg("setWebhook", {
          url: `${url.origin}/api/telegram`,
          secret_token: tgSecret(),
          allowed_updates: ["message"],
        });
        if (!r?.ok) return fail("Telegram: " + (r?.description || "нет ответа"), 502);
        await tg("setMyCommands", {
          commands: [
            { command: "stats", description: "Итоги голосования" },
            { command: "last", description: "Последние 10 голосов" },
            { command: "open", description: "Начать голосование сейчас" },
            { command: "close", description: "Остановить голосование" },
          ],
        });
        await tgSend("✅ Бот подключён к Movie Club. Напишите /stats");
        return json({ ok: true });
      }
    }

    return fail("Not found", 404);
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    console.error(e);
    return fail("Ошибка сервера", 500);
  }
};

export const config = { path: "/api/*" };
