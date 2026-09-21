require("dotenv").config();
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
console.log("[boot] starting...");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const { nanoid, customAlphabet } = require("nanoid");
const TelegramBot = require("node-telegram-bot-api");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const jwt = require("jsonwebtoken");

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || ""; // without @, optional
const VERSION = "1.0.0";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in environment variables. Set it in Render → Environment.");
  process.exit(1);
}

// Stateless session signing key. Falls back to a generated value (works, but
// invalidates old sessions on every restart) if not set — set SESSION_SECRET
// in Render → Environment for real persistence across restarts.
const SESSION_SECRET = process.env.SESSION_SECRET || nanoidTempSecret();
function nanoidTempSecret() {
  console.warn("SESSION_SECRET not set — using a random secret for this run only. Set SESSION_SECRET in Render env vars so logins survive restarts.");
  return require("crypto").randomBytes(32).toString("hex");
}

// Plan limits (upload count)
const LIMITS = {
  normal: { max: 3, periodMs: 7 * 24 * 60 * 60 * 1000 },   // 3 / week
  vip:    { max: 10, periodMs: 24 * 60 * 60 * 1000 },      // 10 / day
};

// Plan limits (file size, in MB)
const FILE_LIMITS = { normal: 80, vip: 95 };

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;     // 5 minutes to enter the code
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const PATCH_TOKEN_TTL_MS = 10 * 60 * 1000;  // 10 minutes to actually upload the file
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000;    // kill ffmpeg if it runs longer than this

const TMP_DIR = path.join(os.tmpdir(), "aj-uploads");
fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- In-memory debug log (visible at /debug) ----------
const recentLogs = [];
function pushLog(s) {
  recentLogs.push(s);
  if (recentLogs.length > 100) recentLogs.shift();
}

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

CREATE TABLE IF NOT EXISTS patch_tokens (
  token TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  mode TEXT,
  name TEXT,
  consumed INTEGER DEFAULT 0,
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

function issueSession(telegram_id) {
  return jwt.sign({ tid: String(telegram_id) }, SESSION_SECRET, { expiresIn: Math.floor(SESSION_TTL_MS / 1000) });
}

function requireBearer(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ valid: false, error: "not_authorized" });

  let payload;
  try {
    payload = jwt.verify(token, SESSION_SECRET);
  } catch (e) {
    return res.status(401).json({ valid: false, error: "not_authorized" });
  }

  let user = getUserByTelegramId(payload.tid);
  if (!user) {
    // The underlying row was wiped (e.g. a free-tier restart cleared the DB)
    // but the signed token is still valid — recreate a fresh account instead
    // of forcing the person to reconnect Telegram every time this happens.
    user = upsertUser({ telegram_id: payload.tid, username: null, first_name: null, avatar_url: null });
  }
  req.user = refreshUserPeriod(user);
  req.sessionToken = token;
  next();
}

// ---------- ffmpeg ----------
// mode: "hq"  -> quality re-encode, cap 1080p60
//       "fps" -> faster encode, force 60fps, cap 1080p
//       "4k"  -> VIP only, upscale to 4K60
function buildFfmpegArgs(mode, inputPath, outputPath) {
  const common = ["-y", "-i", inputPath, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  if (mode === "4k") {
    return [
      ...common.slice(0, 2), inputPath,
      "-vf", "scale=3840:-2:flags=lanczos,fps=60",
      "-c:v", "libx264", "-preset", "medium", "-crf", "16",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      outputPath,
    ];
  }
  if (mode === "fps") {
    return [
      "-y", "-i", inputPath,
      "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,fps=60",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      outputPath,
    ];
  }
  // default "hq"
  return [
    "-y", "-i", inputPath,
    "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,fps=60",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    outputPath,
  ];
}

function runFfmpeg(mode, inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArgs(mode, inputPath, outputPath);
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg_timeout"));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => { clearTimeout(killTimer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error("ffmpeg_failed: " + stderr.slice(-800)));
    });
  });
}

function safeUnlink(p) {
  fs.unlink(p, () => {});
}

// ---------- Telegram bot (long polling) ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: false }); // polling starts AFTER the server is listening

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

// Request logging (console + in-memory list shown at /debug)
app.use((req, res, next) => {
  const start = Date.now();
  const authHeader = req.headers.authorization ? "present" : "MISSING";
  res.on("finish", () => {
    const line = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms) auth=${authHeader}`;
    console.log(line);
    pushLog(line);
  });
  next();
});

// Debug page: shows the last 100 log lines. Remove once the issue is solved.
app.get("/debug", (req, res) => res.json({ version: VERSION, logs: recentLogs }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // hard ceiling, per-plan check happens separately
});

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

  const token = issueSession(user.telegram_id);

  // Login poll consumed, remove it.
  db.prepare("DELETE FROM login_polls WHERE poll_token = ?").run(poll_token);

  const fresh = refreshUserPeriod(user);

  res.json({
    status: "authorized",
    session: token,
    profile: toProfile(fresh),
    // Real HD processing is now live.
    features: { patch: true, signature: false, fps60: true },
  });
});

router.post("/session/validate", requireBearer, (req, res) => {
  res.json({
    valid: true,
    profile: toProfile(req.user),
    features: { patch: true, signature: false, fps60: true },
    maintenance: { on: false, hd: false, message: "" },
  });
});

router.post("/session/logout", requireBearer, (req, res) => {
  // Sessions are stateless (signed JWTs) now, so there is nothing to delete
  // server-side — the extension just forgets the token locally.
  res.json({ ok: true });
});

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

// ---- Video processing ----

// Step 1: the extension asks to start an HD upload. We check plan limits and
// file-size limits, then hand back a one-time upload URL/token.
router.post("/patch/allocate", requireBearer, (req, res) => {
  console.log("patch/allocate body:", JSON.stringify(req.body));
  pushLog("patch/allocate body: " + JSON.stringify(req.body));
  const { size, name, mode } = req.body || {};
  const user = req.user;

  if (!size || typeof size !== "number") {
    console.log("patch/allocate rejected: bad size ->", size, typeof size);
    pushLog("patch/allocate rejected: bad size -> " + size + " " + typeof size);
    return res.status(400).json({ ok: false, error: "bad_request" });
  }

  const maxMb = FILE_LIMITS[user.plan] || FILE_LIMITS.normal;
  if (size > maxMb * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: "file_too_large" });
  }

  const info = usageInfo(user);
  if (info.remaining <= 0) {
    return res.status(429).json({ ok: false, error: "limit_reached" });
  }

  // Only VIP users may request 4K upscaling; anything else silently falls
  // back to the normal quality re-encode.
  const safeMode = mode === "4k" && user.plan === "vip" ? "4k" : (mode === "fps" ? "fps" : "hq");

  const token = nanoid(24);
  const createdAt = nowSec();
  db.prepare(
    "INSERT INTO patch_tokens (token, telegram_id, mode, name, consumed, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
  ).run(token, user.telegram_id, safeMode, String(name || "video.mp4"), createdAt, createdAt + Math.floor(PATCH_TOKEN_TTL_MS / 1000));

  // Render terminates TLS at its proxy, so req.protocol says "http".
  // The extension runs on an https page, so an http upload URL gets blocked.
  const host = `https://${req.get("host")}`;
  res.json({
    ok: true,
    payload: {
      upload_token: token,
      upload_url: `${host}/api/ext/patch/upload/${token}`,
    },
  });
});

// Step 2: the extension POSTs the raw video here (multipart form: token + file)
// and gets the re-encoded video back directly in the response body.
router.post("/patch/upload/:token", upload.single("file"), async (req, res) => {
  const { token } = req.params;
  const row = db.prepare("SELECT * FROM patch_tokens WHERE token = ?").get(token);

  const cleanupUpload = () => { if (req.file) safeUnlink(req.file.path); };

  if (!row || row.consumed || row.expires_at < nowSec()) {
    cleanupUpload();
    pushLog("patch/upload: token invalid or expired");
    return res.status(410).json({ ok: false, error: "token_invalid" });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }

  const inputPath = req.file.path;
  const outputPath = path.join(TMP_DIR, `${token}-out.mp4`);

  try {
    await runFfmpeg(row.mode || "hq", inputPath, outputPath);

    // Mark the token used and count this upload against the user's quota
    // only once processing actually succeeded.
    db.prepare("UPDATE patch_tokens SET consumed = 1 WHERE token = ?").run(token);
    db.prepare("UPDATE users SET usage_count = usage_count + 1 WHERE telegram_id = ?").run(row.telegram_id);

    const stat = fs.statSync(outputPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("close", () => { safeUnlink(inputPath); safeUnlink(outputPath); });
    stream.on("error", () => { safeUnlink(inputPath); safeUnlink(outputPath); });
  } catch (err) {
    console.error("ffmpeg error for token", token, err.message);
    pushLog("ffmpeg error: " + err.message);
    safeUnlink(inputPath);
    safeUnlink(outputPath);
    res.status(500).json({ ok: false, error: "processing_failed" });
  }
});

router.post("/patch/log", requireBearer, (req, res) => {
  // The client reports which TikTok account/video it detected after upload.
  // We don't currently store this anywhere; just acknowledge it.
  res.json({ ok: true });
});

// The extension calls this right after allocate. It was returning 404.
// We log what it sends so we can see why, and acknowledge it.
router.post("/tamper", (req, res) => {
  try {
    pushLog("tamper body: " + JSON.stringify(req.body).slice(0, 800));
  } catch (e) {}
  res.json({ ok: true });
});

app.use("/api/ext", router);

app.get("/", (req, res) => res.send("AJ Uploader+ backend is running."));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AJ Uploader+ server listening on :${PORT}`);
  bot.startPolling().then(() => console.log("[boot] telegram polling started"))
    .catch((e) => console.error("[boot] telegram polling failed:", e.message));
});
