const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let users = {};
let chats = {}; // { login: [ {id, name, messages: []} ] }

// Встроенный бот
const BOT_NAME = "Neuron Guide";
const BOT_REPLIES = [
  "Привет! Я твой помощник. Чем могу помочь?",
  "Чтобы начать, создай новый чат кнопкой + внизу.",
  "Я всегда здесь, если нужна помощь.",
  "Общайся с друзьями, кидай им логины, чтобы они тебя нашли.",
  "Ты можешь писать мне в любое время!"
];

io.on('connection', (socket) => {
  socket.on('register', ({ login, pass }) => {
    if (users[login]) return socket.emit('error', 'Логин занят');
    users[login] = pass;
    socket.emit('registered');
  });

  socket.on('login', ({ login, pass }) => {
    if (users[login] !== pass) return socket.emit('error', 'Неверный логин или пароль');
    socket.login = login;
    
    // Создаем базовый чат с ботом для нового пользователя
    if (!chats[login]) {
      chats[login] = [
        { id: "bot_" + Date.now(), name: "Neuron Guide", isBot: true, messages: [
          { from: "bot", text: "Привет! Я Neuron Guide. Я всегда на связи, если нужна помощь по мессенджеру!" }
        ]}
      ];
    }
    
    socket.emit('logged_in', login, chats[login]);
  });

  socket.on('get_chats', () => {
    if (socket.login) socket.emit('chats_list', chats[socket.login]);
  });

  socket.on('create_chat', (chatName) => {
    if (!socket.login || !chatName) return;
    const newChat = { id: Date.now().toString(), name: chatName, messages: [] };
    chats[socket.login].push(newChat);
    socket.emit('chat_created', newChat);
  });

  socket.on('private_message', ({ chatId, to, text }) => {
    if (!socket.login) return;
    
    // Ищем чат у отправителя
    let senderChat = chats[socket.login].find(c => c.id === chatId);
    if (senderChat) senderChat.messages.push({ from: socket.login, text });

    // Если это бот
    if (to === "bot") {
      socket.emit('new_message', { chatId, from: "bot", text: BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)] });
      return;
    }

    // Ищем получателя
    const targetUser = Object.keys(users).find(u => u === to);
    if (targetUser) {
      if (!chats[targetUser]) chats[targetUser] = [];
      let receiverChat = chats[targetUser].find(c => c.name === socket.login);
      if (!receiverChat) {
        receiverChat = { id: "from_" + socket.login, name: socket.login, messages: [] };
        chats[targetUser].push(receiverChat);
      }
      receiverChat.messages.push({ from: socket.login, text });
      
      // Отправляем получателю, если он онлайн
      io.emit('new_message', { chatId: receiverChat.id, from: socket.login, text, to: targetUser });
    }
    
    // Отправляем отправителю эхо
    socket.emit('new_message', { chatId, from: socket.login, text });
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен'));
