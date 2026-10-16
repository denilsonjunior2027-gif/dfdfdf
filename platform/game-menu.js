(function () {
  "use strict";

  if (window.__BWGameMenuStarted) return;
  window.__BWGameMenuStarted = true;

  const style = document.createElement("style");
  style.textContent = `
    #bwGameMenuRoot { position:fixed; inset:0; z-index:99999; display:none;
      align-items:center; justify-content:center; background:#050914cc;
      color:#eef2ff; font:15px system-ui,sans-serif; }
    #bwGameMenuRoot * { box-sizing:border-box; }
    #bwGameMenuRoot .bw-card { width:min(520px, calc(100vw - 28px));
      max-height:88vh; overflow:auto; padding:22px; border:1px solid #354568;
      border-radius:18px; background:#111a2d; box-shadow:0 20px 80px #0009; }
    #bwGameMenuRoot h2 { margin:0 0 5px; font-size:24px; }
    #bwGameMenuRoot p { color:#b7c4df; }
    #bwGameMenuRoot button { cursor:pointer; border:1px solid #465779;
      border-radius:9px; padding:10px 13px; background:#202d49;
      color:#fff; font:inherit; }
    #bwGameMenuRoot button:hover { background:#304266; }
    #bwGameMenuRoot .bw-primary { background:#6255d9; border-color:#8175ff; }
    #bwGameMenuRoot .bw-row { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    #bwGameMenuRoot .bw-player { display:flex; align-items:center;
      justify-content:space-between; gap:10px; padding:9px 0;
      border-bottom:1px solid #2a3853; }
    #bwGameMenuRoot .bw-muted { color:#a7b4d0; font-size:13px; }
    #bwGameMenuRoot input[type=range] { width:100%; }
    #bwGameToast { position:fixed; z-index:100000; right:16px; top:16px;
      width:min(360px,calc(100vw - 32px)); padding:15px; border-radius:12px;
      color:#fff; background:#18243b; border:1px solid #53658a;
      box-shadow:0 12px 36px #0008; display:none; }
    #bwGameToast button { margin:8px 6px 0 0; cursor:pointer;
      padding:8px 13px; border-radius:8px; border:1px solid #52658b;
      background:#2a3a5b; color:white; }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "bwGameMenuRoot";
  root.innerHTML = `
    <section class="bw-card" role="dialog" aria-modal="true"
      aria-label="Menu do jogo">
      <h2>◈ BlockWorld</h2>
      <p>Menu da partida</p>
      <div class="bw-row">
        <button class="bw-primary" id="bwResume">Continuar</button>
        <button id="bwRestart">Reiniciar jogo</button>
        <button id="bwExit">Voltar à plataforma</button>
      </div>
      <hr style="border-color:#2a3853">
      <h3>Volume</h3>
      <label for="bwVolume">Volume do áudio do jogo</label>
      <input id="bwVolume" type="range" min="0" max="100" value="100">
      <p class="bw-muted" id="bwVolumeLabel">100%</p>
      <hr style="border-color:#2a3853">
      <h3>Jogadores nesta partida</h3>
      <p class="bw-muted">Peça amizade para alguém que está jogando com você.</p>
      <div id="bwPlayerList">Conectando ao multiplayer...</div>
      <p class="bw-muted" id="bwMenuStatus" aria-live="polite"></p>
    </section>`;
  document.body.appendChild(root);

  const toast = document.createElement("div");
  toast.id = "bwGameToast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);

  const $ = id => document.getElementById(id);
  let menuOpen = false;
  let knownIncoming = new Set();
  let pollBusy = false;
  let lastPlayers = [];
  let toastRequestId = null;
  let toastRequestName = "";

  function setStatus(message) {
    $("bwMenuStatus").textContent = message || "";
  }

  function setMenu(open) {
    menuOpen = !!open;
    root.style.display = menuOpen ? "flex" : "none";
    if (menuOpen) refreshPlayers();
  }

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      setMenu(!menuOpen);
    }
  });

  $("bwResume").addEventListener("click", () => setMenu(false));
  $("bwRestart").addEventListener("click", () => {
    if (confirm("Reiniciar este jogo?")) location.reload();
  });
  $("bwExit").addEventListener("click", () => {
    try {
      if (window.BWGame && typeof window.BWGame.leave === "function") {
        window.BWGame.leave();
      }
    } catch (error) {
      console.warn("[BW Menu] Não foi possível sair da sala:", error);
    }
    location.href = "/";
  });

  $("bwVolume").addEventListener("input", () => {
    const volume = Number($("bwVolume").value) / 100;
    $("bwVolumeLabel").textContent = Math.round(volume * 100) + "%";
    window.BWGameVolume = volume;
    document.querySelectorAll("audio,video").forEach(media => {
      media.volume = volume;
    });
  });

  function playerName(player) {
    return String(player && player.username || "Jogador").slice(0, 24);
  }

  async function sendFriendRequest(username) {
    setStatus("Enviando pedido para " + username + "...");
    try {
      const response = await fetch("/api/social/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Não foi possível enviar o pedido.");
      setStatus("Pedido de amizade enviado para " + username + ".");
    } catch (error) {
      setStatus(error.message || "Erro ao enviar o pedido.");
    }
  }

  function refreshPlayers() {
    const api = window.BWGame;
    if (!api || typeof api.getPlayers !== "function") {
      $("bwPlayerList").textContent = "Carregando jogadores...";
      return;
    }

    const players = api.getPlayers();
    lastPlayers = Array.isArray(players) ? players : [];
    const list = $("bwPlayerList");
    list.replaceChildren();

    const others = lastPlayers.filter(player => player && !player.isSelf);
    if (!others.length) {
      const empty = document.createElement("p");
      empty.className = "bw-muted";
      empty.textContent = "Nenhum outro jogador nesta partida no momento.";
      list.appendChild(empty);
      return;
    }

    others.forEach(player => {
      const row = document.createElement("div");
      row.className = "bw-player";
      const name = document.createElement("span");
      name.textContent = playerName(player);
      const button = document.createElement("button");
      button.textContent = "Pedir amizade";
      button.addEventListener("click", () => sendFriendRequest(playerName(player)));
      row.append(name, button);
      list.appendChild(row);
    });
  }

  function showRequest(request) {
    toastRequestId = String(request.id);
    toastRequestName = String(request.username || "Jogador");
    toast.replaceChildren();

    const title = document.createElement("strong");
    title.textContent = "Pedido de amizade";
    const text = document.createElement("p");
    text.textContent = toastRequestName + " pediu amizade.";
    const yes = document.createElement("button");
    yes.textContent = "Sim";
    const no = document.createElement("button");
    no.textContent = "Não";

    yes.addEventListener("click", () => answerRequest(true));
    no.addEventListener("click", () => answerRequest(false));
    toast.append(title, text, yes, no);
    toast.style.display = "block";
  }

  async function answerRequest(accept) {
    if (!toastRequestId) return;
    const userId = toastRequestId;
    const name = toastRequestName;
    toast.style.display = "none";
    toastRequestId = null;

    try {
      const response = await fetch(
        "/api/social/requests/" + encodeURIComponent(userId) +
          (accept ? "/accept" : ""),
        {
          method: accept ? "POST" : "DELETE",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: accept ? "{}" : undefined
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Não foi possível responder.");
      setStatus(accept ? "Agora você e " + name + " são amigos." : "Pedido recusado.");
      knownIncoming.add(userId);
      checkRequests();
    } catch (error) {
      setStatus(error.message || "Erro ao responder ao pedido.");
    }
  }

  async function checkRequests() {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const response = await fetch("/api/social/requests", {
        credentials: "same-origin",
        cache: "no-store"
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error("Entre na sua conta para usar os pedidos de amizade.");
      }
      if (!response.ok) throw new Error("Não foi possível consultar os pedidos.");
      const data = await response.json();
      const incoming = Array.isArray(data.incoming) ? data.incoming : [];

      const pendingIds = new Set(incoming.map(request => String(request.id)));
      for (const id of [...knownIncoming]) {
        if (!pendingIds.has(id)) knownIncoming.delete(id);
      }

      const next = incoming.find(request => !knownIncoming.has(String(request.id)));
      if (next && !toastRequestId) {
        knownIncoming.add(String(next.id));
        showRequest(next);
      }
    } catch (error) {
      if (menuOpen) setStatus(error.message || "Falha ao consultar pedidos.");
    } finally {
      pollBusy = false;
    }
  }

  window.addEventListener("bw:playerclick", event => {
    const detail = event.detail || {};
    if (!detail.username) return;
    if (confirm("Enviar pedido de amizade para " + playerName(detail) + "?")) {
      sendFriendRequest(playerName(detail));
    }
  });

  window.addEventListener("bw:playerschanged", () => {
    if (menuOpen) refreshPlayers();
  });

  // O menu usa a sessão autenticada da própria plataforma.
  checkRequests();
  setInterval(checkRequests, 5000);
  setInterval(() => { if (menuOpen) refreshPlayers(); }, 1500);

  // Disponibiliza uma forma simples de abrir o menu por outros scripts.
  window.BWOpenGameMenu = () => setMenu(true);
})();