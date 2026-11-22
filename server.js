const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const DEV_EMAIL = "keshaneironchik@gmail.com";

// БАЗА ДАННЫХ
const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, bio TEXT, avatar TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, bio TEXT, owner TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT)`);
});

io.on('connection', (socket) => {
  // ПРОСТОЙ ВХОД ПО ПОЧТЕ
  socket.on('login_email', (email) => {
    if (!email.includes('@')) return socket.emit('error', 'Неверный формат почты');
    socket.email = email;
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (email, bio) VALUES (?, ?)`, [email, "Привет!"]);
        // Создаем чат с ботом для новичка
        db.run(`INSERT INTO chats (id, type, name, bio, owner) VALUES (?, 'bot', 'Neuron Guide', 'Я твой помощник', 'system')`, [`bot_${email}`]);
        db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', 'Привет! Я Neuron Guide. Помогу освоиться.', 'text')`, [`bot_${email}`]);
      }
      socket.emit('logged_in', email);
    });
  });

  // ПОЛУЧИТЬ СПИСОК ЧАТОВ
  socket.on('get_chats', () => {
    if (!socket.email) return;
    db.all(`SELECT * FROM chats WHERE id = ? OR id LIKE ? OR id LIKE ? OR owner = ?`, 
      [`bot_${socket.email}`, `user_${socket.email}_%`, `user_%_${socket.email}`, socket.email], (err, rows) => {
      socket.emit('chats_list', rows || []);
    });
  });

  // СОЗДАТЬ ЧАТ
  socket.on('create_chat', ({ type, name, target }) => {
    if (!socket.email) return;
    let id = type === 'channel' ? `chan_${Date.now()}` : `user_${[socket.email, target].sort().join('_')}`;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner) VALUES (?, ?, ?, ?)`, [id, type, name, socket.email]);
    socket.emit('chat_created');
  });

  // ВОЙТИ В ЧАТ
  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => {
      socket.emit('messages_history', rows || []);
    });
  });

  // ОТПРАВИТЬ СООБЩЕНИЕ
  socket.on('send_message', ({ chatId, text, type, file_url }) => {
    if (!socket.email) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url) VALUES (?, ?, ?, ?, ?)`, 
      [chatId, socket.email, text || '', type, file_url || '']);
    
    io.to(chatId).emit('new_message', { chat_id: chatId, sender: socket.email, text, type, file_url });
  });

  // ПАНЕЛЬ СОЗДАТЕЛЯ
  socket.on('get_dev_data', () => {
    if (socket.email !== DEV_EMAIL) return;
    db.all(`SELECT * FROM users`, (err, users) => {
      db.all(`SELECT * FROM chats`, (err, chats) => {
        socket.emit('dev_data', { users, chats });
      });
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
