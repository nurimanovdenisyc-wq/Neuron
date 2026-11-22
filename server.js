const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

let users = {};

io.on('connection', (socket) => {
  socket.on('register', ({ login, pass }) => {
    if (users[login]) return socket.emit('error', 'Логин занят');
    users[login] = pass;
    socket.emit('registered');
  });

  socket.on('login', ({ login, pass }) => {
    if (users[login] !== pass) return socket.emit('error', 'Неверный логин или пароль');
    socket.login = login;
    socket.emit('logged_in', login);
    io.emit('system', `${login} зашел в чат`);
  });

  socket.on('message', (text) => {
    if (socket.login) io.emit('message', { user: socket.login, text });
  });

  socket.on('disconnect', () => {
    if (socket.login) io.emit('system', `${socket.login} вышел`);
  });
});

const port = process.env.PORT || 3000;
http.listen(port, () => console.log('Сервер запущен'));
