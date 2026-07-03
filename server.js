/*
 * Сайт-портфолио с фотогалереей и админкой.
 * Зависимостей нет — нужен только Node.js (v16+).
 * Запуск:  node server.js
 * Сайт:    http://localhost:3000
 * Админка: http://localhost:3000/admin  (пароль в data/config.json)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTOS_JSON = path.join(DATA_DIR, 'photos.json');
const CONFIG_JSON = path.join(DATA_DIR, 'config.json');

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024; // ~40 МБ на запрос

// ---------- подготовка ----------
for (const dir of [PUBLIC_DIR, UPLOADS_DIR, DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(PHOTOS_JSON)) fs.writeFileSync(PHOTOS_JSON, '[]');
if (!fs.existsSync(CONFIG_JSON)) {
  fs.writeFileSync(CONFIG_JSON, JSON.stringify({
    password: 'admin123',
    title: 'КРИСТИНА ХАРЛАМОВА',
    subtitle: 'художник · живопись, графика, художественная ковка, керамика'
  }, null, 2));
}

const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2));

// ---------- пароль админки ----------
// Приоритет: переменная окружения ADMIN_PASSWORD (задаётся в панели хостинга,
// переживает передеплои и не хранится в репозитории), иначе — data/config.json.
function adminPassword() {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 4) {
    return process.env.ADMIN_PASSWORD;
  }
  return readJSON(CONFIG_JSON, {}).password;
}

// ---------- сессии (в памяти) ----------
const sessions = new Set();
function getToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return m ? m[1] : null;
}
function isAuthed(req) {
  const t = getToken(req);
  return t && sessions.has(t);
}

// ---------- утилиты ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.avif': 'image/avif'
};
const ALLOWED_IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}
function sendJSON(res, code, obj, extra = {}) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...extra });
}
function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeServeFile(res, baseDir, relPath) {
  const full = path.normalize(path.join(baseDir, relPath));
  if (!full.startsWith(baseDir)) return send(res, 403, 'Forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': baseDir === UPLOADS_DIR ? 'public, max-age=86400' : 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // --- страницы и статика ---
    if (req.method === 'GET') {
      if (p === '/' ) return safeServeFile(res, PUBLIC_DIR, 'index.html');
      if (p === '/admin') return safeServeFile(res, PUBLIC_DIR, 'admin.html');
      if (p.startsWith('/uploads/')) return safeServeFile(res, UPLOADS_DIR, p.slice('/uploads/'.length));

      // --- API: список фото и настройки (публично) ---
      if (p === '/api/photos') {
        const photos = readJSON(PHOTOS_JSON, []);
        return sendJSON(res, 200, photos);
      }
      if (p === '/api/site') {
        const cfg = readJSON(CONFIG_JSON, {});
        return sendJSON(res, 200, { title: cfg.title, subtitle: cfg.subtitle });
      }
      if (p === '/api/me') {
        return sendJSON(res, 200, { authed: isAuthed(req) });
      }
      // прочая статика из public/
      return safeServeFile(res, PUBLIC_DIR, p.slice(1));
    }

    if (req.method === 'POST') {
      // --- вход ---
      if (p === '/api/login') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        if (body.password && body.password === adminPassword()) {
          const token = crypto.randomBytes(24).toString('hex');
          sessions.add(token);
          return sendJSON(res, 200, { ok: true }, {
            'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`
          });
        }
        return sendJSON(res, 401, { ok: false, error: 'Неверный пароль' });
      }
      if (p === '/api/logout') {
        const t = getToken(req);
        if (t) sessions.delete(t);
        return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
      }

      // --- всё ниже требует входа ---
      if (!isAuthed(req)) return sendJSON(res, 401, { ok: false, error: 'Требуется вход' });

      // --- загрузка фото (JSON: [{name, dataUrl, caption}]) ---
      if (p === '/api/upload') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) return sendJSON(res, 400, { ok: false, error: 'Нет файлов' });

        const photos = readJSON(PHOTOS_JSON, []);
        const added = [];
        for (const f of files) {
          const m = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,(.+)$/s.exec(f.dataUrl || '');
          if (!m) continue;
          let ext = '.' + m[1].replace('jpeg', 'jpg');
          if (!ALLOWED_IMG.has(ext)) continue;
          const buf = Buffer.from(m[2], 'base64');
          const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
          const filename = id + ext;
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
          const rec = {
            id,
            file: '/uploads/' + filename,
            caption: (f.caption || '').slice(0, 300),
            category: (f.category || '').slice(0, 60),
            year: Number.isInteger(f.year) && f.year > 1000 && f.year < 3000 ? f.year : null,
            original: (f.name || '').slice(0, 200),
            addedAt: new Date().toISOString()
          };
          photos.unshift(rec);
          added.push(rec);
        }
        writeJSON(PHOTOS_JSON, photos);
        return sendJSON(res, 200, { ok: true, added });
      }

      // --- удаление ---
      if (p === '/api/delete') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        let photos = readJSON(PHOTOS_JSON, []);
        const rec = photos.find((x) => x.id === body.id);
        if (rec) {
          const fname = path.basename(rec.file);
          const full = path.join(UPLOADS_DIR, fname);
          if (fs.existsSync(full)) fs.unlinkSync(full);
          photos = photos.filter((x) => x.id !== body.id);
          writeJSON(PHOTOS_JSON, photos);
        }
        return sendJSON(res, 200, { ok: true });
      }

      // --- изменение подписи / категории ---
      if (p === '/api/caption') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        const photos = readJSON(PHOTOS_JSON, []);
        const rec = photos.find((x) => x.id === body.id);
        if (rec) {
          if (typeof body.caption === 'string') rec.caption = body.caption.slice(0, 300);
          if (typeof body.category === 'string') rec.category = body.category.slice(0, 60);
          if ('year' in body) {
            const y = parseInt(body.year, 10);
            rec.year = (y > 1000 && y < 3000) ? y : null;
          }
          writeJSON(PHOTOS_JSON, photos);
        }
        return sendJSON(res, 200, { ok: true });
      }

      // --- настройки сайта (заголовок/подзаголовок/пароль) ---
      if (p === '/api/settings') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        const cfg = readJSON(CONFIG_JSON, {});
        if (typeof body.title === 'string') cfg.title = body.title.slice(0, 100);
        if (typeof body.subtitle === 'string') cfg.subtitle = body.subtitle.slice(0, 200);
        let warning = null;
        if (typeof body.password === 'string' && body.password.length >= 4) {
          if (process.env.ADMIN_PASSWORD) {
            warning = 'Пароль задан переменной окружения ADMIN_PASSWORD на хостинге — менять его нужно там, изменение здесь не подействует.';
          } else {
            cfg.password = body.password;
          }
        }
        writeJSON(CONFIG_JSON, cfg);
        return sendJSON(res, 200, { ok: true, warning });
      }
    }

    send(res, 404, 'Not found');
  } catch (e) {
    if (e.message === 'too_large') return sendJSON(res, 413, { ok: false, error: 'Файл слишком большой' });
    sendJSON(res, 500, { ok: false, error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`Портфолио запущено:  http://localhost:${PORT}`);
  console.log(`Админка:             http://localhost:${PORT}/admin`);
});
