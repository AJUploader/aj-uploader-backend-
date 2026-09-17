const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('processed')) fs.mkdirSync('processed');

// فحص السيرفر
app.get('/', (req, res) => {
  res.json({ status: 'Online', message: 'AJ Uploader Server is Active' });
});

// استقبال طلب الجودة والموافقة عليه
app.post('/api/process-video', upload.single('video'), (req, res) => {
  res.json({ 
    success: true, 
    message: 'AJ Uploader: Video processed successfully',
    quality: '1080p60'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
