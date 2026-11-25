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
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT,
    name TEXT,
    owner TEXT,
    members TEXT,
    theme TEXT DEFAULT 'default',
    wallpaper TEXT DEFAULT 'dots',
    custom_wall TEXT,
    wall_blur INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    sender TEXT,
    text TEXT,
    type TEXT,
    file_url TEXT,
    reply_to INTEGER,
    reactions TEXT,
    pinned INTEGER DEFAULT 0,
    timestamp INTEGER
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
GIFTS.forEach(g => {
  db.run(`INSERT OR IGNORE INTO gifts (id, name, emoji, price) VALUES (?, ?, ?, ?)`, [g.id, g.name, g.emoji, g.price]);
  db.run(`UPDATE gifts SET price = ? WHERE id = ?`, [g.price, g.id]);
});

app.post('/api/register', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || nick.length < 3) return res.status(400).json({ error: 'Ник от 3 символов' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль от 4 символов' });
  const n = nick.toLowerCase();
  db.get(`SELECT nick FROM users WHERE nick = ?`, [n], async (err, row) => {
    if (row) return res.status(409).json({ error: 'Ник занят' });
    const hash = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (nick, pass_hash, bio, last_seen) VALUES (?, ?, ?, ?)`,
      [n, hash, 'Привет!', Date.now()], () => {
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`,
          [`bot_${n}`, n]);
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Games', 'system', ?)`,
          [`bot_games_${n}`, n]);
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'saved', 'Избранное', 'system', ?)`,
          [`saved_${n}`, n]);
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

function getBotReply(text, prompt) {
  const lower = text.toLowerCase();
  if (prompt) return `[Бот: ${prompt}] Я получил твое сообщение: "${text}"`;
  if (lower.includes('привет')) return "Привет! Я Neuron Guide. Чем помочь?";
  return "Я пока не знаю ответа.";
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
      db.all(`SELECT nick, last_seen, invisible, premium_until FROM users`, (err, users) => {
        const online = users.filter(u => u.invisible === 0 && (Date.now() - u.last_seen < 60000)).map(u => u.nick);
        const res = rows.map(c => {
          let other = c.members.split(',').find(m => m !== socket.nick && m !== 'system');
          return { ...c, isOnline: online.includes(other) };
        });
        socket.emit('chats_list', res || []);
      });
    });
  });

  socket.on('create_bot', ({ name, avatar, bio, prompt }) => {
    db.get(`SELECT premium_until FROM users WHERE nick = ?`, [socket.nick], (e, u) => {
      db.get(`SELECT COUNT(*) as count FROM bots WHERE owner = ?`, [socket.nick], (e2, c) => {
        const isPrem = u.premium_until > Date.now();
        if (!isPrem && c.count >= 2) return socket.emit('gift_error', 'Лимит ботов (2). Купите Премиум для 10.');
        db.run(`INSERT INTO bots (owner, name, avatar, bio, prompt) VALUES (?, ?, ?, ?, ?)`, 
          [socket.nick, name, avatar, bio, prompt], function() {
            const botId = this.lastID;
            const botNick = `bot_${botId}`;
            bcrypt.hash(botNick, 10).then(hash => {
              db.run(`INSERT INTO users (nick, pass_hash, bio, avatar) VALUES (?, ?, ?, ?)`, [botNick, hash, bio, avatar]);
              db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', ?, 'system', ?)`, [`chat_${botNick}`, name, socket.nick]);
              socket.emit('bot_created');
            });
          });
      });
    });
  });

  socket.on('update_profile', ({ bio, avatar, nick_color, profile_bg, invisible }) => {
    if (!socket.nick) return;
    db.get(`SELECT premium_until FROM users WHERE nick = ?`, [socket.nick], (e, u) => {
      const isPrem = u.premium_until > Date.now();
      const updateColor = isPrem ? (nick_color || 'default') : 'default';
      const updateBg = isPrem ? (profile_bg || '') : '';
      const updateInv = isPrem ? (invisible || 0) : 0;
      
      db.run(`UPDATE users SET bio = ?, avatar = ?, nick_color = ?, profile_bg = ?, invisible = ? WHERE nick = ?`,
        [bio || '', avatar || '', updateColor, updateBg, updateInv, socket.nick]);
      socket.emit('profile_updated');
    });
  });

  socket.on('get_profile', (nick) => {
    db.get(`SELECT nick, bio, avatar, nick_color, profile_bg, invisible, bubble, stars, premium_until, last_seen FROM users WHERE nick = ?`, [(nick || '').toLowerCase()], (err, row) => {
      if (!row) return socket.emit('profile_data', null);
      db.all(`SELECT g.gift_id, g.emoji, g.name, u.from_nick FROM user_gifts u JOIN gifts g ON g.id = u.gift_id WHERE u.owner = ?`, [row.nick], (e, gifts) => {
        const online = row.invisible ? false : (Date.now() - (row.last_seen || 0) < 60000);
        socket.emit('profile_data', { ...row, gifts: gifts || [], online });
      });
    });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
    if (!socket.nick) return;
    const now = Date.now();
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [chatId, socket.nick, text || '', type, file_url || '', reply_to || null, now], function() {
        const msg = { id: this.lastID, chat_id: chatId, sender: socket.nick, text, type, file_url, reply_to, timestamp: now };
        io.to(chatId).emit('new_message', msg);
        if (chatId.startsWith('bot_') && type === 'text') {
          db.get(`SELECT * FROM bots WHERE owner = ? AND name = ?`, [socket.nick, chatId.replace('bot_', '')], (e, bot) => {
            const replyText = getBotReply(text, bot ? bot.prompt : null);
            setTimeout(() => {
              db.run(`INSERT INTO messages (chat_id, sender, text, type, timestamp) VALUES (?, ?, ?, 'text', ?)`, [chatId, bot ? bot.name : 'Neuron Guide', replyText, Date.now()]);
              io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: bot ? bot.name : 'Neuron Guide', text: replyText, type: 'text', timestamp: Date.now() });
            }, 1000);
          });
        }
      });
  });

  socket.on('buy_premium', ({ plan }) => {
    let days = plan === 'year' ? 365 : plan === '3months' ? 90 : 30;
    let cost = plan === 'year' ? 50000 : plan === '3months' ? 5000 : 1000;
    db.get(`SELECT stars, premium_until FROM users WHERE nick = ?`, [socket.nick], (e, row) => {
      if ((row?.stars || 0) < cost) return socket.emit('gift_error', 'Недостаточно звёзд');
      const now = Date.now();
      const currentPremium = row.premium_until > now ? row.premium_until : now;
      const newPremium = currentPremium + (days * 24 * 60 * 60 * 1000);
      db.run(`UPDATE users SET stars = stars - ?, premium_until = ? WHERE nick = ?`, [cost, newPremium, socket.nick]);
      socket.emit('premium_bought');
    });
  });

  socket.on('claim_premium_stars', () => {
    db.get(`SELECT premium_until, last_premium_claim FROM users WHERE nick = ?`, [socket.nick], (e, row) => {
      const now = Date.now();
      if (row.premium_until < now) return socket.emit('gift_error', 'У вас нет Премиума');
      const lastClaim = row.last_premium_claim || 0;
      if (now - lastClaim < 24 * 60 * 60 * 1000) return socket.emit('gift_error', 'Вы уже получали звезды сегодня');
      db.run(`UPDATE users SET stars = stars + 5, last_premium_claim = ? WHERE nick = ?`, [now, socket.nick]);
      socket.emit('premium_stars_claimed');
    });
  });

  socket.on('buy_gift', ({ giftId, style }) => {
    db.get(`SELECT price FROM gifts WHERE id = ?`, [giftId], (e, g) => {
      if (!g) return;
      db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e2, row) => {
        if ((row?.stars || 0) < g.price) return socket.emit('gift_error', 'Недостаточно звёзд');
        db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [g.price, socket.nick]);
        db.run(`INSERT INTO user_gifts (owner, gift_id, from_nick, style) VALUES (?, ?, ?, ?)`, [socket.nick, giftId, socket.nick, style || 'default']);
        socket.emit('gift_bought', giftId);
      });
    });
  });

  socket.on('give_gift', ({ to, giftId, style }) => {
    db.get(`SELECT price FROM gifts WHERE id = ?`, [giftId], (e, g) => {
      if (!g) return;
      db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e2, row) => {
        if ((row?.stars || 0) < g.price) return socket.emit('gift_error', 'Недостаточно звёзд');
        db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [g.price, socket.nick]);
        db.run(`INSERT INTO user_gifts (owner, gift_id, from_nick, style) VALUES (?, ?, ?, ?)`, [to, giftId, socket.nick, style || 'default']);
        socket.emit('gift_sent', to);
      });
    });
  });

  // Заглушка для игры
  socket.on('finish_game', ({ score, time }) => {
    socket.emit('game_result', { passed: true, score, stars: 1, message: 'Игра засчитана!' });
  });
});

const port = process.env.PORT || 3000;
http.listen(port, '0.0.0.0', () => console.log('Сервер запущен на ' + port));
