const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, '../uploads');
const MAX_MENSAJES = 50;
const INTERVALO_MS = 60 * 1000; // 60 segundos

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
const sessions = {}; // socketId -> { client, sending, count }

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
    if (s && s.client) {
      try { s.client.destroy(); } catch (_) {}
    }
    delete sessions[socket.id];
    console.log(`Cliente desconectado: ${socket.id}`);
  });

  socket.on('init-whatsapp', async ({ sessionId }) => {
    const s = sessions[socket.id];
    if (s.client) {
      try { s.client.destroy(); } catch (_) {}
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `session-${socket.id}` }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }
    });

    s.client = client;

    client.on('qr', async (qr) => {
      const qrImage = await QRCode.toDataURL(qr);
      socket.emit('qr', { qrImage });
    });

    client.on('ready', () => {
      socket.emit('whatsapp-ready');
    });

    client.on('auth_failure', () => {
      socket.emit('error', { msg: 'Error de autenticación. Recarga la página e intenta de nuevo.' });
    });

    client.on('disconnected', () => {
      socket.emit('whatsapp-disconnected');
    });

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
    try {
      contacts = parseExcel(excelPath);
    } catch (err) {
      return socket.emit('error', { msg: 'Error al leer el Excel: ' + err.message });
    }

    if (!contacts.length) return socket.emit('error', { msg: 'No se encontraron números válidos en el Excel.' });

    let media = null;
    if (imagePath && fs.existsSync(imagePath)) {
      media = MessageMedia.fromFilePath(imagePath);
    }

    const limited = contacts.slice(0, MAX_MENSAJES);
    s.sending = true;
    s.count = 0;

    socket.emit('sending-started', { total: limited.length });

    for (let i = 0; i < limited.length; i++) {
      if (!s.sending) break;

      const contacto = limited[i];

      for (const num of contacto.nums) {
        if (!s.sending) break;
        const numero = '57' + num;
        const chatId = `${numero}@c.us`;

        try {
          const registrado = await s.client.isRegisteredUser(chatId);
          if (!registrado) {
            socket.emit('msg-status', { i: i + 1, total: limited.length, numero, status: 'no_registrado' });
          } else {
            if (media) {
              await s.client.sendMessage(chatId, media, { caption: mensaje });
            } else {
              await s.client.sendMessage(chatId, mensaje);
            }
            s.count++;
            socket.emit('msg-status', { i: i + 1, total: limited.length, numero, status: 'enviado' });
          }
        } catch (err) {
          socket.emit('msg-status', { i: i + 1, total: limited.length, numero, status: 'error', razon: err.message });
        }

        // Esperar intervalo entre envíos
        if (i < limited.length - 1 || contacto.nums.indexOf(num) < contacto.nums.length - 1) {
          await sleep(INTERVALO_MS);
        }
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

// ─── Upload endpoint ──────────────────────────────────────────────────────────
app.post('/upload', upload.fields([
  { name: 'excel', maxCount: 1 },
  { name: 'imagen', maxCount: 1 }
]), (req, res) => {
  const result = {};
  if (req.files.excel) result.excelPath = req.files.excel[0].path;
  if (req.files.imagen) result.imagePath = req.files.imagen[0].path;
  res.json(result);
});

// ─── Utils ────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

server.listen(PORT, () => {
  console.log(`\n✅ Plataforma corriendo en http://localhost:${PORT}\n`);
});
