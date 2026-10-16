
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { registerSocialRoutes } = require('./social');

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PLATFORM_DIR = path.join(ROOT, 'platform');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const PUBLISHED_DIR = path.join(ROOT, 'published');

const ALLOWED_ORIGINS = [
  'https://denilsonjunior2027-gif.github.io'
];

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const temp = file + '.' + crypto.randomUUID() + '.tmp';

  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), {
      mode: 0o600
    });
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw error;
  }
}

let users = readJson(USERS_FILE, []);
let games = readJson(GAMES_FILE, []);

if (!Array.isArray(users)) users = [];
if (!Array.isArray(games)) games = [];

const sessions = new Map();
const rooms = new Map();

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');

// ======================================================
// CORS — GITHUB PAGES PARA RENDER
// ======================================================

const corsOptions = {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origem não autorizada.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

const io = new Server(server, {
  cors: corsOptions,
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});

// Middleware CORS precisa ficar antes das rotas.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return res.sendStatus(403);
    }

    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: '3mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ======================================================
// CONTAS E SESSÕES
// ======================================================

function cookieValue(req, key) {
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const i = part.indexOf('=');

    if (i > -1 && part.slice(0, i).trim() === key) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return '';
      }
    }
  }

  return '';
}

function currentUser(req) {
  const token = cookieValue(req, 'bw_session');
  const session = sessions.get(token);

  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }

  return users.find(user => user.id === session.userId) || null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username
  };
}

function requireUser(req, res, next) {
  const user = currentUser(req);

  if (!user) {
    return res.status(401).json({
      error: 'Entre na sua conta para continuar.'
    });
  }

  req.user = user;
  next();
}

function setSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    userId: user.id,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  });

  const production =
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true';

  // SameSite=None exige Secure nos navegadores modernos.
  const cookie = [
    `bw_session=${token}`,
    'HttpOnly',
    'SameSite=None',
    'Path=/',
    `Max-Age=${7 * 24 * 60 * 60}`,
    ...(production ? ['Secure'] : [])
  ].join('; ');

  res.setHeader('Set-Cookie', cookie);
}

function clearSession(req, res) {
  const token = cookieValue(req, 'bw_session');

  if (token) sessions.delete(token);

  const production =
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true';

  const cookie = [
    'bw_session=',
    'HttpOnly',
    'SameSite=None',
    'Path=/',
    'Max-Age=0',
    ...(production ? ['Secure'] : [])
  ].join('; ');

  res.setHeader('Set-Cookie', cookie);
}

function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString('hex')
) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function validUsername(name) {
  return typeof name === 'string' &&
    /^[\p{L}\p{N}_-]{3,24}$/u.test(name);
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

// ======================================================
// ESTADO E AUTENTICAÇÃO
// ======================================================

app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    jogadores: io.engine.clientsCount,
    jogos: games.length
  });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.post('/api/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;

  if (!validUsername(username)) {
    return res.status(400).json({
      error: 'O nome deve ter de 3 a 24 caracteres: letras, números, _ ou -.'
    });
  }

  if (typeof password !== 'string' ||
      password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: 'A senha deve ter entre 8 e 128 caracteres.'
    });
  }

  if (users.some(user =>
    user.username.toLowerCase() === username.toLowerCase()
  )) {
    return res.status(409).json({
      error: 'Esse nome de usuário já está em uso.'
    });
  }

  const credentials = hashPassword(password);

  const user = {
    id: crypto.randomUUID(),
    username,
    salt: credentials.salt,
    passwordHash: credentials.hash,
    createdAt: Date.now()
  };

  users.push(user);

  try {
    writeJson(USERS_FILE, users);
  } catch (error) {
    users = users.filter(entry => entry.id !== user.id);
    console.error('[REGISTER]', error);
    return res.status(500).json({
      error: 'Não foi possível salvar a conta.'
    });
  }

  setSession(res, user);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;

  const user = users.find(entry =>
    entry.username.toLowerCase() === username.toLowerCase()
  );

  if (!user || typeof password !== 'string' ||
      password.length > 128 ||
      typeof user.salt !== 'string' ||
      typeof user.passwordHash !== 'string') {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  let hash;

  try {
    hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  } catch {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');

  if (actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  setSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// ======================================================
// CATÁLOGO DE JOGOS
// ======================================================

app.get('/api/games', (req, res) => {
  const published = games
    .filter(game => game.published)
    .map(game => ({
      id: game.id,
      title: game.title,
      description: game.description,
      category: game.category,
      url: game.url,
      creator: game.creator,
      createdAt: game.createdAt,
      icon: game.icon,
      visits: Number.isSafeInteger(game.visits) && game.visits >= 0
        ? game.visits
        : 0
    }));

  res.json({ games: published });
});

app.post('/api/games/:id/visit', (req, res) => {
  const game = games.find(entry =>
    entry.id === req.params.id && entry.published
  );

  if (!game) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const oldVisits = Number.isSafeInteger(game.visits) && game.visits >= 0
    ? game.visits
    : 0;

  game.visits = oldVisits + 1;

  try {
    writeJson(GAMES_FILE, games);
    res.json({ ok: true, visits: game.visits });
  } catch (error) {
    game.visits = oldVisits;
    console.error('[VISITAS]', error);
    res.status(500).json({
      error: 'Não foi possível salvar a visita.'
    });
  }
});

app.post('/api/games', requireUser, (req, res) => {
  const title = typeof req.body?.title === 'string'
    ? req.body.title.trim() : '';

  const description = typeof req.body?.description === 'string'
    ? req.body.description.trim() : '';

  const category = typeof req.body?.category === 'string'
    ? req.body.category.trim() : 'Outro';

  const url = typeof req.body?.url === 'string'
    ? req.body.url.trim() : '';

  if (title.length < 2 || title.length > 60) {
    return res.status(400).json({
      error: 'O título precisa ter de 2 a 60 caracteres.'
    });
  }

  if (description.length < 5 || description.length > 500) {
    return res.status(400).json({
      error: 'A descrição precisa ter de 5 a 500 caracteres.'
    });
  }

  if (url && (!validHttpsUrl(url) || url.length > 500)) {
    return res.status(400).json({
      error: 'Use um link HTTPS válido para o jogo.'
    });
  }

  if (games.filter(game => game.creatorId === req.user.id).length >= 30) {
    return res.status(429).json({
      error: 'Você atingiu o limite de 30 publicações.'
    });
  }

  const categories = [
    'Aventura', 'Construção', 'Corrida',
    'Obby', 'Simulação', 'Outro'
  ];

  const game = {
    id: crypto.randomUUID(),
    title,
    description,
    category: categories.includes(category) ? category : 'Outro',
    url,
    creatorId: req.user.id,
    creator: req.user.username,
    createdAt: Date.now(),
    published: true,
    icon: '🎮'
  };

  games.unshift(game);

  try {
    writeJson(GAMES_FILE, games);
  } catch (error) {
    games = games.filter(entry => entry.id !== game.id);
    console.error('[JOGOS]', error);
    return res.status(500).json({
      error: 'Não foi possível salvar a publicação.'
    });
  }

  res.status(201).json({
    game: {
      id: game.id,
      title: game.title,
      description: game.description,
      category: game.category,
      url: game.url,
      creator: game.creator,
      createdAt: game.createdAt,
      icon: game.icon
    }
  });
});

app.delete('/api/games/:id', requireUser, (req, res) => {
  const game = games.find(entry => entry.id === req.params.id);

  if (!game) {
    return res.status(404).json({
      error: 'Jogo não encontrado.'
    });
  }

  if (game.creatorId !== req.user.id) {
    return res.status(403).json({
      error: 'Só o criador pode remover esta publicação.'
    });
  }

  const previous = games;
  games = games.filter(entry => entry.id !== game.id);

  try {
    writeJson(GAMES_FILE, games);
  } catch (error) {
    games = previous;
    console.error('[EXCLUSÃO]', error);
    return res.status(500).json({
      error: 'Não foi possível remover o jogo.'
    });
  }

  res.json({ ok: true });
});

// ======================================================
// PUBLICAÇÃO E EXECUÇÃO DE CENAS 3D
// ======================================================

function validScene(scene) {
  if (!scene || typeof scene !== 'object' ||
      !Array.isArray(scene.objects) ||
      scene.objects.length > 500) {
    return false;
  }

  const allowed = new Set([
    'Box', 'Sphere', 'Plane', 'Cylinder'
  ]);

  for (const object of scene.objects) {
    if (!object || typeof object !== 'object' ||
        !allowed.has(object.type)) {
      return false;
    }

    for (const key of ['position', 'rotation', 'scale']) {
      const value = object[key];

      if (!Array.isArray(value) || value.length !== 3 ||
          !value.every(number => Number.isFinite(Number(number)))) {
        return false;
      }
    }

    if (typeof object.color !== 'string' ||
        !/^#[0-9a-fA-F]{6}$/.test(object.color)) {
      return false;
    }

    if (object.name !== undefined &&
        (typeof object.name !== 'string' || object.name.length > 80)) {
      return false;
    }
  }

  return true;
}

app.post('/api/publish-scene', requireUser, (req, res) => {
  const title = typeof req.body?.title === 'string'
    ? req.body.title.trim() : '';

  const description = typeof req.body?.description === 'string'
    ? req.body.description.trim() : '';

  const category = typeof req.body?.category === 'string'
    ? req.body.category : 'Outro';

  const scene = req.body?.scene;

  if (title.length < 2 || title.length > 60) {
    return res.status(400).json({
      error: 'O título deve ter de 2 a 60 caracteres.'
    });
  }

  if (description.length < 5 || description.length > 500) {
    return res.status(400).json({
      error: 'A descrição deve ter de 5 a 500 caracteres.'
    });
  }

  if (!validScene(scene)) {
    return res.status(400).json({
      error: 'Cena inválida ou com mais de 500 objetos.'
    });
  }

  if (games.filter(game => game.creatorId === req.user.id).length >= 30) {
    return res.status(429).json({
      error: 'Limite de 30 publicações por conta.'
    });
  }

  const id = crypto.randomUUID();

  const safeScene = {
    version: 1,
    objects: scene.objects.map(object => ({
      type: object.type,
      name: String(object.name || object.type).slice(0, 80),
      position: object.position.map(Number),
      rotation: object.rotation.map(Number),
      scale: object.scale.map(number =>
        Math.max(0.05, Math.min(100, Number(number)))
      ),
      color: object.color
    }))
  };

  const categories = [
    'Aventura', 'Construção', 'Corrida',
    'Obby', 'Simulação', 'Outro'
  ];

  const game = {
    id,
    title,
    description,
    category: categories.includes(category) ? category : 'Outro',
    url: '/play/' + id,
    creatorId: req.user.id,
    creator: req.user.username,
    createdAt: Date.now(),
    published: true,
    icon: '🎮',
    sceneFile: id + '.json'
  };

  const scenePath = path.join(PUBLISHED_DIR, id + '.json');

  try {
    fs.writeFileSync(scenePath, JSON.stringify(safeScene), {
      flag: 'wx',
      mode: 0o600
    });

    games.unshift(game);
    writeJson(GAMES_FILE, games);
  } catch (error) {
    games = games.filter(entry => entry.id !== id);

    try {
      fs.unlinkSync(scenePath);
    } catch {}

    console.error('[PUBLICAR CENA]', error);

    return res.status(500).json({
      error: 'Não foi possível salvar a publicação.'
    });
  }

  res.status(201).json({
    game: {
      id,
      title,
      description,
      category: game.category,
      url: game.url,
      creator: game.creator,
      createdAt: game.createdAt,
      icon: game.icon,
      playUrl: game.url
    }
  });
});

app.get('/api/scenes/:id', (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const game = games.find(entry =>
    entry.id === req.params.id &&
    entry.published &&
    entry.sceneFile
  );

  if (!game) {
    return res.status(404).json({
      error: 'Jogo publicado não encontrado.'
    });
  }

  try {
    const file = path.join(PUBLISHED_DIR, game.sceneFile);
    const scene = JSON.parse(fs.readFileSync(file, 'utf8'));

    res.setHeader('Cache-Control', 'no-store');
    res.json(scene);
  } catch {
    res.status(404).json({
      error: 'Os dados deste jogo não foram encontrados.'
    });
  }
});

app.get('/play/:id', (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).send('ID inválido.');
  }

  const game = games.find(entry =>
    entry.id === req.params.id &&
    entry.published &&
    entry.sceneFile
  );

  if (!game) {
    return res.status(404).send('Jogo publicado não encontrado.');
  }

  res.sendFile(path.join(PLATFORM_DIR, 'play.html'));
});

// ======================================================
// EXPANSÃO: PERFIL, LOJA, AVATAR E ADMIN
// ======================================================

require('./blockworld-expansion')(app, {
  requireUser,
  users,
  writeJson,
  usersFile: USERS_FILE,
  getGames: () => games,
  saveGames: () => writeJson(GAMES_FILE, games)
});

app.locals.io = io;

// Dependências locais do motor 3D.
app.use(
  '/vendor/three',
  express.static(path.join(ROOT, 'node_modules', 'three'))
);

// Arquivos estáticos do site.
app.use(express.static(PLATFORM_DIR, {
  extensions: ['html'],
  index: 'index.html'
}));

// Páginas não encontradas voltam para a página inicial.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PLATFORM_DIR, 'index.html'));
});

// ======================================================
// MULTIPLAYER E AVATARES
// ======================================================

const DEFAULT_AVATAR = {
  skin: '#d9a078',
  hair: '#38251c',
  shirt: '#635bdb',
  pants: '#27344d'
};

function normalizeAvatar(value) {
  const result = {};

  for (const key of Object.keys(DEFAULT_AVATAR)) {
    const color = value && value[key];

    result[key] = typeof color === 'string' &&
      /^#[0-9a-f]{6}$/i.test(color)
      ? color
      : DEFAULT_AVATAR[key];
  }

  return result;
}

function socketUser(socket) {
  const token = socket.request.cookiesMap?.bw_session;
  const session = sessions.get(token);

  if (!session || session.expires < Date.now()) return null;

  return users.find(user => user.id === session.userId) || null;
}

io.use((socket, next) => {
  const cookies = {};

  for (const part of String(socket.request.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');

    if (index > 0) {
      try {
        cookies[part.slice(0, index).trim()] =
          decodeURIComponent(part.slice(index + 1).trim());
      } catch {}
    }
  }

  socket.request.cookiesMap = cookies;

  const user = socketUser(socket);

  if (!user) {
    return next(new Error('Faça login para usar o multiplayer.'));
  }

  socket.user = {
    ...publicUser(user),
    avatar: normalizeAvatar(user.avatar)
  };

  next();
});

const MAX_PLAYERS_PER_MATCH = 20;
const MAX_ACTIVE_MATCHES = 500;

function roomPlayer(socket) {
  return {
    id: socket.id,
    username: socket.user.username,
    x: 0,
    z: 0,
    rotation: 0,
    avatar: normalizeAvatar(socket.user.avatar)
  };
}

function roomList(room) {
  return [...room.players.values()];
}

function sendRoomJoined(socket, room) {
  socket.emit('roomJoined', {
    room: {
      code: room.id,
      gameId: room.gameId
    },
    players: roomList(room)
  });
}

function leaveSocketRoom(socket) {
  const id = socket.data.roomCode;

  if (!id) return;

  const room = rooms.get(id);

  socket.leave(id);
  socket.data.roomCode = null;

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(id);
    io.emit('roomClosed', { code: id });
    return;
  }

  socket.to(id).emit('playerLeft', socket.id);

  io.to(id).emit('roomInfo', {
    code: room.id,
    count: room.players.size
  });
}

io.on('connection', socket => {
  io.emit('onlineCount', io.engine.clientsCount);

  socket.on('findMatch', (payload = {}) => {
    const gameId = typeof payload.gameId === 'string'
      ? payload.gameId.slice(0, 80)
      : '';

    if (!gameId) {
      return socket.emit('roomError', 'Identificador de jogo inválido.');
    }

    if (!games.some(game => game && String(game.id) === gameId)) {
      return socket.emit('roomError', 'Jogo não encontrado no catálogo.');
    }

    const currentId = socket.data.roomCode;
    const currentRoom = currentId ? rooms.get(currentId) : null;

    if (currentRoom && currentRoom.gameId === gameId) {
      return sendRoomJoined(socket, currentRoom);
    }

    if (currentRoom) leaveSocketRoom(socket);

    let room = [...rooms.values()].find(candidate =>
      candidate.gameId === gameId &&
      candidate.players.size < MAX_PLAYERS_PER_MATCH
    );

    if (!room) {
      if (rooms.size >= MAX_ACTIVE_MATCHES) {
        return socket.emit(
          'roomError',
          'O servidor atingiu o limite de partidas. Tente novamente.'
        );
      }

      room = {
        id: crypto.randomUUID(),
        gameId,
        players: new Map(),
        createdAt: Date.now()
      };

      rooms.set(room.id, room);
    }

    const player = roomPlayer(socket);

    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.data.roomCode = room.id;

    sendRoomJoined(socket, room);
    socket.to(room.id).emit('playerJoined', player);

    io.to(room.id).emit('roomInfo', {
      code: room.id,
      count: room.players.size
    });
  });

  socket.on('move3d', (payload = {}) => {
    const id = socket.data.roomCode;
    const room = id ? rooms.get(id) : null;
    const player = room && room.players.get(socket.id);

    if (!player) return;

    const now = Date.now();

    if (socket.data.lastMoveAt &&
        now - socket.data.lastMoveAt < 40) {
      return;
    }

    const x = Number(payload.x);
    const z = Number(payload.z);
    const rotation = Number(payload.rotation);

    if (!Number.isFinite(x) ||
        !Number.isFinite(z) ||
        !Number.isFinite(rotation)) {
      return;
    }

    socket.data.lastMoveAt = now;

    player.x = Math.max(-500, Math.min(500, x));
    player.z = Math.max(-500, Math.min(500, z));
    player.rotation = Math.max(
      -Math.PI * 2,
      Math.min(Math.PI * 2, rotation)
    );

    socket.to(room.id).emit('playerMoved3d', {
      id: player.id,
      x: player.x,
      z: player.z,
      rotation: player.rotation
    });
  });

  socket.on('setAvatar', payload => {
    const user = users.find(entry => entry.id === socket.user.id);

    if (!user) {
      return socket.emit('roomError', 'Conta não encontrada.');
    }

    const avatar = normalizeAvatar(payload);

    try {
      user.avatar = avatar;
      writeJson(USERS_FILE, users);
      socket.user.avatar = avatar;

      const id = socket.data.roomCode;
      const room = id ? rooms.get(id) : null;
      const player = room && room.players.get(socket.id);

      if (player) {
        player.avatar = avatar;
        io.to(room.id).emit('playerUpdated', player);
      }

      socket.emit('avatarSaved', avatar);
    } catch (error) {
      console.error('[AVATAR]', error);
      socket.emit('roomError', 'Não foi possível salvar o avatar.');
    }
  });

  socket.on('leaveRoom', () => leaveSocketRoom(socket));

  socket.on('disconnect', () => {
    leaveSocketRoom(socket);
    io.emit('onlineCount', io.engine.clientsCount);
  });
});

// ======================================================
// LIMPEZA E INICIALIZAÇÃO
// ======================================================

setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sessions) {
    if (session.expires < now) sessions.delete(token);
  }

  for (const [code, room] of rooms) {
    if (now - room.createdAt > 6 * 60 * 60 * 1000 &&
        room.players.size === 0) {
      rooms.delete(code);
    }
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log('==================================');
  console.log('   BLOCKWORLD ONLINE');
  console.log(`   Porta: ${PORT}`);
  console.log('   CORS do GitHub Pages configurado');
  console.log('   Contas, publicações e salas carregadas');
  console.log('==================================');
});

// Erros não tratados nas rotas Express.
app.use((error, req, res, next) => {
  console.error('[SERVIDOR]', error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: 'Ocorreu um erro interno no servidor.'
  });
});
