const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));

// فحص السيرفر
app.get('/', (req, res) => {
  res.json({ status: 'Online', message: "AJ Uploader Backend Active" });
});

// معالجة طلب الجودة واستعراض شريط Rendering
app.all('*', async (req, res) => {
  console.log(`[+] Received request on: ${req.path}`);

  // إعطاء وقت 3 ثوانٍ لتظهر الإضافة نافذة Rendering your video
  await new Promise((resolve) => setTimeout(resolve, 3000));

  res.json({
    status: 'success',
    success: true,
    code: 200,
    message: 'HD quality locked successfully',
    data: {
      rendered: true,
      quality: '1080p60',
      hd_locked: true
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
