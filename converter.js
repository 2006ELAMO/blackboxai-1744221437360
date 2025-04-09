const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');
const WebSocket = require('ws');
const filesize = require('filesize');
const crypto = require('crypto');
const { generatePS2Boot } = require('ps2-boot-generator');
const { extractRVZ } = require('wii-rvz-extractor');

const app = express();
const upload = multer({ dest: 'uploads/' });
const MAX_SIZE = 8.5 * 1024 * 1024 * 1024; // 8.5GB in bytes

// WebSocket server for progress updates
const wss = new WebSocket.Server({ noServer: true });

// Ensure required directories exist
fs.ensureDirSync('uploads');
fs.ensureDirSync('temp/extracted');
fs.ensureDirSync('temp/converted');

// Utility functions
const execPromise = (command) => new Promise((resolve, reject) => {
  exec(command, (error, stdout, stderr) => {
    if (error) reject(stderr || error);
    else resolve(stdout);
  });
});

const getFileHash = (filePath) => new Promise((resolve) => {
  const hash = crypto.createHash('sha1');
  const stream = fs.createReadStream(filePath);
  stream.on('data', (data) => hash.update(data));
  stream.on('end', () => resolve(hash.digest('hex')));
});

// Broadcast progress to all clients
const broadcastProgress = (stage, percent) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ stage, percent }));
    }
  });
};

// Routes
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/process', (req, res) => res.sendFile(path.join(__dirname, 'public/process.html')));
app.get('/result', (req, res) => res.sendFile(path.join(__dirname, 'public/result.html')));

app.get('/file-info', async (req, res) => {
  try {
    const stats = await fs.stat('output.iso');
    const hash = await getFileHash('output.iso');
    
    res.json({
      filename: 'game.iso',
      size: filesize(stats.size),
      hash: hash.substring(0, 12) + '...'
    });
  } catch (err) {
    res.status(404).json({ error: 'No converted file found' });
  }
});

app.post('/upload', upload.single('rvzFile'), async (req, res) => {
  try {
    if (!req.file.originalname.endsWith('.rvz')) {
      throw new Error('Invalid file format - must be .rvz');
    }
    res.redirect('/process');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.post('/convert', async (req, res) => {
  try {
    const filePath = path.resolve(req.file.path);
    
    // 1. Extract RVZ files
    broadcastProgress('extract', 0);
    await extractRVZ(filePath, 'temp/extracted', (progress) => {
      broadcastProgress('extract', Math.floor(progress * 100));
    });

    // 2. Convert files to PS2 format
    broadcastProgress('convert', 0);
    const files = await fs.readdir('temp/extracted');
    let convertedCount = 0;
    
    await Promise.all(files.map(async (file) => {
      const srcPath = path.join('temp/extracted', file);
      const destPath = path.join('temp/converted', file);
      
      // Convert textures if needed
      if (file.endsWith('.txm')) {
        await sharp(srcPath)
          .toFormat('png')
          .toFile(destPath.replace('.txm', '.vtf'));
      } else {
        await fs.copy(srcPath, destPath);
      }
      
      convertedCount++;
      broadcastProgress('convert', Math.floor((convertedCount / files.length) * 100));
    }));

    // 3. Generate PS2 boot file
    await generatePS2Boot('temp/converted/BOOT.ELF', 'temp/converted/BOOT2.BIN');

    // 4. Create ISO with size check
    broadcastProgress('iso', 0);
    await execPromise(`genisoimage -o temp/output.iso -b BOOT2.BIN -V PS2_GAME temp/converted`);
    
    // Verify size
    const stats = await fs.stat('temp/output.iso');
    if (stats.size > MAX_SIZE) {
      throw new Error(`Converted file exceeds 8.5GB limit (${filesize(stats.size)})`);
    }

    // Move final file
    await fs.move('temp/output.iso', 'output.iso', { overwrite: true });
    broadcastProgress('iso', 100);
    
    res.redirect('/result');
  } catch (err) {
    broadcastProgress('error', err.message);
    res.status(500).send(`Conversion failed: ${err.message}`);
  }
});

app.get('/download', (req, res) => {
  res.download('output.iso', 'game.iso');
});

// WebSocket upgrade handler
const server = app.listen(8000, () => console.log('Server running on port 8000'));
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Cleanup
process.on('exit', () => {
  fs.removeSync('temp');
  fs.removeSync('output.iso');
});
