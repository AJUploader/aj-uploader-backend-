require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const { nanoid, customAlphabet } = require("nanoid");
const TelegramBot = require("node-telegram-bot-api");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || ""; // without @, optional
const VERSION = "1.0.0";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in environment variables. Set it in Render → Environment.");
  process.exit(1);
}

// Plan limits
const LIMITS = {
  normal: { max: 3, periodMs: 7 * 24 * 60 * 60 * 1000 },   // 3 / week
  vip:    { max: 10, periodMs: 24 * 60 * 60 * 1000 },      // 10 / day
};

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;     // 5 minutes to enter the code
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ---------- DB ----------
const db = new Database("aj.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  avatar_url TEXT,
  plan TEXT DEFAULT 'normal',
  vip_expires_at INTEGER,
  channel_member INTEGER DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  usage_period_start INTEGER,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS login_polls (
  poll_token TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  telegram_id TEXT,
  username TEXT,
  first_name TEXT,
  avatar_url TEXT,
  created_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  created_at INTEGER,
  expires_at INTEGER
);
`);

const now = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);
const genCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6); // no confusing chars

// ---------- Helpers ----------
function getUserByTelegramId(telegram_id) {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(telegram_id));
}

function upsertUser({ telegram_id, username, first_name, avatar_url }) {
  const existing = getUserByTelegramId(telegram_id);
  if (existing) {
    db.prepare(
      "UPDATE users SET username=?, first_name=?, avatar_url=? WHERE telegram_id=?"
    ).run(username || existing.username, first_name || existing.first_name, avatar_url || existing.avatar_url, String(telegram_id));
    return getUserByTelegramId(telegram_id);
  }
  db.prepare(
    `INSERT INTO users (telegram_id, username, first_name, avatar_url, plan, usage_count, usage_period_start, created_at)
     VALUES (?, ?, ?, ?, 'normal', 0, ?, ?)`
  ).run(String(telegram_id), username || null, first_name || null, avatar_url || null, nowSec(), nowSec());
  return getUserByTelegramId(telegram_id);
}

// Resets the usage counter if the current period has expired. Also demotes
// an expired VIP back to normal automatically.
function refreshUserPeriod(user) {
  const isVip = user.plan === "vip" && user.vip_expires_at && user.vip_expires_at > nowSec();
  const plan = isVip ? "vip" : "normal";
  const limit = LIMITS[plan];
  const periodStartMs = (user.usage_period_start || 0) * 1000;
  const expired = now() - periodStartMs > limit.periodMs;

  if (plan !== user.plan || expired) {
    const newPeriodStart = expired ? nowSec() : user.usage_period_start;
    const newCount = expired ? 0 : user.usage_count;
    db.prepare("UPDATE users SET plan=?, usage_count=?, usage_period_start=? WHERE telegram_id=?")
      .run(plan, newCount, newPeriodStart, user.telegram_id);
    return getUserByTelegramId(user.telegram_id);
  }
  return user;
}

function usageInfo(user) {
  const limit = LIMITS[user.plan];
  const periodStartMs = (user.usage_period_start || nowSec()) * 1000;
  const resetsAt = periodStartMs + limit.periodMs;
  const remaining = Math.max(0, limit.max - user.usage_count);
  return {
    plan: user.plan,
    limit: limit.max,
    used: user.usage_count,
    remaining,
    resets_in: Math.max(0, Math.floor((resetsAt - now()) / 1000)),
  };
}

function toProfile(user) {
  const isVip = user.plan === "vip";
  return {
    name: user.first_name || "creator",
    username: user.username || null,
    avatar_url: user.avatar_url || null,
    telegram_id: user.telegram_id,
    premium: isVip,
    plan: isVip ? "premium" : "free", // kept for compatibility with existing popup.js wording
    plan_label: isVip ? "VIP" : "Normal",
    channel_member: !!user.channel_member,
    premium_expires: isVip ? user.vip_expires_at : null,
    days_left: isVip && user.vip_expires_at ? Math.max(0, Math.ceil((user.vip_expires_at - nowSec()) / 86400)) : null,
    usage: usageInfo(user),
  };
}

function requireBearer(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ valid: false, error: "missing_token" });
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!row || row.expires_at < nowSec()) return res.status(401).json({ valid: false, error: "invalid_token" });
  const user = getUserByTelegramId(row.telegram_id);
  if (!user) return res.status(401).json({ valid: false, error: "user_not_found" });
  req.user = refreshUserPeriod(user);
  req.sessionToken = token;
  next();
}

// ---------- Telegram bot (long polling) ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => console.error("polling_error:", err.message));

bot.onText(/\/start(.*)/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 Welcome to AJ Uploader+.\n\nTo connect your account, open the extension, tap *Connect Telegram*, then send me the 6-character code shown there.",
    { parse_mode: "Markdown" }
  );
});

// Any plain text message is treated as an attempted login code.
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const code = msg.text.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return;

  const poll = db.prepare(
    "SELECT * FROM login_polls WHERE code = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(code);

  if (!poll || poll.expires_at < nowSec()) {
    bot.sendMessage(msg.chat.id, "❌ That code is invalid or expired. Generate a new one from the extension and try again.");
    return;
  }

  let avatar_url = null;
  try {
    const photos = await bot.getUserProfilePhotos(msg.from.id, { limit: 1 });
    if (photos && photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      const file = await bot.getFile(fileId);
      avatar_url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    }
  } catch (e) {
    // avatar is optional, ignore failures
  }

  db.prepare(
    "UPDATE login_polls SET status='authorized', telegram_id=?, username=?, first_name=?, avatar_url=? WHERE poll_token=?"
  ).run(String(msg.from.id), msg.from.username || null, msg.from.first_name || null, avatar_url, poll.poll_token);

  bot.sendMessage(msg.chat.id, "✅ Connected! Go back to the AJ Uploader+ popup — you're signed in. 🎉");
});

// ---------- Express app ----------
const app = express();
app.use(cors());
app.use(express.json());

const router = express.Router();

router.get("/config", (req, res) => {
  res.json({
    channel_url: CHANNEL_USERNAME ? `https://t.me/${CHANNEL_USERNAME}` : undefined,
    channel_handle: CHANNEL_USERNAME ? `@${CHANNEL_USERNAME}` : undefined,
    bot: undefined, // extension already hardcodes its bot username
    version: VERSION,
    maintenance: { on: false, hd: false, message: "" },
  });
});

router.post("/auth/start", (req, res) => {
  const poll_token = nanoid(21);
  const code = genCode();
  const createdAt = nowSec();
  const expiresAt = createdAt + Math.floor(AUTH_CODE_TTL_MS / 1000);

  db.prepare(
    "INSERT INTO login_polls (poll_token, code, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)"
  ).run(poll_token, code, createdAt, expiresAt);

  res.json({ poll_token, code, ttl_ms: AUTH_CODE_TTL_MS });
});

router.post("/auth/check", (req, res) => {
  const { poll_token } = req.body || {};
  if (!poll_token) return res.status(400).json({ status: "invalid" });

  const poll = db.prepare("SELECT * FROM login_polls WHERE poll_token = ?").get(poll_token);
  if (!poll) return res.status(404).json({ status: "not_found" });

  if (poll.expires_at < nowSec() && poll.status === "pending") {
    return res.status(410).json({ status: "expired" });
  }

  if (poll.status !== "authorized") {
    return res.json({ status: "pending" });
  }

  const user = upsertUser({
    telegram_id: poll.telegram_id,
    username: poll.username,
    first_name: poll.first_name,
    avatar_url: poll.avatar_url,
  });

  const token = nanoid(32);
  const createdAt = nowSec();
  db.prepare(
    "INSERT INTO sessions (token, telegram_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, user.telegram_id, createdAt, createdAt + Math.floor(SESSION_TTL_MS / 1000));

  // Login poll consumed, remove it.
  db.prepare("DELETE FROM login_polls WHERE poll_token = ?").run(poll_token);

  const fresh = refreshUserPeriod(user);

  res.json({
    status: "authorized",
    session: token,
    profile: toProfile(fresh),
    // "patch" (the server-side quality-boost pipeline) is intentionally off —
    // that feature isn't implemented on this server.
    features: { patch: false, signature: false, fps60: false },
  });
});

router.post("/session/validate", requireBearer, (req, res) => {
  res.json({
    valid: true,
    profile: toProfile(req.user),
    features: { patch: false, signature: false, fps60: false },
    maintenance: { on: false, hd: false, message: "" },
  });
});

router.post("/session/logout", requireBearer, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.sessionToken);
  res.json({ ok: true });
});

// Usage endpoints (for a future in-popup "consume" action, e.g. once you wire
// up your own quality-processing pipeline). Safe to call any time to read
// or increment the current plan's counter.
router.get("/usage/status", requireBearer, (req, res) => {
  res.json({ ok: true, usage: usageInfo(req.user) });
});

router.post("/usage/consume", requireBearer, (req, res) => {
  const info = usageInfo(req.user);
  if (info.remaining <= 0) {
    return res.status(429).json({ ok: false, error: "limit_reached", usage: info });
  }
  db.prepare("UPDATE users SET usage_count = usage_count + 1 WHERE telegram_id = ?").run(req.user.telegram_id);
  const fresh = refreshUserPeriod(getUserByTelegramId(req.user.telegram_id));
  res.json({ ok: true, usage: usageInfo(fresh) });
});

app.use("/api/ext", router);

app.get("/", (req, res) => res.send("AJ Uploader+ backend is running."));

app.listen(PORT, () => console.log(`AJ Uploader+ server listening on :${PORT}`));
