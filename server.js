const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const DEV_NICK = "keshaneironchik"; 
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (nick TEXT PRIMARY KEY, bio TEXT, last_seen INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner TEXT, members TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT, reply_to INTEGER, reactions TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY, owner TEXT, url TEXT)`);
});

const botReplies = [
  { keys: ["привет", "хай", "ку"], reply: "Привет! Я Neuron Guide. Чем помочь?" },
  { keys: ["помощь", "команды"], reply: "Я умею искать людей по нику, делать стикеры, отвечать на вопросы и звонить." },
  { keys: ["стикер"], reply: "Открой чат, нажми 😀 и добавь свой стикер по ссылке!" },
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
    
    db.get(`SELECT * FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (nick, bio) VALUES (?, ?)`, [socket.nick, "Привет!"]);
        const botChatId = `bot_${socket.nick}`;
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`, [botChatId, socket.nick]);
        db.run(`INSERT INTO messages (chat_id, sender, text, type) VALUES (?, 'Neuron Guide', 'Привет! Спроси меня о чем-нибудь.', 'text')`, [botChatId]);
      }
      socket.emit('logged_in', socket.nick);
    });
  });

  socket.on('search_users', (query) => {
    db.all(`SELECT nick FROM users WHERE nick LIKE ? AND nick != ?`, [`%${query}%`, socket.nick], (err, rows) => {
      socket.emit('search_results', rows || []);
    });
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.nick, `%${socket.nick}%`], (err, rows) => {
      // Определяем онлайн статус
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

  // Стикеры
  socket.on('add_sticker', (url) => {
    const id = `st_${Date.now()}`;
    db.run(`INSERT INTO stickers (id, owner, url) VALUES (?, ?, ?)`, [id, socket.nick, url]);
    socket.emit('sticker_added');
  });
  socket.on('get_stickers', () => {
    db.all(`SELECT url FROM stickers`, (err, rows) => { socket.emit('stickers_list', rows || []); });
  });

  // Звонки
  socket.on('call_user', ({ to, offer }) => io.emit('incoming_call', { from: socket.nick, offer }));
  socket.on('answer_call', ({ to, answer }) => io.emit('call_answered', { answer }));
  socket.on('ice_candidate', ({ candidate }) => io.emit('ice_candidate', { candidate }));
  socket.on('end_call', () => io.emit('call_ended'));

  // DEV
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
