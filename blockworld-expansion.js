'use strict';

module.exports = function installBlockWorldExpansion(app, ctx) {
  const { requireUser, users, writeJson, usersFile, getGames, saveGames } = ctx;

  const catalog = [
    { id: 'trail-blue', name: 'Rastro Azul', description: 'Efeito cosmético azul', price: 100, color: '#438cff' },
    { id: 'trail-purple', name: 'Rastro Roxo', description: 'Efeito cosmético roxo', price: 150, color: '#a16bff' },
    { id: 'shirt-green', name: 'Camisa Verde', description: 'Cor cosmética para o avatar', price: 75, color: '#42c878' },
    { id: 'shirt-gold', name: 'Camisa Dourada', description: 'Cor cosmética para o avatar', price: 250, color: '#e8b94f' }
  ];

  function ensureUser(user) {
    if (!Number.isSafeInteger(user.coins) || user.coins < 0) user.coins = 250;
    if (!Array.isArray(user.inventory)) user.inventory = [];
    if (typeof user.equippedItem !== 'string') user.equippedItem = '';
    if (!user.avatar || typeof user.avatar !== 'object') {
      user.avatar = { skin: '#d9a078', hair: '#38251c', shirt: '#635bdb', pants: '#27344d' };
    }
  }

  function persistUsers() {
    writeJson(usersFile, users);
  }

  function adminOnly(req, res, next) {
    const configured = String(process.env.BLOCKWORLD_ADMIN_USER || '').trim();
    if (!configured) {
      return res.status(503).json({
        error: 'Admin não configurado. Defina BLOCKWORLD_ADMIN_USER no ambiente do servidor.'
      });
    }
    if (req.user.username.toLowerCase() !== configured.toLowerCase()) {
      return res.status(403).json({ error: 'Acesso reservado à administração.' });
    }
    next();
  }

  app.get('/api/bw/profile', requireUser, (req, res) => {
    ensureUser(req.user);
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        createdAt: req.user.createdAt,
        coins: req.user.coins,
        avatar: req.user.avatar,
        inventory: req.user.inventory,
        equippedItem: req.user.equippedItem
      }
    });
  });

  app.get('/api/bw/shop', (req, res) => {
    res.json({ items: catalog });
  });

  app.post('/api/bw/shop/buy', requireUser, (req, res) => {
    const id = String(req.body?.itemId || '');
    const item = catalog.find(entry => entry.id === id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

    ensureUser(req.user);
    if (req.user.inventory.includes(id)) {
      return res.status(409).json({ error: 'Você já possui esse item.' });
    }
    if (req.user.coins < item.price) {
      return res.status(400).json({ error: 'Moedas insuficientes.' });
    }

    const previousCoins = req.user.coins;
    req.user.coins -= item.price;
    req.user.inventory.push(id);

    try {
      persistUsers();
      res.json({ ok: true, coins: req.user.coins, inventory: req.user.inventory });
    } catch (error) {
      req.user.coins = previousCoins;
      req.user.inventory = req.user.inventory.filter(value => value !== id);
      console.error('[BW SHOP]', error);
      res.status(500).json({ error: 'Não foi possível salvar a compra.' });
    }
  });

  app.post('/api/bw/shop/equip', requireUser, (req, res) => {
    const id = String(req.body?.itemId || '');
    ensureUser(req.user);

    if (id && (!catalog.some(item => item.id === id) || !req.user.inventory.includes(id))) {
      return res.status(400).json({ error: 'Você não possui esse item.' });
    }

    req.user.equippedItem = id;
    try {
      persistUsers();
      res.json({ ok: true, equippedItem: id });
    } catch (error) {
      console.error('[BW EQUIP]', error);
      res.status(500).json({ error: 'Não foi possível salvar o equipamento.' });
    }
  });

  app.put('/api/bw/avatar', requireUser, (req, res) => {
    const input = req.body?.avatar;
    const defaults = { skin: '#d9a078', hair: '#38251c', shirt: '#635bdb', pants: '#27344d' };
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ error: 'Avatar inválido.' });
    }

    const avatar = {};
    for (const key of Object.keys(defaults)) {
      const value = input[key];
      avatar[key] = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
        ? value : defaults[key];
    }

    const previous = req.user.avatar;
    req.user.avatar = avatar;
    try {
      persistUsers();
      res.json({ ok: true, avatar });
    } catch (error) {
      req.user.avatar = previous;
      console.error('[BW AVATAR]', error);
      res.status(500).json({ error: 'Não foi possível salvar o avatar.' });
    }
  });

  app.get('/api/bw/admin/stats', requireUser, adminOnly, (req, res) => {
    const games = getGames();
    res.json({
      users: users.length,
      games: games.filter(game => game.published).length,
      online: req.app.locals.io?.engine?.clientsCount || 0
    });
  });

  app.get('/api/bw/admin/games', requireUser, adminOnly, (req, res) => {
    res.json({
      games: getGames().map(game => ({
        id: game.id,
        title: game.title,
        creator: game.creator,
        published: !!game.published,
        createdAt: game.createdAt
      }))
    });
  });

  app.post('/api/bw/admin/games/:id/hide', requireUser, adminOnly, (req, res) => {
    const games = getGames();
    const game = games.find(entry => entry.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Jogo não encontrado.' });

    const previous = game.published;
    game.published = false;
    try {
      saveGames();
      res.json({ ok: true, message: 'Jogo retirado do catálogo.' });
    } catch (error) {
      game.published = previous;
      console.error('[BW ADMIN]', error);
      res.status(500).json({ error: 'Não foi possível salvar a alteração.' });
    }
  });
};
