
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { registerSocialRoutes } = require('./social');

// ============================================================
// 1. CONFIGURAÇÃO
// ============================================================

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const PLATFORM_DIR = path.join(ROOT, 'platform');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLISHED_DIR = path.join(ROOT, 'published');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const SHOP_FILE = path.join(DATA_DIR, 'shop.json');
const SHOP_AUDIT_FILE = path.join(DATA_DIR, 'shop-audit.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

const DEFAULT_ORIGINS = [
  'https://denilsonjunior2027-gif.github.io',
  'https://blockworldm.netlify.app'
];

const allowedOrigins = [
  ...new Set([
    ...DEFAULT_ORIGINS,
    ...String(process.env.FRONTEND_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean)
  ])
];

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', 1);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      // Clientes sem Origin podem ser ferramentas ou conexões locais.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origem não permitida pelo CORS.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
  },
  maxHttpBufferSize: 100000,
  pingInterval: 25000,
  pingTimeout: 20000
});

// ============================================================
// 2. ARQUIVOS JSON
// ============================================================

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';

  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
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

const DEFAULT_SHOP_ITEMS = [
  {
    id: 'bw-cap-blue',
    name: 'Boné Azul BlockWorld',
    category: 'Chapéus',
    description: 'Boné cosmético azul para perfis compatíveis.',
    icon: '🧢',
    price: 0,
    kind: 'cosmetic',
    enabled: true
  },
  {
    id: 'bw-glasses-neon',
    name: 'Óculos Neon',
    category: 'Acessórios',
    description: 'Óculos de estilo futurista.',
    icon: '🕶️',
    price: 250,
    kind: 'cosmetic',
    enabled: true
  },
  {
    id: 'bw-hoodie-cyan',
    name: 'Moletom Ciano',
    category: 'Roupas',
    description: 'Visual exclusivo da BlockWorld.',
    icon: '🧥',
    price: 400,
    kind: 'clothing',
    enabled: true
  },
  {
    id: 'bw-trail-spark',
    name: 'Rastro de Faíscas',
    category: 'Efeitos',
    description: 'Efeito para jogos que implementarem este item.',
    icon: '✨',
    price: 600,
    kind: 'effect',
    enabled: true
  },
  {
    id: 'bw-tool-builder',
    name: 'Ferramenta Construtora',
    category: 'Gears',
    description: 'Item demonstrativo que requer suporte no jogo.',
    icon: '🛠️',
    price: 800,
    kind: 'gear',
    enabled: true
  },
  {
    id: 'bw-pants-urban',
    name: 'Calça Urbana',
    category: 'Calças',
    description: 'Peça cosmética para avatares compatíveis.',
    icon: '👖',
    price: 300,
    kind: 'clothing',
    enabled: true
  }
];

let shopItems = readJson(SHOP_FILE, null);
let shopAudit = readJson(SHOP_AUDIT_FILE, []);

if (!Array.isArray(shopItems)) {
  shopItems = DEFAULT_SHOP_ITEMS;
  writeJson(SHOP_FILE, shopItems);
}

if (!Array.isArray(shopAudit)) {
  shopAudit = [];
}

// ============================================================
// 3. MIGRAÇÃO DE CONTAS EXISTENTES
// ============================================================

let usersChanged = false;

for (const user of users) {
  // Contas antigas sem carteira recebem o saldo inicial.
  // Um saldo inválido que já existia não recebe moedas grátis.
  if (user.coins === undefined || user.coins === null) {
    user.coins = 1250;
    usersChanged = true;
  } else if (!Number.isSafeInteger(user.coins) || user.coins < 0) {
    user.coins = 0;
    usersChanged = true;
  }

  if (!Array.isArray(user.shopInventory)) {
    user.shopInventory = [];
    usersChanged = true;
  }

  if (!Array.isArray(user.equippedShopItems)) {
    user.equippedShopItems = [];
    usersChanged = true;
  }
}

if (usersChanged) {
  writeJson(USERS_FILE, users);
}

const sessions = new Map();
const rooms = new Map();

const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000;
const MAX_COINS = 1_000_000_000;

// ============================================================
// 4. CORS, SEGURANÇA E MIDDLEWARES
// ============================================================

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).end();
    }

    return res.status(204).end();
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  next();
});

app.use(express.json({ limit: '3mb' }));

app.use(express.static(PLATFORM_DIR, {
  extensions: ['html'],
  index: 'index.html'
}));

// ============================================================
// 5. CONTAS, SESSÕES E AUTORIZAÇÃO
// ============================================================

function cookieValue(req, key) {
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const index = part.indexOf('=');

    if (index < 0) continue;

    if (part.slice(0, index).trim() === key) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
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

function isAdminUser(user) {
  const configured = String(process.env.ADMIN_USERNAME || '').trim();

  return Boolean(
    configured &&
    user &&
    typeof user.username === 'string' &&
    user.username.toLowerCase() === configured.toLowerCase()
  );
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    coins: Number.isSafeInteger(user.coins) && user.coins >= 0
      ? user.coins
      : 0,
    isAdmin: isAdminUser(user)
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

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminUser(req.user)) {
    return res.status(403).json({
      error: 'Apenas a conta administradora pode fazer isso.'
    });
  }

  next();
}

function setSession(res, user, req) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    userId: user.id,
    expires: Date.now() + SESSION_DURATION
  });

  const production =
    process.env.NODE_ENV === 'production' ||
    Boolean(req && req.secure);

  const sameSite = production ? 'None' : 'Lax';
  const secure = production ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `bw_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_DURATION / 1000}${secure}`
  );
}

function clearSession(req, res) {
  const token = cookieValue(req, 'bw_session');

  if (token) sessions.delete(token);

  const production =
    process.env.NODE_ENV === 'production' ||
    Boolean(req.secure);

  res.setHeader(
    'Set-Cookie',
    `bw_session=; HttpOnly; SameSite=${production ? 'None' : 'Lax'}; Path=/; Max-Age=0${production ? '; Secure' : ''}`
  );
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function validUsername(name) {
  return typeof name === 'string' &&
    /^[\p{L}\p{N}_-]{3,24}$/u.test(name);
}

// ============================================================
// 6. ROTAS SOCIAIS EXISTENTES
// ============================================================

// Mantém a integração com o módulo social.js.
registerSocialRoutes({
  app,
  requireUser,
  users,
  writeJson,
  dataDir: DATA_DIR,
  usersFile: USERS_FILE
});

// ============================================================
// 7. STATUS, REGISTRO, LOGIN E LOGOUT
// ============================================================

app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    jogadores: io.engine.clientsCount,
    jogos: games.length
  });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);

  res.json({
    user: user ? publicUser(user) : null
  });
});

app.post('/api/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;

  if (!validUsername(username)) {
    return res.status(400).json({
      error: 'O nome deve ter 3 a 24 caracteres: letras, números, _ ou -.'
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
    createdAt: Date.now(),
    coins: 1250,
    shopInventory: [],
    equippedShopItems: []
  };

  users.push(user);

  try {
    writeJson(USERS_FILE, users);
  } catch (error) {
    users = users.filter(entry => entry.id !== user.id);

    console.error('[REGISTER] Erro ao salvar conta:', error);

    return res.status(500).json({
      error: 'Não foi possível criar sua conta.'
    });
  }

  setSession(res, user, req);

  res.status(201).json({
    user: publicUser(user)
  });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = req.body?.password;

  const user = users.find(entry =>
    entry.username.toLowerCase() === username.toLowerCase()
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

  let hash;

  try {
    hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
  } catch {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash || '', 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: 'Nome de usuário ou senha incorretos.'
    });
  }

  setSession(res, user, req);

  res.json({
    user: publicUser(user)
  });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// ============================================================
// 8. LOJA: ITENS E INVENTÁRIO
// ============================================================

function safeShopItem(item) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    description: item.description,
    icon: item.icon,
    price: item.price,
    kind: item.kind,
    enabled: item.enabled !== false
  };
}

function validShopItem(body) {
  const name = typeof body?.name === 'string'
    ? body.name.trim()
    : '';

  const category = typeof body?.category === 'string'
    ? body.category.trim()
    : '';

  const description = typeof body?.description === 'string'
    ? body.description.trim()
    : '';

  const icon = typeof body?.icon === 'string'
    ? body.icon.trim()
    : '🎁';

  const price = body?.price;
  const kind = typeof body?.kind === 'string'
    ? body.kind
    : 'cosmetic';

  if (
    name.length < 2 ||
    name.length > 60 ||
    category.length < 2 ||
    category.length > 30 ||
    description.length > 240
  ) {
    return null;
  }

  if (
    !Number.isSafeInteger(price) ||
    price < 0 ||
    price > MAX_COINS
  ) {
    return null;
  }

  if (![
    'cosmetic',
    'clothing',
    'game-item',
    'gear',
    'effect'
  ].includes(kind)) {
    return null;
  }

  if (icon.length > 8) return null;

  return {
    name,
    category,
    description,
    icon: icon || '🎁',
    price,
    kind
  };
}

app.get('/api/shop/items', (req, res) => {
  res.json({
    items: shopItems
      .filter(item => item.enabled !== false)
      .map(safeShopItem)
  });
});

app.get('/api/shop/inventory', requireUser, (req, res) => {
  const user = req.user;

  const ownedIds = Array.isArray(user.shopInventory)
    ? user.shopInventory
    : [];

  const equippedIds = Array.isArray(user.equippedShopItems)
    ? user.equippedShopItems.filter(id => ownedIds.includes(id))
    : [];

  res.json({
    coins: user.coins,
    inventory: ownedIds
      .map(id => shopItems.find(item => item.id === id))
      .filter(Boolean)
      .map(safeShopItem),
    equipped: equippedIds
  });
});

// ============================================================
// 9. LOJA: COMPRAS
// ============================================================

app.post('/api/shop/buy', requireUser, (req, res) => {
  const itemId = typeof req.body?.itemId === 'string'
    ? req.body.itemId
    : '';

  const item = shopItems.find(entry =>
    entry.id === itemId && entry.enabled !== false
  );

  if (!item) {
    return res.status(404).json({
      error: 'Esse item não está disponível.'
    });
  }

  const user = req.user;

  if (!Array.isArray(user.shopInventory)) {
    user.shopInventory = [];
  }

  if (user.shopInventory.includes(item.id)) {
    return res.status(409).json({
      error: 'Você já possui esse item.'
    });
  }

  const price = item.price;

  if (!Number.isSafeInteger(price) || price < 0) {
    return res.status(500).json({
      error: 'O preço desse item está inválido.'
    });
  }

  const balance = user.coins;

  if (!Number.isSafeInteger(balance) || balance < price) {
    return res.status(400).json({
      error: 'Você não tem moedas suficientes.',
      coins: Number.isSafeInteger(balance) ? balance : 0
    });
  }

  const oldInventory = [...user.shopInventory];

  user.coins = balance - price;
  user.shopInventory.push(item.id);

  try {
    writeJson(USERS_FILE, users);
  } catch (error) {
    user.coins = balance;
    user.shopInventory = oldInventory;

    console.error('[SHOP] Falha ao salvar compra:', error);

    return res.status(500).json({
      error: 'Não foi possível salvar a compra. Tente novamente.'
    });
  }

  // O histórico é secundário: uma falha nele não desfaz
  // uma compra que já foi salva no arquivo dos usuários.
  try {
    shopAudit.push({
      id: crypto.randomUUID(),
      action: 'purchase',
      username: user.username,
      itemId: item.id,
      price,
      at: Date.now()
    });

    if (shopAudit.length > 5000) {
      shopAudit = shopAudit.slice(-5000);
    }

    writeJson(SHOP_AUDIT_FILE, shopAudit);
  } catch (error) {
    console.error('[SHOP] Falha ao salvar auditoria:', error);
  }

  res.json({
    ok: true,
    message: price === 0
      ? 'Item gratuito adicionado ao inventário!'
      : 'Compra concluída!',
    coins: user.coins,
    item: safeShopItem(item)
  });
});

// ============================================================
// 10. LOJA: EQUIPAR E DESEQUIPAR
// ============================================================

app.post('/api/shop/equip', requireUser, (req, res) => {
  const itemId = typeof req.body?.itemId === 'string'
    ? req.body.itemId
    : '';

  const user = req.user;

  if (!Array.isArray(user.shopInventory)) {
    user.shopInventory = [];
  }

  if (!Array.isArray(user.equippedShopItems)) {
    user.equippedShopItems = [];
  }

  if (!user.shopInventory.includes(itemId)) {
    return res.status(403).json({
      error: 'Você precisa possuir esse item para equipá-lo.'
    });
  }

  const item = shopItems.find(entry => entry.id === itemId);

  if (!item) {
    return res.status(404).json({
      error: 'Item não encontrado.'
    });
  }

  const previous = [...user.equippedShopItems];

  if (req.body?.equipped === false) {
    user.equippedShopItems =
      user.equippedShopItems.filter(id => id !== itemId);
  } else if (!user.equippedShopItems.includes(itemId)) {
    user.equippedShopItems.push(itemId);
  }

  try {
    writeJson(USERS_FILE, users);
  } catch (error) {
    user.equippedShopItems = previous;

    console.error('[SHOP] Falha ao salvar equipamento:', error);

    return res.status(500).json({
      error: 'Não foi possível atualizar seu inventário.'
    });
  }

  res.json({
    ok: true,
    equipped: user.equippedShopItems,
    message: 'Inventário atualizado.'
  });
});

// ============================================================
// 11. ADMINISTRAÇÃO DA LOJA
// ============================================================

app.get(
  '/api/admin/shop/items',
  requireUser,
  requireAdmin,
  (req, res) => {
    res.json({
      items: shopItems.map(safeShopItem),
      recentActions: shopAudit.slice(-100).reverse()
    });
  }
);

app.post(
  '/api/admin/shop/items',
  requireUser,
  requireAdmin,
  (req, res) => {
    const parsed = validShopItem(req.body);

    if (!parsed) {
      return res.status(400).json({
        error: 'Dados inválidos. Confira nome, categoria, ícone e preço.'
      });
    }

    const item = {
      id: 'bw-' + crypto.randomBytes(8).toString('hex'),
      ...parsed,
      enabled: true,
      createdAt: Date.now(),
      createdBy: req.user.username
    };

    shopItems.unshift(item);

    try {
      writeJson(SHOP_FILE, shopItems);
    } catch (error) {
      shopItems = shopItems.filter(entry => entry.id !== item.id);

      console.error('[ADMIN SHOP] Falha ao salvar item:', error);

      return res.status(500).json({
        error: 'Não foi possível salvar o item.'
      });
    }

    try {
      shopAudit.push({
        id: crypto.randomUUID(),
        action: 'create-item',
        username: req.user.username,
        itemId: item.id,
        at: Date.now()
      });

      writeJson(SHOP_AUDIT_FILE, shopAudit);
    } catch (error) {
      console.error('[ADMIN SHOP] Falha na auditoria:', error);
    }

    res.status(201).json({
      ok: true,
      item: safeShopItem(item)
    });
  }
);

app.patch(
  '/api/admin/shop/items/:id',
  requireUser,
  requireAdmin,
  (req, res) => {
    const item = shopItems.find(entry =>
      entry.id === req.params.id
    );

    if (!item) {
      return res.status(404).json({
        error: 'Item não encontrado.'
      });
    }

    const oldItem = { ...item };

    if (req.body?.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') {
        return res.status(400).json({
          error: 'enabled precisa ser booleano.'
        });
      }

      item.enabled = req.body.enabled;
    }

    if (req.body?.price !== undefined) {
      if (
        !Number.isSafeInteger(req.body.price) ||
        req.body.price < 0 ||
        req.body.price > MAX_COINS
      ) {
        return res.status(400).json({
          error: 'Preço inválido.'
        });
      }

      item.price = req.body.price;
    }

    try {
      writeJson(SHOP_FILE, shopItems);
    } catch (error) {
      Object.assign(item, oldItem);

      console.error('[ADMIN SHOP] Falha ao atualizar item:', error);

      return res.status(500).json({
        error: 'Não foi possível atualizar o item.'
      });
    }

    try {
      shopAudit.push({
        id: crypto.randomUUID(),
        action: 'update-item',
        username: req.user.username,
        itemId: item.id,
        at: Date.now()
      });

      writeJson(SHOP_AUDIT_FILE, shopAudit);
    } catch (error) {
      console.error('[ADMIN SHOP] Falha na auditoria:', error);
    }

    res.json({
      ok: true,
      item: safeShopItem(item)
    });
  }
);

app.get(
  '/api/admin/shop/audit',
  requireUser,
  requireAdmin,
  (req, res) => {
    res.json({
      actions: shopAudit.slice(-200).reverse()
    });
  }
);

// ============================================================
// 12. ADMIN: ADICIONAR OU REMOVER BLOCKWORLD COINS
// ============================================================

// POST /api/admin/users/:username/coins
// JSON: { "amount": 500 }
// Quantidades negativas removem moedas.
// Somente a conta definida em ADMIN_USERNAME pode usar a rota.

app.post(
  '/api/admin/users/:username/coins',
  requireUser,
  requireAdmin,
  (req, res) => {
    const amount = req.body?.amount;

    if (
      !Number.isSafeInteger(amount) ||
      amount === 0 ||
      Math.abs(amount) > MAX_COINS
    ) {
      return res.status(400).json({
        error: 'Informe uma quantidade inteira diferente de zero.'
      });
    }

    const target = users.find(user =>
      user.username.toLowerCase() ===
      String(req.params.username).toLowerCase()
    );

    if (!target) {
      return res.status(404).json({
        error: 'Conta não encontrada.'
      });
    }

    const previous = target.coins;

    if (
      !Number.isSafeInteger(previous) ||
      previous < 0 ||
      previous + amount < 0 ||
      previous + amount > MAX_COINS
    ) {
      return res.status(400).json({
        error: 'O saldo final ficaria fora do limite permitido.'
      });
    }

    target.coins = previous + amount;

    try {
      writeJson(USERS_FILE, users);
    } catch (error) {
      target.coins = previous;

      console.error('[ADMIN COINS] Falha ao salvar saldo:', error);

      return res.status(500).json({
        error: 'Não foi possível atualizar o saldo.'
      });
    }

    try {
      shopAudit.push({
        id: crypto.randomUUID(),
        action: 'admin-coins',
        username: req.user.username,
        targetUsername: target.username,
        amount,
        at: Date.now()
      });

      writeJson(SHOP_AUDIT_FILE, shopAudit);
    } catch (error) {
      console.error('[ADMIN COINS] Falha na auditoria:', error);
    }

    res.json({
      ok: true,
      username: target.username,
      coins: target.coins
    });
  }
);

// ============================================================
// 13. CATÁLOGO E PUBLICAÇÃO DE JOGOS
// ============================================================

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

const CATEGORIES = [
  'Aventura',
  'Construção',
  'Corrida',
  'Obby',
  'Simulação',
  'Outro'
];

app.get('/api/games', (req, res) => {
  const publishedGames = games
    .filter(game => game && game.published)
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

  res.json({ games: publishedGames });
});

app.post('/api/games/:id/visit', (req, res) => {
  const game = games.find(entry =>
    entry.id === req.params.id && entry.published
  );

  if (!game) {
    return res.status(404).json({
      error: 'Jogo não encontrado.'
    });
  }

  const oldVisits = Number.isSafeInteger(game.visits) &&
    game.visits >= 0
    ? game.visits
    : 0;

  game.visits = oldVisits + 1;

  try {
    writeJson(GAMES_FILE, games);
  } catch (error) {
    game.visits = oldVisits;

    console.error('[VISITAS] Falha ao salvar:', error);

    return res.status(500).json({
      error: 'Não foi possível salvar a visita.'
    });
  }

  res.json({
    ok: true,
    visits: game.visits
  });
});

app.post('/api/games', requireUser, (req, res) => {
  const title = typeof req.body?.title === 'string'
    ? req.body.title.trim()
    : '';

  const description = typeof req.body?.description === 'string'
    ? req.body.description.trim()
    : '';

  const category = typeof req.body?.category === 'string'
    ? req.body.category.trim()
    : 'Outro';

  const url = typeof req.body?.url === 'string'
    ? req.body.url.trim()
    : '';

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

  if (url && (
    url.length > 500 ||
    !validHttpsUrl(url)
  )) {
    return res.status(400).json({
      error: 'Use um link HTTPS válido para o jogo.'
    });
  }

  if (games.filter(game =>
    game.creatorId === req.user.id
  ).length >= 30) {
    return res.status(429).json({
      error: 'Você atingiu o limite de 30 publicações.'
    });
  }

  const game = {
    id: crypto.randomUUID(),
    title,
    description,
    category: CATEGORIES.includes(category) ? category : 'Outro',
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

    console.error('[GAMES] Falha ao publicar:', error);

    return res.status(500).json({
      error: 'Não foi possível publicar o jogo.'
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
  const game = games.find(entry =>
    entry.id === req.params.id
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

  const previousGames = games;
  games = games.filter(entry => entry.id !== game.id);

  try {
    writeJson(GAMES_FILE, games);
  } catch (error) {
    games = previousGames;

    console.error('[GAMES] Falha ao remover:', error);

    return res.status(500).json({
      error: 'Não foi possível remover o jogo.'
    });
  }

  res.json({ ok: true });
});

// ============================================================
// 14. PUBLICAÇÃO E EXECUÇÃO DE CENAS 3D
// ============================================================

function validScene(scene) {
  if (
    !scene ||
    typeof scene !== 'object' ||
    !Array.isArray(scene.objects) ||
    scene.objects.length > 500
  ) {
    return false;
  }

  const allowedTypes = new Set([
    'Box',
    'Sphere',
    'Plane',
    'Cylinder'
  ]);

  for (const object of scene.objects) {
    if (
      !object ||
      typeof object !== 'object' ||
      !allowedTypes.has(object.type)
    ) {
      return false;
    }

    for (const key of ['position', 'rotation', 'scale']) {
      const values = object[key];

      if (
        !Array.isArray(values) ||
        values.length !== 3 ||
        !values.every(value =>
          typeof value === 'number' && Number.isFinite(value)
        )
      ) {
        return false;
      }
    }

    if (
      !object.scale.every(value =>
        value >= 0.05 && value <= 100
      )
    ) {
      return false;
    }

    if (
      typeof object.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(object.color)
    ) {
      return false;
    }

    if (
      object.name !== undefined &&
      (typeof object.name !== 'string' || object.name.length > 80)
    ) {
      return false;
    }
  }

  return true;
}

app.post('/api/publish-scene', requireUser, (req, res) => {
  const title = typeof req.body?.title === 'string'
    ? req.body.title.trim()
    : '';

  const description = typeof req.body?.description === 'string'
    ? req.body.description.trim()
    : '';

  const category = typeof req.body?.category === 'string'
    ? req.body.category
    : 'Outro';

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
      error: 'Cena inválida ou com objetos incompatíveis.'
    });
  }

  if (games.filter(game =>
    game.creatorId === req.user.id
  ).length >= 30) {
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
      position: [...object.position],
      rotation: [...object.rotation],
      scale: object.scale.map(value =>
        Math.max(0.05, Math.min(100, value))
      ),
      color: object.color
    }))
  };

  const game = {
    id,
    title,
    description,
    category: CATEGORIES.includes(category) ? category : 'Outro',
    url: '/play/' + id,
    creatorId: req.user.id,
    creator: req.user.username,
    createdAt: Date.now(),
    published: true,
    icon: '🎮',
    sceneFile: id + '.json'
  };

  const scenePath = path.join(PUBLISHED_DIR, game.sceneFile);
  const previousGames = games;

  try {
    fs.writeFileSync(scenePath, JSON.stringify(safeScene), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });

    games = [game, ...games];
    writeJson(GAMES_FILE, games);
  } catch (error) {
    games = previousGames;

    try {
      fs.unlinkSync(scenePath);
    } catch {}

    console.error('[SCENE] Falha ao publicar:', error);

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
    return res.status(400).json({
      error: 'ID inválido.'
    });
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

// ============================================================
// 15. THREE.JS E ROTAS NÃO ENCONTRADAS
// ============================================================

app.use('/vendor/three', express.static(
  path.join(ROOT, 'node_modules', 'three')
));

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Rota da API não encontrada.'
  });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PLATFORM_DIR, 'index.html'));
});

// Tratamento de erros do Express.
app.use((error, req, res, next) => {
  console.error('[SERVER] Erro inesperado:', error);

  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({
      error: 'O corpo da requisição contém JSON inválido.'
    });
  }

  res.status(500).json({
    error: 'Ocorreu um erro interno no servidor.'
  });
});

// ============================================================
// 16. MULTIPLAYER SOCKET.IO
// ============================================================

function socketUser(socket) {
  const token = socket.request.cookiesMap?.bw_session;
  const session = sessions.get(token);

  if (!session || session.expires < Date.now()) {
    return null;
  }

  return users.find(user => user.id === session.userId) || null;
}

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

    result[key] =
      typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
        ? color
        : DEFAULT_AVATAR[key];
  }

  return result;
}

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

io.use((socket, next) => {
  const cookies = {};

  for (const part of String(
    socket.request.headers.cookie || ''
  ).split(';')) {
    const index = part.indexOf('=');

    if (index <= 0) continue;

    try {
      cookies[part.slice(0, index).trim()] =
        decodeURIComponent(part.slice(index + 1).trim());
    } catch {}
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

io.on('connection', socket => {
  io.emit('onlineCount', io.engine.clientsCount);

  socket.on('findMatch', (payload = {}) => {
    const gameId = typeof payload.gameId === 'string'
      ? payload.gameId.slice(0, 80)
      : '';

    if (!gameId) {
      socket.emit('roomError', 'Identificador de jogo inválido.');
      return;
    }

    const gameExists = games.some(game =>
      game && String(game.id) === gameId && game.published
    );

    if (!gameExists) {
      socket.emit('roomError', 'Jogo não encontrado no catálogo.');
      return;
    }

    const currentId = socket.data.roomCode;
    const currentRoom = currentId ? rooms.get(currentId) : null;

    if (currentRoom && currentRoom.gameId === gameId) {
      sendRoomJoined(socket, currentRoom);
      return;
    }

    if (currentRoom) leaveSocketRoom(socket);

    let room = [...rooms.values()].find(candidate =>
      candidate.gameId === gameId &&
      candidate.players.size < MAX_PLAYERS_PER_MATCH
    );

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
    const user = users.find(entry =>
      entry.id === socket.user.id
    );

    if (!user) {
      socket.emit('roomError', 'Conta não encontrada.');
      return;
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
      console.error('[AVATAR] Erro ao salvar:', error);

      socket.emit(
        'roomError',
        'Não foi possível salvar o avatar.'
      );
    }
  });

  socket.on('leaveRoom', () => {
    leaveSocketRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveSocketRoom(socket);

    io.emit(
      'onlineCount',
      Math.max(0, io.engine.clientsCount - 1)
    );
  });
});

// ============================================================
// 17. LIMPEZA DE SESSÕES E SALAS
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sessions) {
    if (session.expires < now) {
      sessions.delete(token);
    }
  }

  for (const [code, room] of rooms) {
    if (
      now - room.createdAt > 6 * 60 * 60 * 1000 &&
      room.players.size === 0
    ) {
      rooms.delete(code);
    }
  }
}, 60_000).unref();

// ============================================================
// 18. INICIALIZAÇÃO
// ============================================================

server.listen(PORT, HOST, () => {
  console.log('==================================');
  console.log('       BLOCKWORLD ONLINE');
  console.log(`   Porta: ${PORT}`);
  console.log(`   Host: ${HOST}`);
  console.log(`   Contas carregadas: ${users.length}`);
  console.log(`   Jogos carregados: ${games.length}`);
  console.log(`   Itens da loja: ${shopItems.length}`);
  console.log('   CORS permitido para:');

  for (const origin of allowedOrigins) {
    console.log(`   - ${origin}`);
  }

  console.log('   Pressione Ctrl+C para encerrar');
  console.log('==================================');
});
