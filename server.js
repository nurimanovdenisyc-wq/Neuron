const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-render-env',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file) => cb(null, Date.now() + '_' + file.originalname.replace(/[^\w.]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  res.json({ url: '/uploads/' + req.file.filename });
});

const DEV_NICK = "keshaneironchik";
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    nick TEXT PRIMARY KEY,
    pass_hash TEXT,
    bio TEXT,
    avatar TEXT,
    nick_color TEXT DEFAULT 'default',
    profile_bg TEXT,
    invisible INTEGER DEFAULT 0,
    bubble TEXT DEFAULT 'default',
    stars INTEGER DEFAULT 0,
    last_game_star INTEGER DEFAULT 0,
    last_premium_claim INTEGER DEFAULT 0,
    premium_until INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    last_seen INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS admins (nick TEXT PRIMARY KEY, until INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, type TEXT, name TEXT, owner TEXT, members TEXT,
    theme TEXT DEFAULT 'default', wallpaper TEXT DEFAULT 'dots', custom_wall TEXT, wall_blur INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT,
    file_url TEXT, reply_to INTEGER, reactions TEXT, pinned INTEGER DEFAULT 0, timestamp INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, owner TEXT, url TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, name TEXT, emoji TEXT, price INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS user_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, gift_id TEXT, from_nick TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, name TEXT, avatar TEXT, bio TEXT, prompt TEXT)`);
});

const GIFTS = [
  { id: 'rose', name: 'Роза', emoji: '🌹', price: 1 },
  { id: 'heart', name: 'Сердце', emoji: '❤️', price: 3 },
  { id: 'like', name: 'Лайк', emoji: '👍', price: 5 },
  { id: 'bear', name: 'Мишка', emoji: '🧸', price: 5 },
  { id: 'poop', name: 'Какашка', emoji: '💩', price: 10 },
  { id: 'rocket', name: 'Ракета', emoji: '🚀', price: 10 },
  { id: 'umbrella', name: 'Зонтик', emoji: '🌂', price: 10 },
  { id: 'crown', name: 'Корона', emoji: '👑', price: 15 },
  { id: 'cigarette', name: 'Сигарета', emoji: '🚬', price: 20 },
  { id: 'beer', name: 'Пиво', emoji: '🍺', price: 20 },
  { id: 'chocolate', name: 'Шоколадка', emoji: '🍫', price: 25 },
  { id: 'spiderweb', name: 'Паутина', emoji: '🕸', price: 25 },
  { id: 'sushi', name: 'Суши', emoji: '🍣', price: 30 },
  { id: 'mushroom', name: 'Мухомор', emoji: '🍄', price: 30 },
  { id: 'bouquet', name: 'Букет', emoji: '💐', price: 50 },
  { id: 'cloud', name: 'Тучка', emoji: '☁️', price: 50 },
  { id: 'helmet', name: 'Каска', emoji: '🪖', price: 50 },
  { id: 'clover', name: 'Клевер', emoji: '🍀', price: 100 },
  { id: 'tophat', name: 'Шляпа', emoji: '🎩', price: 150 }
];
GIFTS.forEach(g => db.run(`INSERT OR IGNORE INTO gifts (id, name, emoji, price) VALUES (?, ?, ?, ?)`, [g.id, g.name, g.emoji, g.price]));

app.post('/api/register', async (req, res) => {
  const { nick, password } = req.body;
  const n = (nick || '').toLowerCase();
  db.get(`SELECT nick FROM users WHERE nick = ?`, [n], async (err, row) => {
    if (row) return res.status(409).json({ error: 'Ник занят' });
    const hash = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (nick, pass_hash, bio, last_seen) VALUES (?, ?, ?, ?)`, [n, hash, 'Привет!', Date.now()], () => {
      db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`, [`bot_${n}`, n]);
      db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'saved', 'Избранное', 'system', ?)`, [`saved_${n}`, n]);
      req.session.nick = n;
      res.json({ ok: true, nick: n });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { nick, password } = req.body;
  const n = (nick || '').toLowerCase();
  db.get(`SELECT * FROM users WHERE nick = ?`, [n], async (err, row) => {
    if (!row || !row.pass_hash) return res.status(401).json({ error: 'Неверный ник или пароль' });
    if (row.is_banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
    const ok = await bcrypt.compare(password, row.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный ник или пароль' });
    req.session.nick = n;
    db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), n]);
    res.json({ ok: true, nick: n });
  });
});

app.get('/api/me', (req, res) => res.json({ nick: req.session.nick || null }));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

function isAdmin(nick, cb) {
  if (nick === DEV_NICK) return cb(true);
  db.get(`SELECT until FROM admins WHERE nick = ?`, [nick], (e, row) => {
    cb(row && (row.until === 0 || row.until > Date.now()));
  });
}

io.on('connection', (socket) => {
  socket.on('login_nick', (nick) => {
    if (!nick || nick.length < 3) return socket.emit('error', 'Ник от 3 символов');
    socket.nick = nick.toLowerCase();
    db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), socket.nick]);
    socket.emit('logged_in', socket.nick);
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.nick, `%${socket.nick}%`], (err, rows) => {
      socket.emit('chats_list', rows || []);
    });
  });

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => { socket.emit('messages_history', rows || []); });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
    if (!socket.nick) return;
    const now = Date.now();
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chatId, socket.nick, text || '', type, file_url || '', reply_to || null, now], function() {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.nick, text, type, file_url, reply_to, timestamp: now });
      });
  });

  socket.on('get_profile', (nick) => {
    db.get(`SELECT * FROM users WHERE nick = ?`, [(nick || '').toLowerCase()], (err, row) => {
      if (!row) return socket.emit('profile_data', null);
      db.all(`SELECT g.emoji, g.name FROM user_gifts u JOIN gifts g ON g.id = u.gift_id WHERE u.owner = ?`, [row.nick], (e, gifts) => {
        socket.emit('profile_data', { ...row, gifts: gifts || [] });
      });
    });
  });

  socket.on('get_gifts', () => {
    db.all(`SELECT * FROM gifts ORDER BY price ASC`, (e, gifts) => {
      db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e2, row) => {
        socket.emit('gifts_data', { gifts, stars: row?.stars || 0 });
      });
    });
  });

  // Админка (выдача прав)
  socket.on('get_dev_data', () => {
    isAdmin(socket.nick, (ok) => {
      if (!ok) return socket.emit('gift_error', 'Нет прав');
      db.all(`SELECT nick, premium_until, is_banned FROM users`, (err, users) => {
        db.all(`SELECT * FROM admins`, (err, admins) => {
          socket.emit('dev_data', { users, admins });
        });
      });
    });
  });

  socket.on('give_admin', ({ target, minutes }) => {
    isAdmin(socket.nick, (ok) => {
      if (!ok) return;
      let until = 0;
      if (minutes > 0) until = Date.now() + (minutes * 60 * 1000);
      db.run(`INSERT OR REPLACE INTO admins (nick, until) VALUES (?, ?)`, [target, until]);
      socket.emit('admin_given');
    });
  });

  socket.on('remove_admin', (target) => {
    isAdmin(socket.nick, (ok) => {
      if (!ok) return;
      db.run(`DELETE FROM admins WHERE nick = ?`, [target]);
      socket.emit('admin_removed');
    });
  });
});

const port = process.env.PORT || 3000;
http.listen(port, '0.0.0.0', () => console.log('Сервер запущен на ' + port));
