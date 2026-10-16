(() => {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    #bwExpansionButton{position:fixed;right:18px;bottom:18px;z-index:9998;background:#7667ff;color:white;border:0;border-radius:13px;padding:13px 18px;font-weight:800;cursor:pointer;box-shadow:0 8px 28px #0006}
    #bwExpansion{position:fixed;inset:5vh 4vw;z-index:9999;overflow:auto;background:#0c1224;color:#edf2ff;border:1px solid #35415e;border-radius:20px;padding:22px;box-shadow:0 20px 90px #000b;font:15px/1.5 system-ui;display:none}
    #bwExpansion *{box-sizing:border-box}
    #bwExpansion h2{margin-top:0}
    #bwExpansion button,#bwExpansion select{background:#7567ff;color:white;border:0;border-radius:9px;padding:9px 12px;cursor:pointer;margin:4px}
    #bwExpansion .bwClose{float:right;background:#27334c}
    #bwExpansion .bwCard{background:#151f36;border:1px solid #2d3a55;border-radius:12px;padding:14px;margin:10px 0}
    #bwExpansion .bwMuted{color:#aab6d0}
    #bwExpansion .bwTabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
    #bwExpansion .bwTabs button{background:#28334d}
    #bwExpansion .bwResult{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;color:#b9d5ff}
  `;
  document.head.appendChild(style);

  const launch = document.createElement('button');
  launch.id = 'bwExpansionButton';
  launch.textContent = '✦ BlockWorld';
  document.body.appendChild(launch);

  const panel = document.createElement('section');
  panel.id = 'bwExpansion';
  panel.innerHTML = `
    <button class="bwClose" id="bwClose">Fechar ✕</button>
    <h2>BlockWorld Hub</h2>
    <p class="bwMuted">Perfil, loja, avatares e administração.</p>
    <div class="bwTabs">
      <button data-tab="profile">Minha conta</button>
      <button data-tab="shop">Loja</button>
      <button data-tab="avatar">Avatar</button>
      <button data-tab="admin">Administração</button>
    </div>
    <div id="bwContent">Carregando...</div>
    <div class="bwResult" id="bwResult" role="status"></div>
  `;
  document.body.appendChild(panel);

  const content = panel.querySelector('#bwContent');
  const result = panel.querySelector('#bwResult');
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[ch]);

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(options.headers || {})
      }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
    return data;
  }

  async function run(action) {
    result.textContent = '';
    try { await action(); }
    catch (error) { result.textContent = error.message; }
  }

  async function showProfile() {
    const data = await api('/api/bw/profile');
    const user = data.user;
    content.innerHTML = `
      <div class="bwCard">
        <h3>Olá, ${escapeHtml(user.username)}!</h3>
        <p>Moedas: <strong>${user.coins}</strong></p>
        <p>Itens no inventário: ${user.inventory.length}</p>
        <p>Item equipado: ${escapeHtml(user.equippedItem || 'Nenhum')}</p>
        <p class="bwMuted">Conta criada: ${new Date(user.createdAt).toLocaleDateString()}</p>
      </div>`;
  }

  async function showShop() {
    const [data, profile] = await Promise.all([
      api('/api/bw/shop'), api('/api/bw/profile')
    ]);
    content.innerHTML = `<h3>Loja de cosméticos</h3><p>Saldo: ${profile.user.coins} moedas</p>` +
      data.items.map(item => {
        const owned = profile.user.inventory.includes(item.id);
        return `<div class="bwCard">
          <strong>${escapeHtml(item.name)}</strong>
          <p>${escapeHtml(item.description)}</p>
          <p>Preço: ${item.price} moedas</p>
          ${owned
            ? `<button data-equip="${escapeHtml(item.id)}">${profile.user.equippedItem === item.id ? 'Equipado' : 'Equipar'}</button>`
            : `<button data-buy="${escapeHtml(item.id)}">Comprar</button>`}
        </div>`;
      }).join('');

    content.querySelectorAll('[data-buy]').forEach(button => {
      button.addEventListener('click', () => run(async () => {
        await api('/api/bw/shop/buy', {
          method:'POST',
          body:JSON.stringify({itemId:button.dataset.buy})
        });
        result.textContent = 'Compra realizada!';
        await showShop();
      }));
    });

    content.querySelectorAll('[data-equip]').forEach(button => {
      button.addEventListener('click', () => run(async () => {
        await api('/api/bw/shop/equip', {
          method:'POST',
          body:JSON.stringify({itemId:button.dataset.equip})
        });
        result.textContent = 'Item equipado!';
        await showShop();
      }));
    });
  }

  async function showAvatar() {
    const data = await api('/api/bw/profile');
    const avatar = data.user.avatar || {};
    const fields = [
      ['skin','Pele'], ['hair','Cabelo'], ['shirt','Camisa'], ['pants','Calça']
    ];
    content.innerHTML = '<h3>Personalizar avatar</h3><p class="bwMuted">Escolha as cores do seu personagem.</p>' +
      fields.map(([key,label]) => `
        <div class="bwCard">
          <label>${label}: <input type="color" data-color="${key}" value="${/^#[0-9a-f]{6}$/i.test(avatar[key] || '') ? avatar[key] : '#888888'}"></label>
        </div>`).join('') +
      '<button id="bwSaveAvatar">Salvar avatar</button>';

    content.querySelector('#bwSaveAvatar').addEventListener('click', () => run(async () => {
      const colors = {};
      content.querySelectorAll('[data-color]').forEach(input => {
        colors[input.dataset.color] = input.value;
      });
      await api('/api/bw/avatar', {
        method:'PUT', body:JSON.stringify({avatar:colors})
      });
      result.textContent = 'Avatar salvo!';
    }));
  }

  async function showAdmin() {
    const stats = await api('/api/bw/admin/stats');
    const data = await api('/api/bw/admin/games');
    content.innerHTML = `
      <h3>Painel administrativo</h3>
      <div class="bwCard">Contas: ${stats.users} · Jogos publicados: ${stats.games} · Conexões: ${stats.online}</div>
      <p class="bwMuted">Retirar um jogo do catálogo não apaga o arquivo da cena.</p>` +
      data.games.map(game => `<div class="bwCard">
        <strong>${escapeHtml(game.title)}</strong>
        <p>Criador: ${escapeHtml(game.creator)} · ${game.published ? 'Publicado' : 'Oculto'}</p>
        ${game.published ? `<button data-hide="${escapeHtml(game.id)}">Retirar do catálogo</button>` : ''}
      </div>`).join('');

    content.querySelectorAll('[data-hide]').forEach(button => {
      button.addEventListener('click', () => run(async () => {
        await api('/api/bw/admin/games/' + encodeURIComponent(button.dataset.hide) + '/hide', {method:'POST'});
        result.textContent = 'Jogo retirado do catálogo.';
        await showAdmin();
      }));
    });
  }

  const tabs = {
    profile: showProfile,
    shop: showShop,
    avatar: showAvatar,
    admin: showAdmin
  };

  launch.addEventListener('click', () => {
    panel.style.display = 'block';
    run(showProfile);
  });
  panel.querySelector('#bwClose').addEventListener('click', () => {
    panel.style.display = 'none';
  });
  panel.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => run(tabs[button.dataset.tab]));
  });
})();
