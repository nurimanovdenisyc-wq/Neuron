const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Инициализация базы данных
const db = new sqlite3.Database('./database.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, pass TEXT, bio TEXT, avatar TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, bio TEXT, avatar TEXT, owner TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT)`);
});

io.on('connection', (socket) => {
  socket.on('register', ({ login, pass }) => {
    db.get(`SELECT * FROM users WHERE login = ?`, [login], (err, row) => {
      if (row) return socket.emit('error', 'Логин занят');
      db.run(`INSERT INTO users (login, pass, bio) VALUES (?, ?, ?)`, [login, pass, "Привет, я использую Neuron!"]);
      socket.emit('registered');
    });
  });

  socket.on('login', ({ login, pass }) => {
    db.get(`SELECT * FROM users WHERE login = ? AND pass = ?`, [login, pass], (err, row) => {
      if (!row) return socket.emit('error', 'Неверный логин или пароль');
      socket.login = login;
      
      // Создаем бота для нового пользователя, если его нет
      db.get(`SELECT * FROM chats WHERE id = ?`, [`bot_${login}`], (err, chat) => {
        if (!chat) {
          db.run(`INSERT INTO chats (id, type, name, bio, owner) VALUES (?, 'bot', 'Neuron Guide', 'Я твой помощник', 'system')`, [`bot_${login}`]);
          db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', 'Привет! Я Neuron Guide. Помогу освоиться.', 'text')`, [`bot_${login}`]);
        }
      });

      socket.emit('logged_in', row);
    });
  });

  // Поиск пользователей
  socket.on('search_users', (query) => {
    db.all(`SELECT login, bio, avatar FROM users WHERE login LIKE ? AND login != ?`, [`%${query}%`, socket.login], (err, rows) => {
      socket.emit('search_results', rows);
    });
  });

  // Получить все чаты пользователя
  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE id = ? OR id LIKE ? OR id LIKE ? OR owner = ?`, 
      [`bot_${socket.login}`, `user_${socket.login}_%`, `user_%_${socket.login}`, socket.login], (err, rows) => {
      socket.emit('chats_list', rows);
    });
  });

  // Создать чат (канал или личный)
  socket.on('create_chat', ({ type, name, target }) => {
    const id = type === 'channel' ? `chan_${Date.now()}` : `user_${[socket.login, target].sort().join('_')}`;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner) VALUES (?, ?, ?, ?)`, [id, type, name, socket.login]);
    socket.emit('chat_created', { id, type, name });
  });

  // Загрузка сообщений
  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => {
      socket.emit('messages_history', rows);
    });
  });

  // Отправка сообщений (текст)
  socket.on('send_message', ({ chatId, text, type, file_url }) => {
    if (!socket.login) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url) VALUES (?, ?, ?, ?, ?)`, 
      [chatId, socket.login, text || '', type, file_url || '']);
    
    io.to(chatId).emit('new_message', { sender: socket.login, text, type, file_url });
    
    // Если пишем боту
    if (chatId === `bot_${socket.login}`) {
      setTimeout(() => {
        const reply = "Я работаю на SQLite базе данных! Теперь аккаунты не сбрасываются.";
        db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', ?, 'text')`, [chatId, reply]);
        io.to(chatId).emit('new_message', { sender: 'Neuron Guide', text: reply, type: 'text' });
      }, 1000);
    }
  });

  // Обновление профиля
  socket.on('update_profile', ({ bio, avatar }) => {
    db.run(`UPDATE users SET bio = ?, avatar = ? WHERE login = ?`, [bio, avatar, socket.login]);
    socket.emit('profile_updated');
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен'));
