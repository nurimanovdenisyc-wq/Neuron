const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Раздаем статические файлы из корня
app.use(express.static(__dirname));

// ИСПРАВЛЕННЫЙ ПУТЬ: отдаем index.html из текущей папки
app.get('/', (req, res) => { 
  res.sendFile(path.resolve(process.cwd(), 'index.html')); 
});

const DEV_NICK = "keshaneironchik";
const db = new sqlite3.Database('./database.db');

// БАЗА ДАННЫХ
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (nick TEXT PRIMARY KEY, bio TEXT, avatar TEXT, stars INTEGER DEFAULT 0, premium_until INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner TEXT, members TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender TEXT, text TEXT, type TEXT, file_url TEXT, reply_to INTEGER, reactions TEXT, pinned INTEGER DEFAULT 0, ts INTEGER, forwarded_from TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS user_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_nick TEXT, gift_id TEXT, skin TEXT, ts INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS bots (nick TEXT PRIMARY KEY, owner TEXT, persona TEXT)`);
});

const GIFTS = {
  "rose": { name: "🌹 Роза", price: 1, skins: ["Классика", "Черная", "Золотая"] },
  "heart": { name: "❤️ Сердце", price: 3, skins: ["Красное", "Синее", "Неоновое"] },
  "bear": { name: "🧸 Мишка", price: 5, skins: ["Классика", "Панда", "Кибер"] },
  "umbrella": { name: "🌂 Зонтик", price: 10, skins: ["Обычный", "Прозрачный", "Радужный"] },
  "rocket": { name: "🚀 Ракета", price: 10, skins: ["Классика", "Золотая", "Темная"] },
  "crown": { name: "👑 Корона", price: 15, skins: ["Золотая", "Серебряная", "Алмазная"] },
  "beer": { name: "🍺 Пиво", price: 20, skins: ["Светлое", "Темное", "Зеленое"] },
  "cigarette": { name: "🚬 Сигарета", price: 20, skins: ["Обычная", "Ментол", "Красная"] },
  "chocolate": { name: "🍫 Шоколадка", price: 25, skins: ["Молочный", "Темный", "Белый"] },
  "web": { name: "🕸 Паутина", price: 25, skins: ["Обычная", "Огненная", "Ледяная"] },
  "sushi": { name: "🍣 Суши", price: 30, skins: ["Лосось", "Угорь", "Икра"] },
  "mushroom": { name: "🍄 Мухомор", price: 30, skins: ["Красный", "Синий", "Светящийся"] },
  "bouquet": { name: "💐 Букет", price: 50, skins: ["Весенний", "Осенний", "Неоновый"] },
  "cloud": { name: "☁️ Тучка", price: 50, skins: ["Белая", "Грозовая", "Розовая"] },
  "clover": { name: "🍀 Клевер", price: 100, skins: ["Зеленый", "Золотой", "Кристальный"] },
  "hat": { name: "🎩 Шляпа", price: 150, skins: ["Черная", "Белая", "Фиолетовая"] }
};

io.on('connection', (socket) => {
  socket.on('login_nick', (nick) => {
    socket.nick = nick.toLowerCase();
    db.get(`SELECT * FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (nick, bio) VALUES (?, 'Привет!')`, [socket.nick]);
        const botChatId = `bot_${socket.nick}`;
        db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`, [botChatId, socket.nick]);
        db.run(`INSERT INTO messages (chat_id, sender, text, type, ts) VALUES (?, 'Neuron Guide', 'Привет! Я Neuron Guide.', 'text', ?)`, [botChatId, Date.now()]);
      }
      socket.emit('logged_in', socket.nick);
    });
  });

  socket.on('get_profile', (nick) => {
    db.get(`SELECT * FROM users WHERE nick = ?`, [nick], (err, user) => {
      db.all(`SELECT gift_id, skin FROM user_gifts WHERE user_nick = ?`, [nick], (err, gifts) => {
        socket.emit('profile_data', { user, gifts, allGifts: GIFTS });
      });
    });
  });

  socket.on('update_profile', ({ avatar, bio }) => {
    db.run(`UPDATE users SET avatar = ?, bio = ? WHERE nick = ?`, [avatar, bio, socket.nick]);
    socket.emit('profile_updated');
  });

  socket.on('buy_premium', (plan) => {
    const prices = { 1: 1000, 3: 5000, 12: 50000 };
    const price = prices[plan];
    db.get(`SELECT stars, premium_until FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
      if (row.stars < price) return socket.emit('error', 'Недостаточно звезд!');
      const until = Math.max(Date.now(), row.premium_until) + (plan * 30 * 24 * 60 * 60 * 1000);
      db.run(`UPDATE users SET stars = stars - ?, premium_until = ? WHERE nick = ?`, [price, until, socket.nick]);
      socket.emit('premium_bought');
    });
  });

  socket.on('buy_gift', ({ to, giftId, skin }) => {
    const gift = GIFTS[giftId];
    if (!gift) return;
    db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
      if (row.stars < gift.price) return socket.emit('error', 'Мало звезд!');
      db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [gift.price, socket.nick]);
      db.run(`INSERT INTO user_gifts (user_nick, gift_id, skin, ts) VALUES (?, ?, ?, ?)`, [to, giftId, skin, Date.now()]);
      
      const giftMsg = `🎁 Подарок: ${gift.name} (${skin})`;
      const chatId = [socket.nick, to].sort().join('_');
      db.run(`INSERT INTO messages (chat_id, sender, text, type, ts) VALUES (?, ?, ?, 'gift', ?)`, [chatId, socket.nick, giftMsg, Date.now()]);
      io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: socket.nick, text: giftMsg, type: 'gift', ts: Date.now() });
      
      socket.emit('gift_bought');
    });
  });

  socket.on('add_stars', (amount) => {
    if (!socket.nick) return;
    db.run(`UPDATE users SET stars = stars + ? WHERE nick = ?`, [amount, socket.nick]);
    socket.emit('stars_updated');
  });

  socket.on('create_bot', ({ name, persona }) => {
    const botNick = name.toLowerCase().replace(/\s+/g, '_') + "_bot";
    db.run(`INSERT OR IGNORE INTO users (nick, bio) VALUES (?, 'Я бот!')`, [botNick]);
    db.run(`INSERT OR IGNORE INTO bots (nick, owner, persona) VALUES (?, ?, ?)`, [botNick, socket.nick, persona]);
    const chatId = `bot_${botNick}`;
    db.run(`INSERT OR IGNORE INTO chats (id, type, name, owner, members) VALUES (?, 'bot', ?, ?, ?)`, [chatId, name, socket.nick, socket.nick]);
    socket.emit('bot_created');
  });

  socket.on('get_chats', () => {
    db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, [socket.nick, `%${socket.nick}%`], (err, rows) => {
      const favorites = { id: `fav_${socket.nick}`, type: 'fav', name: 'Избранное', members: socket.nick };
      socket.emit('chats_list', [favorites, ...(rows || [])]);
    });
  });

  socket.on('join_chat', (chatId) => {
    socket.join(chatId);
    db.all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY ts ASC`, [chatId], (err, rows) => { socket.emit('messages_history', rows || []); });
  });

  socket.on('send_message', ({ chatId, text, type, file_url, reply_to, forwarded_from }) => {
    if (!socket.nick) return;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to, ts, forwarded_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
      [chatId, socket.nick, text || '', type, file_url || '', reply_to || null, Date.now(), forwarded_from || null], function() {
        io.to(chatId).emit('new_message', { id: this.lastID, chat_id: chatId, sender: socket.nick, text, type, file_url, reply_to, forwarded_from, reactions: null, pinned: 0, ts: Date.now() });
        
        if (chatId.includes("_bot")) {
          const botNick = chatId.replace("bot_", "");
          db.get(`SELECT persona FROM bots WHERE nick = ?`, [botNick], (err, bot) => {
            if (bot && text) {
              setTimeout(() => {
                const reply = `Бот (${bot.persona}) отвечает: ${text}`;
                db.run(`INSERT INTO messages (chat_id, sender, text, type, ts) VALUES (?, ?, ?, 'text', ?)`, [chatId, botNick, reply, Date.now()]);
                io.to(chatId).emit('new_message', { id: Date.now(), chat_id: chatId, sender: botNick, text: reply, type: 'text', ts: Date.now() });
              }, 1000);
            }
          });
        }
      });
  });

  socket.on('save_favorite', ({ text, type, file_url }) => {
    const chatId = `fav_${socket.nick}`;
    db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, ts) VALUES (?, ?, ?, ?, ?, ?)`, 
      [chatId, socket.nick, text, type, file_url || '', Date.now()], function() {
        socket.emit('favorite_saved');
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

  socket.on('pin_message', ({ chatId, msgId }) => {
    db.run(`UPDATE messages SET pinned = 0 WHERE chat_id = ?`, [chatId]);
    db.run(`UPDATE messages SET pinned = 1 WHERE id = ?`, [msgId]);
    io.to(chatId).emit('message_pinned', msgId);
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на ' + port));
