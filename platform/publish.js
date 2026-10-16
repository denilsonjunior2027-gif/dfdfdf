'use strict';

const $ = id => document.getElementById(id);
const storedSceneKey = 'bw_engine_scene';
let engineScene = null;
let authMode = 'login';
let currentUser = null;

function status(message) {
  $('status').textContent = message;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || 'Erro HTTP ' + response.status);
  return data;
}

function readEngineScene() {
  try {
    const raw = localStorage.getItem(storedSceneKey);
    if (!raw) return null;
    const scene = JSON.parse(raw);
    if (!scene || !Array.isArray(scene.objects) ||
        scene.objects.length < 1 || scene.objects.length > 500) {
      throw new Error('A cena enviada pela Engine não é válida.');
    }
    return scene;
  } catch (error) {
    status('Não foi possível ler a cena da Engine: ' + error.message);
    return null;
  }
}

function configureSceneInput() {
  const hasEngineScene = !!engineScene;
  $('sceneFile').required = !hasEngineScene;
  $('sceneFileContainer').classList.toggle('hidden', hasEngineScene);
  $('sceneHelp').textContent = hasEngineScene
    ? 'Cena recebida diretamente da BlockWorld Engine.'
    : 'Escolha um arquivo JSON exportado pela Engine para publicar.';
}

function showAuth() {
  $('account').textContent = 'Você ainda não entrou na sua conta.';
  $('authPanel').classList.remove('hidden');
  $('publishForm').classList.add('hidden');
  $('authTitle').textContent = authMode === 'login'
    ? 'Entrar na BlockWorld'
    : 'Criar sua conta';
  $('authDescription').textContent = authMode === 'login'
    ? 'Entre com sua conta existente para publicar.'
    : 'Escolha um nome de usuário e uma senha de pelo menos 8 caracteres.';
  $('authSubmit').textContent = authMode === 'login' ? 'Entrar' : 'Criar conta';
  $('toggleAuth').textContent = authMode === 'login'
    ? 'Criar conta'
    : 'Já tenho uma conta';
  $('password').setAttribute('autocomplete',
    authMode === 'login' ? 'current-password' : 'new-password');
}

function showLoggedIn(user) {
  currentUser = user;
  $('account').textContent = 'Conectado como ' + user.username;
  $('authPanel').classList.add('hidden');
  $('publishForm').classList.remove('hidden');
  configureSceneInput();
  status(engineScene
    ? 'Cena recebida da Engine. Preencha os dados e publique seu jogo.'
    : 'Conta conectada. Escolha um arquivo de cena e preencha os dados do jogo.');
}

$('toggleAuth').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  showAuth();
  status(authMode === 'register'
    ? 'O nome deve ter de 3 a 24 caracteres. A senha precisa ter pelo menos 8.'
    : 'Entre com os dados da sua conta.');
});

$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('authSubmit');
  button.disabled = true;

  try {
    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        username: $('username').value.trim(),
        password: $('password').value
      })
    });

    $('password').value = '';
    showLoggedIn(result.user);
  } catch (error) {
    status('Não foi possível entrar: ' + error.message);
  } finally {
    button.disabled = false;
  }
});

$('logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    currentUser = null;
    authMode = 'login';
    showAuth();
    status('Você saiu da sua conta. A cena continua guardada nesta janela.');
  } catch (error) {
    status('Não foi possível sair da conta: ' + error.message);
  }
});

$('publishForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser) {
    showAuth();
    status('Entre na sua conta antes de publicar.');
    return;
  }

  let scene = engineScene;
  const file = $('sceneFile').files[0];

  try {
    if (!scene) {
      if (!file) {
        status('Escolha um arquivo JSON de cena.');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        status('O arquivo é maior que 2 MB.');
        return;
      }
      scene = JSON.parse(await file.text());
    }

    const button = $('publishButton');
    button.disabled = true;

    try {
      const result = await api('/api/publish-scene', {
        method: 'POST',
        body: JSON.stringify({
          title: $('title').value,
          description: $('description').value,
          category: $('category').value,
          scene
        })
      });

      localStorage.removeItem(storedSceneKey);
      engineScene = null;
      status('Jogo publicado com sucesso! Link para jogar: ' +
        location.origin + result.game.playUrl);

      const link = document.createElement('a');
      link.href = result.game.playUrl;
      link.textContent = 'Abrir jogo publicado';
      link.className = 'button';
      link.style.marginTop = '12px';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      $('status').appendChild(document.createElement('br'));
      $('status').appendChild(link);
    } finally {
      button.disabled = false;
    }
  } catch (error) {
    status('Não foi possível publicar: ' + error.message);
  }
});

(async () => {
  engineScene = readEngineScene();
  configureSceneInput();

  try {
    const result = await api('/api/me');
    if (result.user) {
      showLoggedIn(result.user);
    } else {
      showAuth();
      status('Entre ou crie uma conta para publicar. Sua cena permanece nesta janela.');
    }
  } catch (error) {
    showAuth();
    status('Não consegui conectar ao servidor. Confira se ele está rodando em http://localhost:3000. ' + error.message);
  }
})();
