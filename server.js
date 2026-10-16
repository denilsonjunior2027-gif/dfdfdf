'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { registerSocialRoutes } = require('./social');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const PLATFORM_DIR = path.join(ROOT, 'platform');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const temp = file + '.tmp';

  fs.writeFileSync(
    temp,
    JSON.stringify(data, null, 2),
    { mode: 0o600 }
  );

  fs.renameSync(temp, file);
}

let users = readJson(USERS_FILE, []);
let games = readJson(GAMES_FILE, []);

const sessions = new Map();
const rooms = new Map();

const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN ||
  'https://blockworldm.netlify.app';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST']
  },

  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});

app.disable('x-powered-by');

// CORS: permite que o frontend Netlify acesse o backend Render.
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === FRONTEND_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(
      origin === FRONTEND_ORIGIN ? 204 : 403
    );
  }

  next();
});

app.use(express.json({ limit: '3mb' }));

// Registro de tentativas de login e cadastro para diagnóstico.
app.use((req, res, next) => {
  if (
    req.path === '/api/login' ||
    req.path === '/api/register'
  ) {
    console.log(`[AUTH API] ${req.method} ${req.path}`);
  }

  next();
});

// Cabeçalhos básicos de segurança.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.setHeader(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  next();
});

// Disponibiliza os arquivos da plataforma.
app.use(express.static(PLATFORM_DIR, {
  extensions: ['html'],
  index: 'index.html'
}));

function cookieValue(req, key) {
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const i = part.indexOf('=');

    if (
      i > -1 &&
      part.slice(0, i).trim() === key
    ) {
      return decodeURIComponent(
        part.slice(i + 1).trim()
      );
    }
  }

  return '';
}

function currentUser(req) {
  const token = cookieValue(req, 'bw_session');
  const session = sessions.get(token);

  if (!session || session.expires < Date.now()) {
    if (token) {
      sessions.delete(token);
    }

    return null;
  }

  return users.find(
    user => user.id === session.userId
  ) || null;
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

// Registra as rotas do sistema social.
registerSocialRoutes({
  app,
  requireUser,
  users,
  writeJson,
  dataDir: DATA_DIR,
  usersFile: USERS_FILE
});

// Cria a sessão do usuário.
function setSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    userId: user.id,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  });

  res.setHeader(
    'Set-Cookie',
    `bw_session=${token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${7 * 24 * 60 * 60}`
  );
}

// Encerra a sessão.
function clearSession(req, res) {
  const token = cookieValue(req, 'bw_session');

  if (token) {
    sessions.delete(token);
  }

  res.setHeader(
    'Set-Cookie',
    'bw_session=; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=0'
  );
}

// Protege as senhas com scrypt.
function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString('hex')
) {
  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString('hex');

  return { salt, hash };
}

function validUsername(name) {
  return typeof name === 'string' &&
    /^[\p{L}\p{N}_-]{3,24}$/u.test(name);
}

// Verifica se o backend está funcionando.
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    jogadores: io.engine.clientsCount,
    jogos: games.length
  });
});

// Retorna a conta conectada.
app.get('/api/me', (req, res) => {
  const user = currentUser(req);

  res.json({
    user: user ? publicUser(user) : null
  });
});

// Cadastro de usuários.
app.post('/api/register', (req, res) => {
  const username = String(
    req.body?.username || ''
  ).trim();

  const password = req.body?.password;

  if (!validUsername(username)) {
    return res.status(400).json({
      error:
        'O nome deve ter 3 a 24 caracteres: letras, números, _ ou -.'
    });
  }

  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128
  ) {
    return res.status(400).json({
      error: 'A senha deve ter entre 8 e 128 caracteres.'
    });
  }

  if (
    users.some(
      user =>
        user.username.toLowerCase() ===
        username.toLowerCase()
    )
  ) {
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
  writeJson(USERS_FILE, users);

  setSession(res, user);

  res.status(201).json({
    user: publicUser(user)
  });
});

// Login de usuários.
app.post('/api/login', (req, res) => {
  const username = String(
    req.body?.username || ''
  ).trim();

  const password = req.body?.password;

  const user = users.find(
    entry =>
      entry.username.toLowerCase() ===
      username.toLowerCase()
  );

  if (
    !user ||
    typeof password !== 'string' ||
    password.length > 128
  ) {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  const hash = crypto
    .scryptSync(password, user.salt, 64)
    .toString('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  setSession(res, user);

  res.json({
    user: publicUser(user)
  });
});

// Logout.
app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

console.log(
  '[AUTH API] Rotas registradas: POST /api/login e POST /api/register'
);

console.log(
  `[AUTH API] Origem permitida do frontend: ${FRONTEND_ORIGIN}`
);

console.log(
  '[AUTH API] Use a URL do Render nas chamadas fetch da interface Netlify.'
);// =============================================
// LISTAR JOGOS PUBLICADOS
// =============================================

app.get('/api/games', (req, res) => {
  const publicados = games
    .filter(g => g.published)
    .map(g => ({
      id: g.id,
      title: g.title,
      description: g.description,
      category: g.category,
      url: g.url,
      creator: g.creator,
      createdAt: g.createdAt,
      icon: g.icon,
      visits:
        Number.isSafeInteger(g.visits) && g.visits >= 0
          ? g.visits
          : 0
    }));

  res.json({ games: publicados });
});

// =============================================
// CONTAR VISITAS DOS JOGOS
// =============================================

app.post('/api/games/:id/visit', (req, res) => {
  const game = games.find(
    g => g.id === req.params.id && g.published
  );

  if (!game) {
    return res.status(404).json({
      error: 'Jogo não encontrado.'
    });
  }

  game.visits =
    Number.isSafeInteger(game.visits) && game.visits >= 0
      ? game.visits
      : 0;

  game.visits += 1;

  try {
    writeJson(GAMES_FILE, games);

    res.json({
      ok: true,
      visits: game.visits
    });
  } catch (error) {
    game.visits -= 1;

    console.error('[VISITAS] Falha ao salvar:', error);

    res.status(500).json({
      error: 'Não foi possível salvar a visita.'
    });
  }
});

// =============================================
// VALIDAR LINKS HTTPS
// =============================================

function validHttpsUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

// =============================================
// PUBLICAR JOGOS
// =============================================

app.post('/api/games', requireUser, (req, res) => {
  const title =
    typeof req.body?.title === 'string'
      ? req.body.title.trim()
      : '';

  const description =
    typeof req.body?.description === 'string'
      ? req.body.description.trim()
      : '';

  const category =
    typeof req.body?.category === 'string'
      ? req.body.category.trim()
      : 'Outro';

  const url =
    typeof req.body?.url === 'string'
      ? req.body.url.trim()
      : '';

  if (title.length < 2 || title.length > 60) {
    return res.status(400).json({
      error: 'O título precisa ter de 2 a 60 caracteres.'
    });
  }

  if (
    description.length < 5 ||
    description.length > 500
  ) {
    return res.status(400).json({
      error: 'A descrição precisa ter de 5 a 500 caracteres.'
    });
  }

  if (
    url &&
    (
      !/^https:\/\//i.test(url) ||
      url.length > 500 ||
      !validHttpsUrl(url)
    )
  ) {
    return res.status(400).json({
      error: 'Use um link HTTPS válido para o jogo.'
    });
  }

  const publicacoesDoUsuario = games.filter(
    g => g.creatorId === req.user.id
  );

  if (publicacoesDoUsuario.length >= 30) {
    return res.status(429).json({
      error: 'Você atingiu o limite de 30 publicações nesta versão.'
    });
  }

  const game = {
    id: crypto.randomUUID(),
    title,
    description,

    category: [
      'Aventura',
      'Construção',
      'Corrida',
      'Obby',
      'Simulação',
      'Outro'
    ].includes(category)
      ? category
      : 'Outro',

    url,
    creatorId: req.user.id,
    creator: req.user.username,
    createdAt: Date.now(),
    published: true,
    icon: '🎮'
  };

  games.unshift(game);
  writeJson(GAMES_FILE, games);

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

// =============================================
// REMOVER PUBLICAÇÕES
// =============================================

app.delete(
  '/api/games/:id',
  requireUser,
  (req, res) => {
    const game = games.find(
      g => g.id === req.params.id
    );

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

    games = games.filter(g => g.id !== game.id);

    writeJson(GAMES_FILE, games);

    res.json({ ok: true });
  }
);

// =============================================
// BLOCKWORLD: PUBLICAÇÃO DE CENAS 3D
// =============================================

const PUBLISHED_DIR = path.join(ROOT, 'published');

fs.mkdirSync(PUBLISHED_DIR, {
  recursive: true
});

// Verifica o formato da cena antes de salvar.
function validScene(scene) {
  if (
    !scene ||
    typeof scene !== 'object' ||
    !Array.isArray(scene.objects)
  ) {
    return false;
  }

  if (scene.objects.length > 500) {
    return false;
  }

  const allowed = new Set([
    'Box',
    'Sphere',
    'Plane',
    'Cylinder'
  ]);

  for (const o of scene.objects) {
    if (
      !o ||
      typeof o !== 'object' ||
      !allowed.has(o.type)
    ) {
      return false;
    }

    for (const key of [
      'position',
      'rotation',
      'scale'
    ]) {
      const v = o[key];

      if (
        !Array.isArray(v) ||
        v.length !== 3 ||
        !v.every(n => Number.isFinite(Number(n)))
      ) {
        return false;
      }
    }

    if (
      typeof o.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(o.color)
    ) {
      return false;
    }

    if (
      o.name !== undefined &&
      (
        typeof o.name !== 'string' ||
        o.name.length > 80
      )
    ) {
      return false;
    }
  }

  return true;
}

// =============================================
// PUBLICAR UMA CENA 3D
// =============================================

app.post(
  '/api/publish-scene',
  requireUser,
  (req, res) => {
    const title =
      typeof req.body?.title === 'string'
        ? req.body.title.trim()
        : '';

    const description =
      typeof req.body?.description === 'string'
        ? req.body.description.trim()
        : '';

    const category =
      typeof req.body?.category === 'string'
        ? req.body.category
        : 'Outro';

    const scene = req.body?.scene;

    if (title.length < 2 || title.length > 60) {
      return res.status(400).json({
        error: 'O título deve ter de 2 a 60 caracteres.'
      });
    }

    if (
      description.length < 5 ||
      description.length > 500
    ) {
      return res.status(400).json({
        error: 'A descrição deve ter de 5 a 500 caracteres.'
      });
    }

    if (!validScene(scene)) {
      return res.status(400).json({
        error:
          'Cena inválida. Use o formato JSON esperado e no máximo 500 objetos compatíveis.'
      });
    }

    const publicacoesDoUsuario = games.filter(
      g => g.creatorId === req.user.id
    );

    if (publicacoesDoUsuario.length >= 30) {
      return res.status(429).json({
        error: 'Limite de 30 publicações por conta.'
      });
    }

    const id = crypto.randomUUID();

    const safeScene = {
      version: 1,

      objects: scene.objects.map(o => ({
        type: o.type,

        name: String(
          o.name || o.type
        ).slice(0, 80),

        position: o.position.map(Number),

        rotation: o.rotation.map(Number),

        scale: o.scale.map(n =>
          Math.max(
            0.05,
            Math.min(100, Number(n))
          )
        ),

        color: o.color
      }))
    };

    const game = {
      id,
      title,
      description,

      category: [
        'Aventura',
        'Construção',
        'Corrida',
        'Obby',
        'Simulação',
        'Outro'
      ].includes(category)
        ? category
        : 'Outro',

      url: '/play/' + id,
      creatorId: req.user.id,
      creator: req.user.username,
      createdAt: Date.now(),
      published: true,
      icon: '🎮',
      sceneFile: id + '.json'
    };

    const scenePath = path.join(
      PUBLISHED_DIR,
      id + '.json'
    );

    try {
      fs.writeFileSync(
        scenePath,
        JSON.stringify(safeScene),
        {
          flag: 'wx',
          mode: 0o600
        }
      );

      games.unshift(game);

      writeJson(GAMES_FILE, games);
    } catch (error) {
      try {
        fs.unlinkSync(scenePath);
      } catch {}

      console.error(
        '[PUBLICAÇÃO] Erro ao salvar cena:',
        error
      );

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
  }
);

// =============================================
// CARREGAR CENA PUBLICADA
// =============================================

app.get('/api/scenes/:id', (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({
      error: 'ID inválido.'
    });
  }

  const game = games.find(
    g =>
      g.id === req.params.id &&
      g.published &&
      g.sceneFile
  );

  if (!game) {
    return res.status(404).json({
      error: 'Jogo publicado não encontrado.'
    });
  }

  try {
    res.setHeader('Cache-Control', 'no-store');

    const scenePath = path.join(
      PUBLISHED_DIR,
      game.sceneFile
    );

    const scene = JSON.parse(
      fs.readFileSync(scenePath, 'utf8')
    );

    res.json(scene);
  } catch {
    res.status(404).json({
      error: 'Os dados deste jogo não foram encontrados.'
    });
  }
});

// =============================================
// ABRIR A PÁGINA DE UM JOGO PUBLICADO
// =============================================

app.get('/play/:id', (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).send('ID inválido.');
  }

  const game = games.find(
    g =>
      g.id === req.params.id &&
      g.published &&
      g.sceneFile
  );

  if (!game) {
    return res.status(404).send(
      'Jogo publicado não encontrado.'
    );
  }

  res.sendFile(
    path.join(PLATFORM_DIR, 'play.html')
  );
});

// =============================================
// FIM DA PUBLICAÇÃO DE CENAS
// =============================================// =============================================
// TRATAMENTO DE ROTAS INEXISTENTES
// =============================================

app.use(/^\/api(?:\/|$)/, (req, res) => {
  console.warn(
    `[API 404] ${req.method} ${req.originalUrl}`
  );

  res.status(404).json({
    error: 'Rota da API não encontrada.',
    method: req.method,
    path: req.originalUrl
  });
});

// =============================================
// ARQUIVOS DA BIBLIOTECA THREE.JS
// =============================================

app.use(
  '/vendor/three',
  express.static(
    path.join(ROOT, 'node_modules', 'three')
  )
);

// =============================================
// PÁGINA PRINCIPAL DA PLATAFORMA
// =============================================

app.get(/.*/, (req, res) => {
  res.sendFile(
    path.join(PLATFORM_DIR, 'index.html')
  );
});

// =============================================
// AUTENTICAÇÃO DO MULTIPLAYER
// =============================================

function socketUser(socket) {
  const token =
    socket.request.cookiesMap?.bw_session;

  const session = sessions.get(token);

  if (
    !session ||
    session.expires < Date.now()
  ) {
    return null;
  }

  return users.find(
    user => user.id === session.userId
  ) || null;
}

// Lê o cookie da sessão antes de conectar.
io.use((socket, next) => {
  const cookies = {};

  const cookieHeader =
    socket.request.headers.cookie || '';

  for (const part of String(cookieHeader).split(';')) {
    const i = part.indexOf('=');

    if (i > 0) {
      const key = part.slice(0, i).trim();
      const value = part.slice(i + 1).trim();

      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }

  socket.request.cookiesMap = cookies;

  const user = socketUser(socket);

  if (!user) {
    return next(
      new Error('Faça login para usar o multiplayer.')
    );
  }

  socket.user = {
    ...publicUser(user),
    avatar: normalizeAvatar(user.avatar)
  };

  next();
});

// =============================================
// CONFIGURAÇÕES DO MULTIPLAYER
// =============================================

const MAX_PLAYERS_PER_MATCH = 20;
const MAX_ACTIVE_MATCHES = 500;

const DEFAULT_AVATAR = {
  skin: '#d9a078',
  hair: '#38251c',
  shirt: '#635bdb',
  pants: '#27344d'
};

// =============================================
// VALIDAR AS CORES DO AVATAR
// =============================================

function normalizeAvatar(value) {
  const result = {};

  for (const key of Object.keys(DEFAULT_AVATAR)) {
    const color = value && value[key];

    result[key] =
      typeof color === 'string' &&
      /^#[0-9a-f]{6}$/i.test(color)
        ? color
        : DEFAULT_AVATAR[key];
  }

  return result;
}

// =============================================
// CRIAR DADOS DO JOGADOR
// =============================================

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

// =============================================
// LISTAR JOGADORES DA SALA
// =============================================

function roomList(room) {
  return [...room.players.values()];
}

// =============================================
// INFORMAR ENTRADA NA SALA
// =============================================

function sendRoomJoined(socket, room) {
  socket.emit('roomJoined', {
    room: {
      code: room.id,
      gameId: room.gameId
    },

    players: roomList(room)
  });
}

// =============================================
// REMOVER JOGADOR DE UMA SALA
// =============================================

function leaveSocketRoom(socket) {
  const id = socket.data.roomCode;

  if (!id) {
    return;
  }

  const room = rooms.get(id);

  socket.leave(id);
  socket.data.roomCode = null;

  if (!room) {
    return;
  }

  room.players.delete(socket.id);

  // Apaga salas vazias.
  if (room.players.size === 0) {
    rooms.delete(id);

    io.emit('roomClosed', {
      code: id
    });

    return;
  }

  // Informa os demais jogadores.
  socket.to(id).emit(
    'playerLeft',
    socket.id
  );

  io.to(id).emit('roomInfo', {
    code: room.id,
    count: room.players.size
  });
}// =============================================
// EVENTOS DO MULTIPLAYER
// =============================================

io.on('connection', socket => {
  console.log(
    `[MULTIPLAYER] ${socket.user.username} conectou.`
  );

  io.emit(
    'onlineCount',
    io.engine.clientsCount
  );

  // ===========================================
  // ENCONTRAR OU CRIAR UMA PARTIDA
  // ===========================================

  socket.on('findMatch', (payload = {}) => {
    const gameId =
      typeof payload.gameId === 'string'
        ? payload.gameId.slice(0, 80)
        : '';

    if (!gameId) {
      socket.emit(
        'roomError',
        'Identificador de jogo inválido.'
      );

      return;
    }

    const gameExists = games.some(
      game =>
        game &&
        String(game.id) === gameId
    );

    if (!gameExists) {
      socket.emit(
        'roomError',
        'Jogo não encontrado no catálogo.'
      );

      return;
    }

    const currentId = socket.data.roomCode;

    const currentRoom = currentId
      ? rooms.get(currentId)
      : null;

    if (
      currentRoom &&
      currentRoom.gameId === gameId
    ) {
      sendRoomJoined(socket, currentRoom);
      return;
    }

    if (currentRoom) {
      leaveSocketRoom(socket);
    }

    // Procura uma sala disponível para o mesmo jogo.
    let room = [...rooms.values()].find(
      candidate =>
        candidate.gameId === gameId &&
        candidate.players.size <
          MAX_PLAYERS_PER_MATCH
    );

    // Se não houver sala, cria uma.
    if (!room) {
      if (rooms.size >= MAX_ACTIVE_MATCHES) {
        socket.emit(
          'roomError',
          'O servidor atingiu o limite de partidas. Tente novamente.'
        );

        return;
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

    socket.to(room.id).emit(
      'playerJoined',
      player
    );

    io.to(room.id).emit('roomInfo', {
      code: room.id,
      count: room.players.size
    });

    console.log(
      `[MULTIPLAYER] ${socket.user.username} entrou na sala ${room.id}`
    );
  });

  // ===========================================
  // MOVIMENTAÇÃO 3D
  // ===========================================

  socket.on('move3d', (payload = {}) => {
    const id = socket.data.roomCode;

    const room = id
      ? rooms.get(id)
      : null;

    const player = room
      ? room.players.get(socket.id)
      : null;

    if (!player) {
      return;
    }

    const now = Date.now();

    // Limita a frequência das atualizações.
    if (
      socket.data.lastMoveAt &&
      now - socket.data.lastMoveAt < 40
    ) {
      return;
    }

    const x = Number(payload.x);
    const z = Number(payload.z);
    const rotation = Number(payload.rotation);

    if (
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(rotation)
    ) {
      return;
    }

    socket.data.lastMoveAt = now;

    player.x = Math.max(
      -500,
      Math.min(500, x)
    );

    player.z = Math.max(
      -500,
      Math.min(500, z)
    );

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

  // ===========================================
  // SALVAR AVATAR
  // ===========================================

  socket.on('setAvatar', payload => {
    const user = users.find(
      entry => entry.id === socket.user.id
    );

    if (!user) {
      socket.emit(
        'roomError',
        'Conta não encontrada.'
      );

      return;
    }

    const avatar = normalizeAvatar(payload);

    try {
      user.avatar = avatar;

      writeJson(USERS_FILE, users);

      socket.user.avatar = avatar;

      const id = socket.data.roomCode;

      const room = id
        ? rooms.get(id)
        : null;

      const player = room
        ? room.players.get(socket.id)
        : null;

      if (player) {
        player.avatar = avatar;

        io.to(room.id).emit(
          'playerUpdated',
          player
        );
      }

      socket.emit(
        'avatarSaved',
        avatar
      );
    } catch (error) {
      console.error(
        '[AVATAR] Erro ao salvar:',
        error
      );

      socket.emit(
        'roomError',
        'Não foi possível salvar o avatar.'
      );
    }
  });

  // ===========================================
  // SAIR DA SALA
  // ===========================================

  socket.on('leaveRoom', () => {
    leaveSocketRoom(socket);
  });

  // ===========================================
  // DESCONECTAR JOGADOR
  // ===========================================

  socket.on('disconnect', reason => {
    console.log(
      `[MULTIPLAYER] ${socket.user.username} desconectou: ${reason}`
    );

    leaveSocketRoom(socket);

    io.emit(
      'onlineCount',
      io.engine.clientsCount
    );
  });
});

// =============================================
// LIMPEZA AUTOMÁTICA
// =============================================

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  // Remove sessões expiradas.
  for (const [token, session] of sessions) {
    if (session.expires < now) {
      sessions.delete(token);
    }
  }

  // Remove salas antigas e vazias.
  for (const [code, room] of rooms) {
    if (
      now - room.createdAt >
        6 * 60 * 60 * 1000 &&
      room.players.size === 0
    ) {
      rooms.delete(code);
    }
  }
}, 60_000);

cleanupTimer.unref();

// =============================================
// INICIAR SERVIDOR BLOCKWORLD
// =============================================

server.listen(PORT, HOST, () => {
  console.log('==================================');
  console.log('       BLOCKWORLD ONLINE');
  console.log(`   Porta: ${PORT}`);
  console.log(`   Host: ${HOST}`);
  console.log(`   Frontend: ${FRONTEND_ORIGIN}`);
  console.log('   Contas e jogos carregados');
  console.log('   Multiplayer preparado');
  console.log('==================================');
});
