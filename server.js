const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'neuron_super_secret_key_123',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(express.static(__dirname));

app.get('/', (req, res) => { 
  res.sendFile(path.resolve(process.cwd(), 'index.html')); 
});

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (nick TEXT PRIMARY KEY, password TEXT, bio TEXT, avatar TEXT, stars INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner TEXT, members TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT, reply_to INTEGER, reactions TEXT, pinned INTEGER DEFAULT 0, ts INTEGER, forwarded_from TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS bots (nick TEXT PRIMARY KEY, owner TEXT, persona TEXT)`);
});

// API
app.post('/api/register', async (req, res) => {
  const { nick, password } = req.body;
  if (!nick || nick.length < 3) return res.status(400).json({ error: 'Ник короткий' });
  const lowerNick = nick.toLowerCase();
  db.get(`SELECT nick FROM users WHERE nick = ?`, [lowerNick], async (err, row) => {
    if (row) return res.status(400).json({ error: 'Ник занят' });
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (nick, password, bio) VALUES (?, ?, 'Привет!')`, [lowerNick, hashedPassword], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });
      req.session.nick = lowerNick;
      res.json({ nick: lowerNick });
    });
  });
});

app.post('/api/login', (req, res) => {
  const { nick, password } = req.body;
  const lowerNick = nick.toLowerCase();
  db.get(`SELECT * FROM users WHERE nick = ?`, [lowerNick], async (err, user) => {
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    if (!user.password) {
      const hashed = await bcrypt.hash(password, 10);
      db.run(`UPDATE users SET password = ? WHERE nick = ?`, [hashed, lowerNick]);
      req.session.nick = lowerNick;
      return res.json({ nick: lowerNick });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });
    req.session.nick = lowerNick;
    res.json({ nick: lowerNick });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session.nick) res.json({ nick: req.session.nick });
  else res.status(401).json({ error: 'Не авторизован' });
});

// SOCKET
io.on('connection', (socket) => {
  socket.on('login_nick', (nick) => {
    socket.nick = nick.toLowerCase();
    db.get(`SELECT * FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
      if (!row) db.run(`INSERT INTO users (nick, bio) VALUES (?, 'Привет!')`, [socket.nick]);
      socket.emit('logged_in', socket.nick);
    });
  });

  // СОЗДАНИЕ БОТА
  socket.on('create_bot', ({ name, persona }) => {
    const botNick = name.toLowerCase().replace(/\s+/g, '_') + "_bot";
    
    // Добавляем бота в базу
    db.run(`INSERT OR IGNORE INTO users (nick, bio) VALUES (?, 'Я бот!')`, [botNick]);
    db.run(`INSERT OR IGNORE INTO bots (nick, owner, persona) VALUES (?, ?, ?)`, [botNick, socket.nick, persona]);
    
    // Создаем чат с ботом
    const chatId = `bot_${botNick}`;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner, members) VALUES (?, 'bot', ?, ?, ?)`, [chatId, name, socket.nick, socket.nick]);
    
    // Добавляем приветственное сообщение
    db.run(`INSERT INTO messages (chat_id, sender, text, type, ts) VALUES (?, ?, ?, 'text', ?)`, [chatId, botNick, `Привет! Я ${name}. Мой характер: ${persona}. Чем могу помочь?`, Date.now()]);
    
    socket.emit('bot_created');
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.nick, `%${socket.nick}%`], (err, rows) => {
      socket.emit('chats_list', [ { id: `fav_${socket.nick}`, type: 'fav', name: 'Избранное' }, ...(rows || []) ]);
    });
  });

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY ts ASC`, [chatId], (err, rows) => { socket.emit('messages_history', rows || []); });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
    if (!socket.nick) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
      [chatId, socket.nick, text || '', type, file_url || '', reply_to || null, Date.now()], function() {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.nick, text, type, file_url, reply_to, ts: Date.now() });
        
        // Если это чат с ботом - отвечаем
        if (chatId.includes("_bot")) {
          const botNick = chatId.replace("bot_", "");
          db.get(`SELECT persona FROM bots WHERE nick = ?`, [botNick], (err, bot) => {
            if (bot && text) {
              setTimeout(() => {
                const reply = `[Бот ${bot.persona}]: ${text}`; // Простой ответ бота (эхо)
                db.run(`INSERT INTO messages (chat_id, sender, text, type, ts) VALUES (?, ?, ?, 'text', ?)`, [chatId, botNick, reply, Date.now()]);
                io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: botNick, text: reply, type: 'text', ts: Date.now() });
              }, 1000);
            }
          });
        }
      });
  });

  socket.on('get_profile', (nick) => {
    db.get(`SELECT * FROM users WHERE nick = ?`, [nick], (err, user) => {
      socket.emit('profile_data', { user });
    });
  });

  socket.on('update_profile', ({ avatar, bio }) => {
    db.run(`UPDATE users SET avatar = ?, bio = ? WHERE nick = ?`, [avatar, bio, socket.nick]);
    socket.emit('profile_updated');
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на ' + port));
