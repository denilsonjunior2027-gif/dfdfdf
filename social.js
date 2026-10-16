'use strict';

const crypto = require('crypto');
const path = require('path');

function registerSocialRoutes({ app, requireUser, users, writeJson, dataDir, usersFile }) {
  const file = path.join(dataDir, 'social.json');

  function load() {
    try {
      const d = JSON.parse(require('fs').readFileSync(file, 'utf8'));
      return {
        profiles: d.profiles || {},
        requests: Array.isArray(d.requests) ? d.requests : [],
        friends: Array.isArray(d.friends) ? d.friends : [],
        messages: Array.isArray(d.messages) ? d.messages : []
      };
    } catch {
      return { profiles: {}, requests: [], friends: [], messages: [] };
    }
  }

  let db = load();

  function save() {
    writeJson(file, db);
  }

  function publicProfile(user) {
    const p = db.profiles[user.id] || {};
    return {
      id: user.id,
      username: user.username,
      description: p.description || '',
      avatar: safeAvatar(user.avatar),
      createdAt: user.createdAt || null
    };
  }

  const defaults = {
    skin: '#d9a078',
    hair: '#38251c',
    shirt: '#635bdb',
    pants: '#27344d'
  };

  function safeAvatar(input) {
    const result = {};
    for (const key of Object.keys(defaults)) {
      result[key] = typeof input?.[key] === 'string' &&
        /^#[0-9a-f]{6}$/i.test(input[key])
        ? input[key] : defaults[key];
    }
    return result;
  }

  function findUser(id) {
    return users.find(u => u.id === id);
  }

  function isFriend(a, b) {
    return db.friends.some(f =>
      (f.a === a && f.b === b) ||
      (f.a === b && f.b === a)
    );
  }

  function conversationAllowed(a, b) {
    return a !== b && isFriend(a, b);
  }

  // Bloqueia pedidos de alteração vindos de outra origem.
  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: 'Origem não autorizada.' });
        }
      } catch {
        return res.status(403).json({ error: 'Origem inválida.' });
      }
    }
    next();
  }

  app.get('/api/social/profile/:username', (req, res) => {
    const name = String(req.params.username || '').slice(0, 24);
    const user = users.find(u =>
      u.username.toLowerCase() === name.toLowerCase()
    );
    if (!user) return res.status(404).json({ error: 'Jogador não encontrado.' });
    res.set('Cache-Control', 'no-store');
    res.json({ profile: publicProfile(user) });
  });

  app.patch('/api/social/profile', requireUser, sameOrigin, (req, res) => {
    const description = req.body?.description;
    const avatar = req.body?.avatar;

    if (description !== undefined &&
        (typeof description !== 'string' || description.length > 160)) {
      return res.status(400).json({ error: 'A descrição pode ter até 160 caracteres.' });
    }

    const user = findUser(req.user.id);
    if (!user) return res.status(401).json({ error: 'Conta não encontrada.' });

    const previous = db.profiles[user.id] || {};
    if (description !== undefined) {
      db.profiles[user.id] = {
        ...previous,
        description: description.trim()
      };
    }

    if (avatar !== undefined) {
      user.avatar = safeAvatar(avatar);
      try {
        writeJson(usersFile, users);
      } catch {
        return res.status(500).json({ error: 'Não foi possível salvar o avatar.' });
      }
    }

    try {
      save();
      res.json({ profile: publicProfile(user) });
    } catch {
      res.status(500).json({ error: 'Não foi possível salvar o perfil.' });
    }
  });

  app.get('/api/social/friends', requireUser, (req, res) => {
    const ids = db.friends
      .filter(f => f.a === req.user.id || f.b === req.user.id)
      .map(f => f.a === req.user.id ? f.b : f.a);

    res.json({ friends: ids.map(findUser).filter(Boolean).map(publicProfile) });
  });

  app.get('/api/social/requests', requireUser, (req, res) => {
    const incoming = db.requests
      .filter(r => r.to === req.user.id)
      .map(r => ({ id: r.from, username: findUser(r.from)?.username }))
      .filter(r => r.username);

    const outgoing = db.requests
      .filter(r => r.from === req.user.id)
      .map(r => ({ id: r.to, username: findUser(r.to)?.username }))
      .filter(r => r.username);

    res.json({ incoming, outgoing });
  });

  app.post('/api/social/requests', requireUser, sameOrigin, (req, res) => {
    const username = typeof req.body?.username === 'string'
      ? req.body.username.trim().slice(0, 24) : '';

    const target = users.find(u =>
      u.username.toLowerCase() === username.toLowerCase()
    );

    if (!target) return res.status(404).json({ error: 'Jogador não encontrado.' });
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'Você não pode adicionar a si mesmo.' });
    }
    if (isFriend(req.user.id, target.id)) {
      return res.status(409).json({ error: 'Vocês já são amigos.' });
    }

    const duplicate = db.requests.some(r =>
      (r.from === req.user.id && r.to === target.id) ||
      (r.from === target.id && r.to === req.user.id)
    );

    if (duplicate) {
      return res.status(409).json({ error: 'Já existe uma solicitação entre vocês.' });
    }

    db.requests.push({ id: crypto.randomUUID(), from: req.user.id, to: target.id, createdAt: Date.now() });
    try {
      save();
      res.status(201).json({ ok: true, message: 'Solicitação enviada.' });
    } catch {
      res.status(500).json({ error: 'Não foi possível salvar a solicitação.' });
    }
  });

  app.post('/api/social/requests/:userId/accept', requireUser, sameOrigin, (req, res) => {
    const fromId = req.params.userId;
    const request = db.requests.find(r => r.from === fromId && r.to === req.user.id);

    if (!request) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (!findUser(fromId)) return res.status(404).json({ error: 'Jogador não encontrado.' });

    db.requests = db.requests.filter(r =>
      !((r.from === fromId && r.to === req.user.id) ||
        (r.from === req.user.id && r.to === fromId))
    );

    if (!isFriend(req.user.id, fromId)) {
      db.friends.push({ a: req.user.id, b: fromId, createdAt: Date.now() });
    }

    try {
      save();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Não foi possível salvar a amizade.' });
    }
  });

  app.delete('/api/social/requests/:userId', requireUser, sameOrigin, (req, res) => {
    const other = req.params.userId;
    db.requests = db.requests.filter(r =>
      !((r.from === other && r.to === req.user.id) ||
        (r.from === req.user.id && r.to === other))
    );
    try {
      save();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Não foi possível atualizar as solicitações.' });
    }
  });

  app.delete('/api/social/friends/:userId', requireUser, sameOrigin, (req, res) => {
    const other = req.params.userId;
    db.friends = db.friends.filter(f =>
      !((f.a === req.user.id && f.b === other) ||
        (f.a === other && f.b === req.user.id))
    );
    try {
      save();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Não foi possível remover a amizade.' });
    }
  });

  app.get('/api/social/conversations', requireUser, (req, res) => {
    const ids = db.friends
      .filter(f => f.a === req.user.id || f.b === req.user.id)
      .map(f => f.a === req.user.id ? f.b : f.a);

    const conversations = ids.map(id => {
      const last = db.messages.filter(m =>
        (m.from === req.user.id && m.to === id) ||
        (m.from === id && m.to === req.user.id)
      ).at(-1);

      return {
        user: publicProfile(findUser(id)),
        lastMessage: last ? {
          text: last.text,
          createdAt: last.createdAt,
          fromMe: last.from === req.user.id
        } : null
      };
    }).filter(c => c.user);

    res.json({ conversations });
  });

  app.get('/api/social/messages/:userId', requireUser, (req, res) => {
    const other = req.params.userId;
    if (!conversationAllowed(req.user.id, other)) {
      return res.status(403).json({ error: 'Mensagens privadas são permitidas apenas entre amigos.' });
    }

    const messages = db.messages.filter(m =>
      (m.from === req.user.id && m.to === other) ||
      (m.from === other && m.to === req.user.id)
    ).slice(-100).map(m => ({
      id: m.id,
      from: m.from,
      to: m.to,
      text: m.text,
      createdAt: m.createdAt
    }));

    res.set('Cache-Control', 'no-store');
    res.json({ messages });
  });

  app.post('/api/social/messages/:userId', requireUser, sameOrigin, (req, res) => {
    const other = req.params.userId;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!conversationAllowed(req.user.id, other)) {
      return res.status(403).json({ error: 'Você precisa ser amigo desse jogador para conversar.' });
    }
    if (!text || text.length > 1000) {
      return res.status(400).json({ error: 'A mensagem deve ter entre 1 e 1000 caracteres.' });
    }

    const now = Date.now();
    const recent = db.messages.filter(m =>
      m.from === req.user.id && now - m.createdAt < 60_000
    );
    if (recent.length >= 30) {
      return res.status(429).json({ error: 'Você enviou mensagens demais. Aguarde um minuto.' });
    }

    db.messages.push({
      id: crypto.randomUUID(),
      from: req.user.id,
      to: other,
      text,
      createdAt: now
    });

    // Limita o tamanho do arquivo persistente.
    if (db.messages.length > 10000) db.messages = db.messages.slice(-10000);

    try {
      save();
      res.status(201).json({ ok: true, message: db.messages[db.messages.length - 1] });
    } catch {
      res.status(500).json({ error: 'Não foi possível enviar a mensagem.' });
    }
  });
}

module.exports = { registerSocialRoutes };
