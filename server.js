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
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^\w.]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'нет файла' });
  res.json({ url: '/uploads/' + req.file.filename });
});

const DEV_NICK = "keshaneironchik";
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    nick TEXT PRIMARY KEY,
    pass_hash TEXT,
    bio TEXT,
    avatar TEXT,
    theme TEXT DEFAULT 'dark',
    bubble TEXT DEFAULT 'default',
    stars INTEGER DEFAULT 0,
    last_game_star INTEGER DEFAULT 0,
    last_seen INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT,
    name TEXT,
    owner TEXT,
    members TEXT,
    theme TEXT DEFAULT 'default',
    wallpaper TEXT DEFAULT 'dots'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    sender TEXT,
    text TEXT,
    type TEXT,
    file_url TEXT,
    reply_to INTEGER,
    reactions TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, owner TEXT, url TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, name TEXT, emoji TEXT, price INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS user_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, gift_id TEXT, from_nick TEXT)`);
});

const GIFTS = [
  { id: 'rose', name: 'Роза', emoji: '🌹', price: 1 },
  { id: 'heart', name: 'Сердце', emoji: '❤️', price: 3 },
  { id: 'bear', name: 'Мишка', emoji: '🧸', price: 5 },
  { id: 'rocket', name: 'Ракета', emoji: '🚀', price: 10 },
  { id: 'crown', name: 'Корона', emoji: '👑', price: 15 }
];
GIFTS.forEach(g => db.run(`INSERT OR IGNORE INTO gifts (id, name, emoji, price) VALUES (?, ?, ?, ?)`, [g.id, g.name, g.emoji, g.price]));

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
    const ok = await bcrypt.compare(password, row.pass_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный ник или пароль' });
    req.session.nick = n;
    db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), n]);
    res.json({ ok: true, nick: n });
  });
});

app.get('/api/me', (req, res) => res.json({ nick: req.session.nick || null }));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

const botReplies = [
  { keys: ["привет", "хай", "ку"], reply: "Привет! Я Neuron Guide. Чем помочь?" },
  { keys: ["помощь", "команды"], reply: "Я умею искать людей по нику, делать стикеры, отвечать на вопросы и звонить." },
  { keys: ["стикер"], reply: "Открой чат, нажми 😀 и добавь стикер из галереи!" },
  { keys: ["звонок"], reply: "Нажми 📞 в шапке чата, чтобы позвонить." },
  { keys: ["баг", "ошибка"], reply: "Обнови страницу! Если не помогло — пиши разработчику." }
];
function getBotReply(text) {
  const lower = text.toLowerCase();
  for (let item of botReplies) { if (item.keys.some(k => lower.includes(k))) return item.reply; }
  return "Я пока не знаю ответа. Спроси про 'стикеры' или 'звонки'.";
}

io.on('connection', (socket) => {
  socket.on('login_nick', (nick) => {
    if (!nick || nick.length < 3) return socket.emit('error', 'Ник от 3 символов');
    socket.nick = nick.toLowerCase();
    db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), socket.nick]);
    socket.emit('logged_in', socket.nick);
  });

  socket.on('search_users', (query) => {
    db.all(`SELECT nick FROM users WHERE nick LIKE ? AND nick != ?`, [`%${query}%`, socket.nick], (err, rows) => {
      socket.emit('search_results', rows || []);
    });
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.nick, `%${socket.nick}%`], (err, rows) => {
      db.all(`SELECT nick, last_seen FROM users`, (err, users) => {
        const online = users.filter(u => Date.now() - u.last_seen < 60000).map(u => u.nick);
        const res = rows.map(c => {
          let other = c.members.split(',').find(m => m !== socket.nick && m !== 'system');
          return { ...c, isOnline: online.includes(other) };
        });
        socket.emit('chats_list', res || []);
      });
    });
  });

  socket.on('create_chat', ({ type, name, target }) => {
    let id = type === 'group' ? `grp_${Date.now()}` : `user_${[socket.nick, target].sort().join('_')}`;
    let members = type === 'chat' ? `${socket.nick},${target}` : socket.nick;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner, members) VALUES (?, ?, ?, ?, ?)`, [id, type, name, socket.nick, members]);
    socket.emit('chat_created');
  });

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => { socket.emit('messages_history', rows || []); });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
    if (!socket.nick) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to) VALUES (?, ?, ?, ?, ?, ?)`,
      [chatId, socket.nick, text || '', type, file_url || '', reply_to || null], function() {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.nick, text, type, file_url, reply_to, reactions: null });
        if (chatId === `bot_${socket.nick}` && type === 'text') {
          setTimeout(() => {
            const reply = getBotReply(text);
            db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', ?, 'text')`, [chatId, reply]);
            io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: 'Neuron Guide', text: reply, type: 'text' });
          }, 800);
        }
        if (chatId === `bot_games_${socket.nick}` && type === 'text') {
          setTimeout(() => {
            const reply = "Хочешь звезду? Нажми «🎮 Играть» в модалке подарков или под сообщением.";
            db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Games', ?, 'text')`, [chatId, reply]);
            io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: 'Neuron Games', text: reply, type: 'text' });
          }, 600);
        }
      });
  });

  socket.on('add_reaction', ({ chatId, msgId, reaction }) => {
    db.get(`SELECT reactions FROM messages WHERE id = ?`, [msgId], (err, row) => {
      let reactions = row.reactions ? JSON.parse(row.reactions) : {};
      reactions[socket.nick] = reaction;
      db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), msgId]);
      io.to(chatId).emit('message_reaction', { msgId, reactions });
    });
  });

  socket.on('delete_message', ({ chatId, msgId }) => {
    db.run(`DELETE FROM messages WHERE id = ?`, [msgId]);
    io.to(chatId).emit('message_deleted', msgId);
  });

  socket.on('add_sticker', (url) => {
    const id = `st_${Date.now()}`;
    db.run(`INSERT INTO stickers (id, owner, url) VALUES (?, ?, ?)`, [id, socket.nick, url]);
    socket.emit('sticker_added');
  });
  socket.on('get_stickers', () => {
    db.all(`SELECT url FROM stickers`, (err, rows) => { socket.emit('stickers_list', rows || []); });
  });

  socket.on('get_profile', (nick) => {
    db.get(`SELECT nick, bio, avatar, theme, bubble, stars, last_seen FROM users WHERE nick = ?`, [(nick || '').toLowerCase()], (err, row) => {
      if (!row) return socket.emit('profile_data', null);
      db.all(`SELECT g.gift_id, g.emoji, g.name, u.from_nick FROM user_gifts u JOIN gifts g ON g.id = u.gift_id WHERE u.owner = ?`, [row.nick], (e, gifts) => {
        const online = Date.now() - (row.last_seen || 0) < 60000;
        socket.emit('profile_data', { ...row, gifts: gifts || [], online });
      });
    });
  });

  socket.on('update_profile', ({ bio, avatar, theme, bubble }) => {
    if (!socket.nick) return;
    db.run(`UPDATE users SET bio = ?, avatar = ?, theme = ?, bubble = ? WHERE nick = ?`,
      [bio || '', avatar || '', theme || 'dark', bubble || 'default', socket.nick]);
    socket.emit('profile_updated');
  });

  socket.on('set_bubble', (bubble) => {
    if (!socket.nick) return;
    db.run(`UPDATE users SET bubble = ? WHERE nick = ?`, [bubble, socket.nick]);
    socket.emit('bubble_updated', bubble);
  });

  socket.on('set_chat_theme', ({ chatId, theme }) => {
    db.run(`UPDATE chats SET theme = ? WHERE id = ?`, [theme, chatId]);
    io.to(chatId).emit('chat_theme_changed', { chatId, theme });
  });

  socket.on('set_wallpaper', ({ chatId, wallpaper }) => {
    db.run(`UPDATE chats SET wallpaper = ? WHERE id = ?`, [wallpaper, chatId]);
    io.to(chatId).emit('wallpaper_changed', { chatId, wallpaper });
  });

  socket.on('get_gifts', () => {
    db.all(`SELECT * FROM gifts`, (e, gifts) => {
      db.all(`SELECT * FROM user_gifts WHERE owner = ?`, [socket.nick], (e2, mine) => {
        db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e3, row) => {
          socket.emit('gifts_data', { gifts, mine, stars: row?.stars || 0 });
        });
      });
    });
  });

  socket.on('buy_gift', (giftId) => {
    db.get(`SELECT price FROM gifts WHERE id = ?`, [giftId], (e, g) => {
      if (!g) return;
      db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e2, row) => {
        if ((row?.stars || 0) < g.price) return socket.emit('gift_error', 'Недостаточно звёзд');
        db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [g.price, socket.nick]);
        db.run(`INSERT INTO user_gifts (owner, gift_id, from_nick) VALUES (?, ?, ?)`, [socket.nick, giftId, socket.nick]);
        socket.emit('gift_bought', giftId);
      });
    });
  });

  socket.on('give_gift', ({ to, giftId }) => {
    db.get(`SELECT price FROM gifts WHERE id = ?`, [giftId], (e, g) => {
      if (!g) return;
      db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e2, row) => {
        if ((row?.stars || 0) < g.price) return socket.emit('gift_error', 'Недостаточно звёзд');
        db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [g.price, socket.nick]);
        db.run(`INSERT INTO user_gifts (owner, gift_id, from_nick) VALUES (?, ?, ?)`, [to, giftId, socket.nick]);
        socket.emit('gift_sent', to);
      });
    });
  });

  socket.on('give_stars', ({ to, amount }) => {
    amount = parseInt(amount) || 0;
    if (amount <= 0) return;
    db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e, row) => {
      if ((row?.stars || 0) < amount) return socket.emit('gift_error', 'Недостаточно звёзд');
      db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [amount, socket.nick]);
      db.run(`UPDATE users SET stars = stars + ? WHERE nick = ?`, [amount, to]);
      socket.emit('stars_sent', { to, amount });
    });
  });

  socket.on('claim_game_star', () => {
    db.get(`SELECT last_game_star, stars FROM users WHERE nick = ?`, [socket.nick], (e, row) => {
      const now = Date.now();
      const last = row?.last_game_star || 0;
      if (now - last < 2 * 60 * 1000) {
        return socket.emit('game_star_cooldown', Math.ceil((2 * 60 * 1000 - (now - last)) / 1000));
      }
      db.run(`UPDATE users SET stars = stars + 1, last_game_star = ? WHERE nick = ?`, [now, socket.nick]);
      socket.emit('game_star_claimed', (row?.stars || 0) + 1);
    });
  });

  socket.on('finish_game', ({ score, time }) => {
    if (!socket.nick) return;
    // Условие «нормального результата»: минимум 10 очков за 2 минуты (120 сек)
    const passed = score >= 10 && time <= 120;
    if (!passed) {
      return socket.emit('game_result', { passed: false, score, message: 'Результат слабоват. Попробуй ещё!' });
    }
    db.get(`SELECT last_game_star, stars FROM users WHERE nick = ?`, [socket.nick], (e, row) => {
      const now = Date.now();
      const last = row?.last_game_star || 0;
      if (now - last < 2 * 60 * 1000) {
        return socket.emit('game_result', { passed: false, cooldown: Math.ceil((2 * 60 * 1000 - (now - last)) / 1000), message: 'Подожди перед следующей игрой' });
      }
      db.run(`UPDATE users SET stars = stars + 1, last_game_star = ? WHERE nick = ?`, [now, socket.nick]);
      socket.emit('game_result', { passed: true, score, stars: (row?.stars || 0) + 1, message: '+1 Нейрон Звезда!' });
    });
  });

  socket.on('call_user', ({ to, offer, mode }) => io.emit('incoming_call', { from: socket.nick, offer, mode: mode || 'video' }));
  socket.on('answer_call', ({ to, answer }) => io.emit('call_answered', { answer }));
  socket.on('switch_call_mode', ({ to, mode }) => io.emit('call_mode_changed', { mode }));
  socket.on('ice_candidate', ({ candidate }) => io.emit('ice_candidate', { candidate }));
  socket.on('end_call', () => io.emit('call_ended'));

  socket.on('get_dev_data', () => {
    if (socket.nick !== DEV_NICK) return;
    db.all(`SELECT nick FROM users`, (err, users) => {
      db.all(`SELECT id, name, type FROM chats`, (err, chats) => socket.emit('dev_data', { users, chats }));
    });
  });
  socket.on('delete_chat', (chatId) => {
    if (socket.nick !== DEV_NICK) return;
    db.run(`DELETE FROM chats WHERE id = ?`, [chatId]); db.run(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
    socket.emit('chat_deleted');
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на ' + port));
