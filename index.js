require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SESSION_SECRET || 'aj-uploader-fallback-secret';

app.use(cors());
app.use(express.json());

// إعداد قاعدة البيانات بشكل مبسط
const db = new sqlite3.Database('./aj.db', (err) => {
  if (err) console.error('Database opening error: ', err.message);
  else console.log('Connected to SQLite database.');
});

// مسار التحقق من عمل السيرفر والإضافة (لتجنب مشاكل الـ Timeout أو الـ 410)
app.get('/api/ext/config', (req, res) => {
  res.json({
    status: 'success',
    version: '1.0.0',
    message: 'AJ Uploader+ backend is running'
  });
});

// نقطة بداية السيرفر
app.listen(PORT, () => {
  console.log(`AJ Uploader+ server listening on port ${PORT}`);
});
