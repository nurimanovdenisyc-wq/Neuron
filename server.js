const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let users = {};
let onlineUsers = {};

io.on('connection', (socket) => {
  socket.on('register', ({ login, pass }) => {
    if (users[login]) return socket.emit('error', 'Логин занят');
    users[login] = pass;
    socket.emit('registered');
  });

  socket.on('login', ({ login, pass }) => {
    if (users[login] !== pass) return socket.emit('error', 'Неверный логин или пароль');
    socket.login = login;
    onlineUsers[socket.id] = login;
    socket.emit('logged_in', login);
    io.emit('users_list', Object.keys(users));
  });

  socket.on('get_users', () => {
    socket.emit('users_list', Object.keys(users));
  });

  socket.on('join_chat', (targetUser) => {
    const room = [socket.login, targetUser].sort().join('_');
    socket.join(room);
  });

  socket.on('leave_chat', () => {
    Object.keys(socket.rooms).forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
  });

  socket.on('private_message', ({ to, text }) => {
    const room = [socket.login, to].sort().join('_');
    io.to(room).emit('new_message', { from: socket.login, to: to, text: text });
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен на порту ' + port));
