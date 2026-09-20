require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_aj_2026';

// إعدادات Middleware
app.use(cors());
app.use(express.json());

// إنشاء مجلد للملفات المؤقتة إذا لم يكن موجوداً
const tempDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// إعداد Multer لاستقبال مقاطع الفيديو
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ 
    storage,
    limits: { fileSize: 95 * 1024 * 1024 } // الحد الأقصى 95 ميجابايت (لباقة VIP)
});

// ---------------------------------------------------------
// 1. تهيئة قاعدة البيانات (SQLite) بنمط WAL المحسن
// ---------------------------------------------------------
const db = new Database('aj_uploader.db');
db.pragma('journal_mode = WAL'); // تسريع الكتابة ومنع قفل القاعدة

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        tier TEXT DEFAULT 'normal', -- 'normal' or 'vip'
        credits INTEGER DEFAULT 3,
        last_reset DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS patch_tokens (
        token TEXT PRIMARY KEY,
        telegram_id TEXT,
        expires_at DATETIME
    );
`);

// ---------------------------------------------------------
// 2. إعداد بوت تيليجرام (اختياري للتشغيل المبدئي، ضع التوكن في .env)
// ---------------------------------------------------------
const botToken = process.env.TELEGRAM_BOT_TOKEN;
let bot = null;
if (botToken) {
    bot = new TelegramBot(botToken, { polling: true });
    
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, "أهلاً بك في AJ's Uploader+. أرسل كود المصادقة لتسجيل الدخول.");
        // هنا يمكنك إضافة منطق استقبال كود الـ 6 أرقام وربط الحساب
    });
}

// ---------------------------------------------------------
// 3. ميدل وير للتحقق من جلسة المستخدم (JWT)
// ---------------------------------------------------------
const authenticateUser = (req, res, next) => {
    const token = req.header('Authorization')?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'غير مصرح لك - يرجى تسجيل الدخول' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // يحتوي على telegram_id و tier
        next();
    } catch (err) {
        res.status(403).json({ error: 'الجلسة منتهية أو غير صالحة' });
    }
};

// ---------------------------------------------------------
// 4. مسار طلب تصريح الرفع (Allocate)
// ---------------------------------------------------------
app.post('/patch/allocate', authenticateUser, (req, res) => {
    const { fileSize } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(req.user.telegram_id);
    
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (user.credits <= 0) return res.status(403).json({ error: 'لقد استنفدت رصيدك' });

    // التحقق من الحجم حسب الباقة
    const maxMB = user.tier === 'vip' ? 95 : 80;
    if (fileSize > maxMB * 1024 * 1024) {
        return res.status(400).json({ error: `حجم الملف يتجاوز الحد المسموح لباقة ${user.tier} (${maxMB}MB)` });
    }

    // توليد توكن مؤقت صالح لـ 10 دقائق
    const uploadToken = uuidv4();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    db.prepare('INSERT INTO patch_tokens (token, telegram_id, expires_at) VALUES (?, ?, ?)')
      .run(uploadToken, user.telegram_id, expiresAt);

    res.json({ success: true, uploadToken, uploadUrl: '/patch/upload' });
});

// ---------------------------------------------------------
// 5. مسار رفع ومعالجة الفيديو (Upload & Process)
// ---------------------------------------------------------
app.post('/patch/upload', upload.single('video'), (req, res) => {
    const uploadToken = req.body.token;
    const mode = req.body.mode || 'hq'; // 'hq', 'fps', or '4k'

    if (!req.file) return res.status(400).json({ error: 'لم يتم إرفاق ملف' });

    // التحقق من صحة توكن الرفع
    const tokenRecord = db.prepare('SELECT * FROM patch_tokens WHERE token = ? AND expires_at > CURRENT_TIMESTAMP').get(uploadToken);
    
    if (!tokenRecord) {
        fs.unlinkSync(req.file.path); // تنظيف الملف المرفوض فوراً
        return res.status(403).json({ error: 'تصريح الرفع غير صالح أو منتهي' });
    }

    const user = db.prepare('SELECT tier FROM users WHERE telegram_id = ?').get(tokenRecord.telegram_id);
    if (mode === '4k' && user.tier !== 'vip') {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'ميزة 4K حصرية لمشتركي VIP' });
    }

    // إعداد مسار ملف المخرجات
    const outputPath = path.join(tempDir, `processed-${Date.now()}.mp4`);
    
    // بناء إعدادات FFmpeg بناءً على النمط
    let command = ffmpeg(req.file.path);
    
    if (mode === 'fps') {
        command = command.fps(60);
    } else if (mode === '4k') {
        // Upscale using Lanczos algorithm
        command = command.videoFilter('scale=3840:2160:flags=lanczos').fps(60);
    } else {
        // 'hq' default
        command = command.videoBitrate('2000k').size('?x1080'); // Max 1080p
    }

    // بدء المعالجة
    command.output(outputPath)
        .on('end', () => {
            // خصم رصيد من المستخدم
            db.prepare('UPDATE users SET credits = credits - 1 WHERE telegram_id = ?').run(tokenRecord.telegram_id);
            // حذف توكن الرفع لكي لا يستخدم مرة أخرى
            db.prepare('DELETE FROM patch_tokens WHERE token = ?').run(uploadToken);
            
            // إرسال الملف الجاهز للمستخدم
            res.download(outputPath, 'AJ_Processed_Video.mp4', (err) => {
                // خطوة هامة جداً: حذف الملفات لكي لا يمتلئ السيرفر
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            });
        })
        .on('error', (err) => {
            console.error('FFmpeg Error:', err);
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).json({ error: 'حدث خطأ أثناء معالجة الفيديو' });
        })
        .run();
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`🚀 AJ's Uploader+ Backend is running on port ${PORT}`);
});
