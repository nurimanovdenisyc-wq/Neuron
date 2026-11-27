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

// Настройка папки для загрузок
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Настройка сессий
app.use(session({
    secret: process.env.SESSION_SECRET || 'neuron-secret-key-12345',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        httpOnly: true, 
        maxAge: 30 * 24 * 60 * 60 * 1000 
    }
}));

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^\w.]/g, '_');
        cb(null, Date.now() + '_' + safeName);
    }
});

const upload = multer({ 
    storage: storage, 
    limits: { fileSize: 25 * 1024 * 1024 } 
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }
    res.json({ url: '/uploads/' + req.file.filename });
});

// Константы и база данных
const DEV_NICK = "keshaneironchik";
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Создание таблиц
db.serialize(() => {
    // Таблица пользователей
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

    // Таблица администраторов
    db.run(`CREATE TABLE IF NOT EXISTS admins (
        nick TEXT PRIMARY KEY,
        until INTEGER
    )`);

    // Таблица чатов
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

    // Таблица сообщений
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

    // Таблица стикеров
    db.run(`CREATE TABLE IF NOT EXISTS stickers (
        id TEXT PRIMARY KEY,
        owner TEXT,
        url TEXT
    )`);

    // Таблица подарков (каталог)
    db.run(`CREATE TABLE IF NOT EXISTS gifts (
        id TEXT PRIMARY KEY,
        name TEXT,
        emoji TEXT,
        price INTEGER
    )`);

    // Таблица купленных/подаренных подарков
    db.run(`CREATE TABLE IF NOT EXISTS user_gifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT,
        gift_id TEXT,
        from_nick TEXT
    )`);

    // Таблица ботов
    db.run(`CREATE TABLE IF NOT EXISTS bots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT,
        name TEXT,
        avatar TEXT,
        bio TEXT,
        prompt TEXT
    )`);
});

// Каталог подарков
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
});

// Регистрация
app.post('/api/register', async (req, res) => {
    const { nick, password } = req.body;
    
    if (!nick || nick.length < 3) {
        return res.status(400).json({ error: 'Ник должен быть от 3 символов' });
    }
    if (!password || password.length < 4) {
        return res.status(400).json({ error: 'Пароль должен быть от 4 символов' });
    }

    const n = nick.toLowerCase();

    db.get(`SELECT nick FROM users WHERE nick = ?`, [n], async (err, row) => {
        if (row) {
            return res.status(409).json({ error: 'Этот ник уже занят' });
        }

        try {
            const hash = await bcrypt.hash(password, 10);
            
            db.run(`INSERT INTO users (nick, pass_hash, bio, last_seen) VALUES (?, ?, ?, ?)`,
                [n, hash, 'Привет! Я в Neuron.', Date.now()], () => {
                    
                    // Создаем базовые чаты
                    db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'bot', 'Neuron Guide', 'system', ?)`,
                        [`bot_${n}`, n]);
                    
                    db.run(`INSERT INTO chats (id, type, name, owner, members) VALUES (?, 'saved', 'Избранное', 'system', ?)`,
                        [`saved_${n}`, n]);

                    req.session.nick = n;
                    res.json({ ok: true, nick: n });
                });
        } catch (e) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
});

// Вход
app.post('/api/login', (req, res) => {
    const { nick, password } = req.body;
    const n = (nick || '').toLowerCase();

    db.get(`SELECT * FROM users WHERE nick = ?`, [n], async (err, row) => {
        if (!row || !row.pass_hash) {
            return res.status(401).json({ error: 'Неверный ник или пароль' });
        }
        if (row.is_banned) {
            return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });
        }

        const ok = await bcrypt.compare(password, row.pass_hash);
        if (!ok) {
            return res.status(401).json({ error: 'Неверный ник или пароль' });
        }

        req.session.nick = n;
        db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), n]);
        
        res.json({ ok: true, nick: n });
    });
});

// Проверка сессии
app.get('/api/me', (req, res) => {
    res.json({ nick: req.session.nick || null });
});

// Выход
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true });
    });
});

// Функция проверки прав администратора
function isAdmin(nick, callback) {
    if (nick === DEV_NICK) {
        return callback(true);
    }
    
    db.get(`SELECT until FROM admins WHERE nick = ?`, [nick], (err, row) => {
        if (!row) return callback(false);
        if (row.until === 0) return callback(true);
        if (row.until > Date.now()) return callback(true);
        callback(false);
    });
}

// Логика ответов ботов
function getBotReply(text, customPrompt) {
    const lower = text.toLowerCase();
    
    if (customPrompt) {
        return `[Бот с инструкцией: ${customPrompt}] Вы написали: "${text}"`;
    }
    
    if (lower.includes('привет')) {
        return "Привет! Я Neuron Guide. Чем помочь?";
    }
    if (lower.includes('стикер')) {
        return "Открой чат, нажми ➕ и добавь стикер из галереи!";
    }
    if (lower.includes('премиум')) {
        return "Нейрон Премиум дает 5 звезд в день, невидимку и крутые скины!";
    }
    
    return "Я пока не знаю ответа. Спроси про 'стикеры' или 'премиум'.";
}

// WebSocket соединение
io.on('connection', (socket) => {
    
    // Авторизация сокета
    socket.on('login_nick', (nick) => {
        if (!nick || nick.length < 3) return;
        socket.nick = nick.toLowerCase();
        db.run(`UPDATE users SET last_seen = ? WHERE nick = ?`, [Date.now(), socket.nick]);
        socket.emit('logged_in', socket.nick);
    });

    // Получение списка чатов
    socket.on('get_chats', () => {
        if (!socket.nick) return;
        
        db.all(`SELECT * FROM chats WHERE owner = ? OR members LIKE ?`, 
            [socket.nick, `%${socket.nick}%`], (err, rows) => {
            socket.emit('chats_list', rows || []);
        });
    });

    // Вход в чат
    socket.on('join_chat', (chatId) => {
        if (!socket.nick) return;
        socket.join(chatId);
        
        db.all(`SELECT * FROM messages WHERE chat_id = ?`, [chatId], (err, rows) => {
            socket.emit('messages_history', rows || []);
        });
    });

    // Отправка сообщения
    socket.on('send_message', ({ chatId, text, type, file_url, reply_to }) => {
        if (!socket.nick) return;
        
        const now = Date.now();
        
        db.run(`INSERT INTO messages (chat_id, sender, text, type, file_url, reply_to, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [chatId, socket.nick, text || '', type, file_url || '', reply_to || null, now], function() {
            
            const msg = {
                id: this.lastID,
                chat_id: chatId,
                sender: socket.nick,
                text: text,
                type: type,
                file_url: file_url,
                reply_to: reply_to,
                timestamp: now
            };
            
            io.to(chatId).emit('new_message', msg);
            
            // Автоответ бота
            if (chatId.startsWith('bot_') && type === 'text') {
                const botName = chatId.replace('bot_', '');
                db.get(`SELECT prompt FROM bots WHERE owner = ? AND name = ?`, [socket.nick, botName], (e, bot) => {
                    const replyText = getBotReply(text, bot ? bot.prompt : null);
                    
                    setTimeout(() => {
                        db.run(`INSERT INTO messages (chat_id, sender, text, type, timestamp) VALUES (?, ?, ?, 'text', ?)`,
                            [chatId, botName, replyText, Date.now()]);
                        
                        io.to(chatId).emit('new_message', {
                            id: Date.now(),
                            chat_id: chatId,
                            sender: botName,
                            text: replyText,
                            type: 'text',
                            timestamp: Date.now()
                        });
                    }, 1000);
                });
            }
        });
    });

    // Получение профиля
    socket.on('get_profile', (nick) => {
        if (!nick) return;
        
        db.get(`SELECT * FROM users WHERE nick = ?`, [nick.toLowerCase()], (err, row) => {
            if (!row) return socket.emit('profile_data', null);
            
            db.all(`SELECT g.emoji, g.name FROM user_gifts u JOIN gifts g ON g.id = u.gift_id WHERE u.owner = ?`, 
                [row.nick], (e, gifts) => {
                socket.emit('profile_data', { 
                    ...row, 
                    gifts: gifts || [] 
                });
            });
        });
    });

    // Обновление профиля
    socket.on('update_profile', ({ bio, avatar, nick_color, profile_bg, invisible }) => {
        if (!socket.nick) return;
        
        db.get(`SELECT premium_until FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
            const isPremium = row && row.premium_until > Date.now();
            
            const finalColor = isPremium && nick_color ? nick_color : 'default';
            const finalBg = isPremium && profile_bg ? profile_bg : '';
            const finalInvisible = isPremium && invisible ? 1 : 0;
            
            db.run(`UPDATE users SET bio = ?, avatar = ?, nick_color = ?, profile_bg = ?, invisible = ? WHERE nick = ?`,
                [bio || '', avatar || '', finalColor, finalBg, finalInvisible, socket.nick]);
            
            socket.emit('profile_updated');
        });
    });

    // Покупка подарка
    socket.on('buy_gift', ({ giftId }) => {
        if (!socket.nick) return;
        
        db.get(`SELECT price FROM gifts WHERE id = ?`, [giftId], (err, gift) => {
            if (!gift) return;
            
            db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e, user) => {
                if (!user || user.stars < gift.price) {
                    return socket.emit('gift_error', 'Недостаточно звезд');
                }
                
                db.run(`UPDATE users SET stars = stars - ? WHERE nick = ?`, [gift.price, socket.nick]);
                db.run(`INSERT INTO user_gifts (owner, gift_id, from_nick) VALUES (?, ?, ?)`, 
                    [socket.nick, giftId, socket.nick]);
                
                socket.emit('gift_bought');
            });
        });
    });

    // Получение каталога подарков
    socket.on('get_gifts', () => {
        if (!socket.nick) return;
        
        db.all(`SELECT * FROM gifts ORDER BY price ASC`, (err, gifts) => {
            db.get(`SELECT stars FROM users WHERE nick = ?`, [socket.nick], (e, user) => {
                socket.emit('gifts_data', { 
                    gifts: gifts || [], 
                    stars: user ? user.stars : 0 
                });
            });
        });
    });

    // Покупка премиума
    socket.on('buy_premium', ({ plan }) => {
        if (!socket.nick) return;
        
        let days = 30;
        let cost = 1000;
        
        if (plan === '3months') { days = 90; cost = 5000; }
        if (plan === 'year') { days = 365; cost = 50000; }
        
        db.get(`SELECT stars, premium_until FROM users WHERE nick = ?`, [socket.nick], (err, row) => {
            if (!row || row.stars < cost) {
                return socket.emit('gift_error', 'Недостаточно звезд');
            }
            
            const now = Date.now();
            const currentPremium = row.premium_until > now ? row.premium_until : now;
            const newPremium = currentPremium + (days * 24 * 60 * 60 * 1000);
            
            db.run(`UPDATE users SET stars = stars - ?, premium_until = ? WHERE nick = ?`, 
                [cost, newPremium, socket.nick]);
            
            socket.emit('premium_bought');
        });
    });

    // Получение админ-панели
    socket.on('get_dev_data', () => {
        isAdmin(socket.nick, (ok) => {
            if (!ok) return;
            
            db.all(`SELECT nick FROM users`, (err, users) => {
                db.all(`SELECT * FROM admins`, (e, admins) => {
                    socket.emit('dev_data', { users: users || [], admins: admins || [] });
                });
            });
        });
    });

    // Выдача админки
    socket.on('give_admin', ({ target, minutes }) => {
        isAdmin(socket.nick, (ok) => {
            if (!ok) return;
            
            let until = 0;
            if (minutes > 0) {
                until = Date.now() + (minutes * 60 * 1000);
            }
            
            db.run(`INSERT OR REPLACE INTO admins (nick, until) VALUES (?, ?)`, [target, until]);
            socket.emit('admin_given');
        });
    });
});

// Запуск сервера
const port = process.env.PORT || 3000;
http.listen(port, '0.0.0.0', () => {
    console.log('Сервер Neuron запущен на порту ' + port);
});
