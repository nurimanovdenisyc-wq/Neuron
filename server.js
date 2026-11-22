const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const fs = require('fs');

app.use(express.static(__dirname));
// Раздаем загруженные файлы
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Создаем папку для загрузок, если её нет
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Настройка хранилища
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, 'uploads/') },
  filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)) }
});
const upload = multer({ storage: storage });

// API для загрузки фона
app.post('/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const DEV_EMAIL = "keshaneironchik@gmail.com";
const db = new sqlite3.Database('./db.sqlite');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, bio TEXT, avatar TEXT, last_seen INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, bio TEXT, owner TEXT, members TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT, reply_to INTEGER, reactions TEXT)`);
});

io.on('connection', (socket) => {
  socket.on('login_email', (email) => {
    if (!email.includes('@')) return socket.emit('error', 'Неверный формат почты');
    socket.email = email;
    db.run(`UPDATE users SET last_seen = ? WHERE email = ?`, [Date.now(), email]);
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (email, bio) VALUES (?, ?)`, [email, "Привет!"]);
        db.run(`INSERT INTO chats (id, type, name, bio, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'Я твой помощник', 'system', ?)`, [`bot_${email}`, email]);
        db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', 'Привет! Я Neuron Guide.', 'text')`, [`bot_${email}`]);
      }
      socket.emit('logged_in', email);
      socket.broadcast.emit('user_online', email);
    });
  });

  socket.on('disconnect', () => {
    if (socket.email) {
      db.run(`UPDATE users SET last_seen = ? WHERE email = ?`, [Date.now(), socket.email]);
      io.emit('user_offline', socket.email);
    }
  });

  socket.on('typing', (chatId) => { if (socket.email) socket.to(chatId).emit('user_typing', { chatId, sender: socket.email }); });
  socket.on('mark_read', ({ chatId, sender }) => { io.to(chatId).emit('messages_read', { chatId, reader: socket.email }); });

  socket.on('search_users', (query) => {
    db.all(`SELECT email, bio, last_seen FROM users WHERE email LIKE ? AND email != ?`, [`%${query}%`, socket.email], (err, rows) => {
      socket.emit('search_results', rows || []);
    });
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.email, `%${socket.email}%`], (err, rows) => {
      db.all(`SELECT email, last_seen FROM users`, (err, users) => {
        const onlineUsers = users.filter(u => Date.now() - u.last_seen < 60000).map(u => u.email);
        const result = rows.map(c => {
          let other = c.members.split(',').find(m => m !== socket.email && m !== 'system');
          return { ...c, isOnline: onlineUsers.includes(other) };
        });
        socket.emit('chats_list', result || []);
      });
    });
  });

  socket.on('create_chat', ({ type, name, target }) => {
    let id = type === 'channel' ? `chan_${Date.now()}` : type === 'group' ? `grp_${Date.now()}` : `user_${[socket.email, target].sort().join('_')}`;
    let members = type === 'chat' ? `${socket.email},${target}` : socket.email;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner, members) VALUES (?, ?, ?, ?, ?)`, [id, type, name, socket.email, members]);
    socket.emit('chat_created');
  });

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => { socket.emit('messages_history', rows || []); });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
    if (!socket.email) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to) VALUES (?, ?, ?, ?, ?, ?)`, 
      [chatId, socket.email, text || '', type, file_url || '', reply_to || null], function(err) {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.email, text, type, file_url, reply_to });
      });
  });

  socket.on('add_reaction', ({ chatId, msgId, reaction }) => {
    db.get(`SELECT reactions FROM messages WHERE id = ?`, [msgId], (err, row) => {
      let reactions = row.reactions ? JSON.parse(row.reactions) : {};
      reactions[socket.email] = reaction;
      db.run(`UPDATE messages SET reactions = ? WHERE id = ?`, [JSON.stringify(reactions), msgId]);
      io.to(chatId).emit('message_reaction', { msgId, reactions });
    });
  });

  socket.on('delete_message', ({ chatId, msgId }) => {
    db.run(`DELETE FROM messages WHERE id = ?`, [msgId]);
    io.to(chatId).emit('message_deleted', msgId);
  });

  socket.on('call_user', ({ to, offer }) => {
    db.get(`SELECT last_seen FROM users WHERE email = ?`, [to], (err, row) => {
      if (row && (Date.now() - row.last_seen < 60000)) io.emit('incoming_call', { from: socket.email, offer });
      else socket.emit('call_error', 'Пользователь не в сети');
    });
  });
  socket.on('answer_call', ({ to, answer }) => io.emit('call_answered', { answer }));
  socket.on('ice_candidate', ({ candidate }) => io.emit('ice_candidate', { candidate }));
  socket.on('end_call', ({ to }) => io.emit('call_ended'));

  socket.on('get_dev_data', () => {
    if (socket.email !== DEV_EMAIL) return;
    db.all(`SELECT email FROM users`, (err, users) => {
      db.all(`SELECT id, name, type FROM chats`, (err, chats) => socket.emit('dev_data', { users, chats }));
    });
  });
  socket.on('delete_chat', (chatId) => {
    if (socket.email !== DEV_EMAIL) return;
    db.run(`DELETE FROM chats WHERE id = ?`, [chatId]); db.run(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
    socket.emit('chat_deleted');
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на ' + port));
