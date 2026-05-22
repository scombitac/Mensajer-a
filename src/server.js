const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const MAX_MENSAJES = 50;
const INTERVALO_MS = 60 * 1000;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Detect Chromium path dynamically
function findChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/nix/var/nix/profiles/default/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const result = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim().split('\n')[0];
    if (result) return result;
  } catch (_) {}
  return null;
}

const CHROMIUM_PATH = findChromium();
console.log('Chromium path:', CHROMIUM_PATH || 'NOT FOUND — will use bundled');

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Sesiones activas por socket ──────────────────────────────────────────────
const sessions = {};

app.use(express.static(path.join(__dirname, '../public')));

// ─── Parsear Excel ────────────────────────────────────────────────────────────
function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const contacts = [];
  for (const row of rows) {
    const n1 = row[0] ? String(row[0]).replace(/[^0-9]/g, '').slice(-10) : null;
    const n2 = row[1] ? String(row[1]).replace(/[^0-9]/g, '').slice(-10) : null;
    const nums = [n1, n2].filter(n => n && n.length === 10);
    if (nums.length) contacts.push({ nums });
  }
  return contacts;
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  sessions[socket.id] = { client: null, sending: false, count: 0 };

  socket.on('disconnect', () => {
    const s = sessions[socket.id];
    if (s && s.client) { try { s.client.destroy(); } catch (_) {} }
    delete sessions[socket.id];
  });

  socket.on('init-whatsapp', async () => {
    const s = sessions[socket.id];
    if (s.client) { try { s.client.destroy(); } catch (_) {} }

    const puppeteerConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    };
    if (CHROMIUM_PATH) puppeteerConfig.executablePath = CHROMIUM_PATH;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `session-${socket.id}` }),
      puppeteer: puppeteerConfig
    });

    s.client = client;

    client.on('qr', async (qr) => {
      const qrImage = await QRCode.toDataURL(qr);
      socket.emit('qr', { qrImage });
    });

    client.on('ready', () => socket.emit('whatsapp-ready'));
    client.on('auth_failure', () => socket.emit('error', { msg: 'Error de autenticación. Recarga la página.' }));
    client.on('disconnected', () => socket.emit('whatsapp-disconnected'));

    try {
      await client.initialize();
    } catch (err) {
      socket.emit('error', { msg: 'Error al iniciar WhatsApp: ' + err.message });
    }
  });

  socket.on('start-sending', async ({ excelPath, imagePath, mensaje }) => {
    const s = sessions[socket.id];
    if (!s.client) return socket.emit('error', { msg: 'WhatsApp no está conectado.' });
    if (s.sending) return socket.emit('error', { msg: 'Ya hay un envío en curso.' });

    let contacts;
    try { contacts = parseExcel(excelPath); }
    catch (err) { return socket.emit('error', { msg: 'Error al leer el Excel: ' + err.message }); }

    if (!contacts.length) return socket.emit('error', { msg: 'No se encontraron números válidos en el Excel.' });

    let media = null;
    if (imagePath && fs.existsSync(imagePath)) media = MessageMedia.fromFilePath(imagePath);

    const limited = contacts.slice(0, MAX_MENSAJES);
    s.sending = true;
    s.count = 0;
    socket.emit('sending-started', { total: limited.length });

    for (let i = 0; i < limited.length; i++) {
      if (!s.sending) break;
      const contacto = limited[i];

      for (const num of contacto.nums) {
        if (!s.sending) break;
        const chatId = `57${num}@c.us`;
        try {
          const registrado = await s.client.isRegisteredUser(chatId);
          if (!registrado) {
            socket.emit('msg-status', { i: i + 1, total: limited.length, numero: num, status: 'no_registrado' });
          } else {
            if (media) await s.client.sendMessage(chatId, media, { caption: mensaje });
            else await s.client.sendMessage(chatId, mensaje);
            s.count++;
            socket.emit('msg-status', { i: i + 1, total: limited.length, numero: num, status: 'enviado' });
          }
        } catch (err) {
          socket.emit('msg-status', { i: i + 1, total: limited.length, numero: num, status: 'error', razon: err.message });
        }
        if (i < limited.length - 1) await sleep(INTERVALO_MS);
      }
    }

    s.sending = false;
    socket.emit('sending-done', { enviados: s.count, total: limited.length });
  });

  socket.on('stop-sending', () => {
    const s = sessions[socket.id];
    if (s) s.sending = false;
    socket.emit('sending-stopped');
  });
});

app.post('/upload', upload.fields([
  { name: 'excel', maxCount: 1 },
  { name: 'imagen', maxCount: 1 }
]), (req, res) => {
  const result = {};
  if (req.files.excel) result.excelPath = req.files.excel[0].path;
  if (req.files.imagen) result.imagePath = req.files.imagen[0].path;
  res.json(result);
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

server.listen(PORT, () => console.log(`✅ Plataforma corriendo en http://localhost:${PORT}`));
