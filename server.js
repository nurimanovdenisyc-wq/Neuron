const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const DEV_EMAIL = "keshaneironchik@gmail.com";
const db = new sqlite3.Database('./database.db');

// Создание таблиц
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, bio TEXT, last_seen INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner TEXT, members TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT)`);
});

io.on('connection', (socket) => {
  // Вход
  socket.on('login_email', (email) => {
    if (!email || !email.includes('@')) return socket.emit('error', 'Неверный формат почты');
    socket.email = email;
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (email, bio) VALUES (?, ?)`, [email, "Привет!"]);
        // Создаем чат с ботом
        const botChatId = `bot_${email}`;
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`, [botChatId, email]);
        db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', 'Привет! Я Neuron Guide. Помогу освоиться.', 'text')`, [botChatId]);
      }
      socket.emit('logged_in', email);
    });
  });

  // Поиск
  socket.on('search_users', (query) => {
    db.all(`SELECT email FROM users WHERE email LIKE ? AND email != ?`, [`%${query}%`, socket.email], (err, rows) => {
      socket.emit('search_results', rows || []);
    });
  });

  // Получить чаты
  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.email, `%${socket.email}%`], (err, rows) => {
      socket.emit('chats_list', rows || []);
    });
  });

  // Создать чат
  socket.on('create_chat', ({ type, name, target }) => {
    let id = type === 'group' ? `grp_${Date.now()}` : `user_${[socket.email, target].sort().join('_')}`;
    let members = type === 'chat' ? `${socket.email},${target}` : socket.email;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner, members) VALUES (?, ?, ?, ?, ?)`, [id, type, name, socket.email, members]);
    socket.emit('chat_created');
  });

  // Войти в чат
  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => { 
      socket.emit('messages_history', rows || []); 
    });
  });

  // Отправить сообщение
  socket.on('send_message', ({ chatId, text, type }) => {
    if (!socket.email) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, ?, ?, ?)`, 
      [chatId, socket.email, text || '', type], function() {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.email, text, type });
      });
  });

  // Звонки
  socket.on('call_user', ({ to, offer }) => io.emit('incoming_call', { from: socket.email, offer }));
  socket.on('answer_call', ({ to, answer }) => io.emit('call_answered', { answer }));
  socket.on('ice_candidate', ({ candidate }) => io.emit('ice_candidate', { candidate }));
  socket.on('end_call', () => io.emit('call_ended'));

  // DEV панель
  socket.on('get_dev_data', () => {
    if (socket.email !== DEV_EMAIL) return;
    db.all(`SELECT email FROM users`, (err, users) => {
      db.all(`SELECT id, name, type FROM chats`, (err, chats) => socket.emit('dev_data', { users, chats }));
    });
  });
  socket.on('delete_chat', (chatId) => {
    if (socket.email !== DEV_EMAIL) return;
    db.run(`DELETE FROM chats WHERE id = ?`, [chatId]); 
    db.run(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
    socket.emit('chat_deleted');
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на ' + port));
