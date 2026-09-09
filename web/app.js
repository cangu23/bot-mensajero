"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  authed: false,
  guildId: null,
  guilds: [],
  config: null,
  roles: [],
  channels: [],
  members: [],
  busy: false,
  refreshInterval: null,
  activeFilter: "all",
  searchQuery: "",
};

const PLATFORM_LABEL = { twitch: "Twitch", youtube: "YouTube", kick: "Kick" };
const PLATFORM_EMOJI = { twitch: "🟣", youtube: "🔴", kick: "🟢" };
const PLATFORM_COLOR = { twitch: "#9146FF", youtube: "#FF0000", kick: "#53FC18" };

// ── Helpers ────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Sesión caducada o no autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, type = "ok") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "< 1 min";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function setOptions(select, items, { value = "id", label = "name", placeholder = "" } = {}) {
  if (!select) return;
  select.innerHTML = "";
  if (placeholder !== null) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item[value];
    opt.textContent = item[label];
    select.appendChild(opt);
  }
}

// ── Pantallas ──────────────────────────────────────────────

function showLogin() {
  state.authed = false;
  if (state.refreshInterval) {
    clearInterval(state.refreshInterval);
    state.refreshInterval = null;
  }
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-password").focus();
}

function showApp() {
  state.authed = true;
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  initApp();
}

// ── Carga de datos ─────────────────────────────────────────

async function loadGuilds() {
  const data = await api("/api/guilds");
  state.guilds = data.guilds;
  const sel = $("#guild-select");
  setOptions(sel, data.guilds, { placeholder: null });
  if (!state.guildId && data.guilds.length > 0) state.guildId = data.guilds[0].id;
  sel.value = state.guildId ?? "";
}

async function loadConfig() {
  if (!state.guildId) return;
  const data = await api(`/api/config?guildId=${encodeURIComponent(state.guildId)}`);
  state.config = data;
  state.busy = data.status.busy;
  renderStatus();
  renderStatsOverview();
  renderStreamers();
  renderSettingsSelects();
}

async function loadRoles() {
  if (!state.guildId) return;
  const data = await api(`/api/roles?guildId=${encodeURIComponent(state.guildId)}`);
  state.roles = data.roles;
}

async function loadChannels() {
  if (!state.guildId) return;
  const data = await api(`/api/channels?guildId=${encodeURIComponent(state.guildId)}`);
  state.channels = data.channels;
}

async function loadMembers() {
  if (!state.guildId) return;
  const data = await api(`/api/members?guildId=${encodeURIComponent(state.guildId)}`);
  state.members = data.members;
}

// ── Render ─────────────────────────────────────────────────

function renderStatus() {
  const pill = $("#status-pill");
  const txt = $("#status-text");
  if (!state.config || !pill || !txt) return;
  const last = state.config.status.lastPollAt;
  pill.className = `pill pill-glow ${state.busy ? "busy" : "ok"}`;
  txt.textContent = state.busy ? "comprobando…" : `comprobado: ${timeAgo(last)}`;
  $("#check-now").disabled = state.busy;
}

function renderStatsOverview() {
  if (!state.config) return;
  const streamers = state.config.streamers ?? [];
  const twitchCount = streamers.filter((s) => s.platform === "twitch").length;
  const ytCount = streamers.filter((s) => s.platform === "youtube").length;
  const kickCount = streamers.filter((s) => s.platform === "kick").length;
  const liveCount = streamers.filter((s) => s.live).length;

  $("#stat-streamers-count").textContent = streamers.length;
  $("#stat-streamers-breakdown").textContent = `${twitchCount} T · ${ytCount} Y · ${kickCount} K`;
  $("#stat-live-count").textContent = liveCount;
  $("#tab-count-streamers").textContent = streamers.length;

  const isTwitchOk = state.config.status.twitchConfigured;
  const twitchBadge = $("#stat-twitch-status");
  if (twitchBadge) {
    twitchBadge.textContent = isTwitchOk ? "Conectado ✓" : "Falta API Key";
    twitchBadge.className = `stat-badge ${isTwitchOk ? "ok" : "err"}`;
  }

  const twitchDetailBadge = $("#twitch-status-badge");
  if (twitchDetailBadge) {
    twitchDetailBadge.textContent = isTwitchOk ? "Conectado ✓" : "Sin credenciales ✗";
    twitchDetailBadge.className = `badge ${isTwitchOk ? "badge-success" : "badge-err"}`;
  }

  const credClientId = $("#cred-client-id");
  if (credClientId) {
    credClientId.textContent = state.config.status.twitchClientIdMasked || "No configurado";
  }

  const pollInterval = state.config.status.pollIntervalSeconds;
  const pollEl = $("#stat-poll-interval");
  if (pollEl && pollInterval) {
    pollEl.textContent = `${pollInterval}s`;
  }
}

function renderStreamers() {
  const container = $("#streamers-list");
  if (!container) return;
  container.innerHTML = "";
  const allStreamers = state.config?.streamers ?? [];

  // Filtrado
  const query = state.searchQuery.toLowerCase().trim();
  const filter = state.activeFilter;

  const filtered = allStreamers.filter((s) => {
    if (filter === "twitch" && s.platform !== "twitch") return false;
    if (filter === "youtube" && s.platform !== "youtube") return false;
    if (filter === "kick" && s.platform !== "kick") return false;
    if (filter === "live" && !s.live) return false;

    if (query) {
      const matchName = s.displayName.toLowerCase().includes(query);
      const matchChannel = s.channel.toLowerCase().includes(query);
      const matchPlatform = s.platform.toLowerCase().includes(query);
      if (!matchName && !matchChannel && !matchPlatform) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    if (allStreamers.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📡</span>
          <h4 class="empty-title">Aún no hay streamers en vigilancia</h4>
          <p class="empty-subtitle">Añade creadores de Twitch, YouTube o Kick para que el bot avise a tu comunidad en cuanto empiecen directo.</p>
          <button class="btn primary btn-glow" onclick="openModal()">＋ Añadir tu primer streamer</button>
        </div>`;
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔍</span>
          <h4 class="empty-title">No hay coincidencias</h4>
          <p class="empty-subtitle">Ningún streamer coincide con los filtros aplicados.</p>
        </div>`;
    }
    return;
  }

  for (const s of filtered) {
    const card = document.createElement("div");
    card.className = `card streamer-card plat-${s.platform}`;

    // Columna Principal
    const main = document.createElement("div");
    main.className = "streamer-main";

    const avatar = document.createElement("div");
    avatar.className = "streamer-avatar";
    const colorHex = s.color ? `#${s.color.toString(16).padStart(6, "0")}` : PLATFORM_COLOR[s.platform];
    avatar.style.borderColor = colorHex;
    avatar.style.background = `${colorHex}18`;

    const avatarSrc = s.avatarUrl || `/api/avatar?platform=${s.platform}&channel=${encodeURIComponent(s.channel)}`;
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.src = avatarSrc;
    img.alt = s.displayName || s.channel;
    img.loading = "lazy";
    img.onerror = () => {
      img.style.display = "none";
      if (!avatar.querySelector(".avatar-fallback")) {
        const fallback = document.createElement("span");
        fallback.className = "avatar-fallback";
        fallback.textContent = PLATFORM_EMOJI[s.platform] || "📡";
        avatar.appendChild(fallback);
      }
    };
    avatar.appendChild(img);

    const nameGroup = document.createElement("div");
    nameGroup.className = "streamer-name-group";

    const name = document.createElement("div");
    name.className = "streamer-name";
    name.innerHTML = `${esc(s.displayName)} ${s.enabled ? "" : '<span class="paused-tag">Pausado</span>'}`;

    const link = document.createElement("a");
    link.className = "streamer-channel-link";
    link.href = s.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.innerHTML = `<span>${esc(s.channel)}</span> · <span style="color:${PLATFORM_COLOR[s.platform]};font-weight:600">${PLATFORM_LABEL[s.platform]}</span> ↗`;

    nameGroup.append(name, link);
    main.append(avatar, nameGroup);

    // Badge de estado de directo
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "badge-group";
    if (s.live) {
      const badge = document.createElement("span");
      badge.className = "badge live";
      badge.innerHTML = `<span class="dot live"></span> EN DIRECTO`;
      badgeWrap.appendChild(badge);

      const liveMeta = document.createElement("div");
      liveMeta.className = "live-meta-info";
      if (s.liveTitle) {
        const titleEl = document.createElement("span");
        titleEl.className = "live-title-preview";
        titleEl.title = s.liveTitle;
        titleEl.textContent = s.liveTitle;
        liveMeta.appendChild(titleEl);
      }
      if (s.startedAt) {
        const durEl = document.createElement("span");
        durEl.textContent = `Empezó ${timeAgo(s.startedAt)}`;
        liveMeta.appendChild(durEl);
      }
      badgeWrap.appendChild(liveMeta);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge off";
      badge.textContent = "⚪ Fuera de directo";
      badgeWrap.appendChild(badge);
    }

    // Chips de configuración
    const chipsWrap = document.createElement("div");
    chipsWrap.className = "streamer-chips-wrap";

    if (s.notifyChannelName) {
      const chip = document.createElement("span");
      chip.className = "meta-chip";
      chip.innerHTML = `<strong>#</strong> ${esc(s.notifyChannelName)}`;
      chipsWrap.appendChild(chip);
    }

    if (s.mentionRoleName || s.mentionRoleId) {
      const chip = document.createElement("span");
      chip.className = "meta-chip";
      const mId = s.mentionRoleId || "";
      const mName = s.mentionRoleName || "";
      const label = (mId === "everyone" || mName === "everyone") ? "everyone" : (mId === "here" || mName === "here") ? "here" : mName;
      chip.innerHTML = `<strong>@</strong> ${esc(label)}`;
      chipsWrap.appendChild(chip);
    }

    if (s.discordUserName) {
      const chip = document.createElement("span");
      chip.className = "meta-chip";
      chip.innerHTML = `👤 ${esc(s.discordUserName)}`;
      chipsWrap.appendChild(chip);
    }

    if (s.color) {
      const chip = document.createElement("span");
      chip.className = "meta-chip color-chip";
      const hex = `#${s.color.toString(16).padStart(6, "0")}`;
      chip.innerHTML = `<span class="color-circle" style="background:${hex}"></span> ${hex}`;
      chipsWrap.appendChild(chip);
    }

    // Acciones rápidas
    const actions = document.createElement("div");
    actions.className = "streamer-actions";

    // Toggle rápido de pausa/activar
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "btn quick-toggle-btn";
    toggleBtn.title = s.enabled ? "Pausar vigilancia" : "Reanudar vigilancia";
    toggleBtn.innerHTML = s.enabled ? "⏸ Pausar" : "▶ Reanudar";
    toggleBtn.addEventListener("click", () => toggleStreamerActive(s));

    const editBtn = document.createElement("button");
    editBtn.className = "btn";
    editBtn.innerHTML = "✏️ Editar";
    editBtn.addEventListener("click", () => openModal(s));

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.innerHTML = "🗑";
    delBtn.title = "Eliminar";
    delBtn.addEventListener("click", () => removeStreamer(s));

    actions.append(toggleBtn, editBtn, delBtn);

    card.append(main, badgeWrap, chipsWrap, actions);
    container.appendChild(card);
  }
}

async function toggleStreamerActive(streamer) {
  try {
    const newEnabled = !streamer.enabled;
    await api(`/api/streamers/${encodeURIComponent(streamer.id)}?guildId=${encodeURIComponent(state.guildId)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: newEnabled }),
    });
    toast(newEnabled ? `Vigilancia activada para ${streamer.displayName}` : `Vigilancia pausada para ${streamer.displayName}`);
    await loadConfig();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function renderHistory() {
  const container = $("#history-list");
  if (!container) return;
  container.innerHTML = "";
  const streamerId = $("#history-filter")?.value || "";
  const data = await api(
    `/api/history?guildId=${encodeURIComponent(state.guildId)}${streamerId ? `&streamerId=${encodeURIComponent(streamerId)}` : ""}&limit=100`,
  );

  $("#tab-count-history").textContent = data.entries.length;

  const filter = $("#history-filter");
  if (filter && filter.dataset.loaded !== state.guildId + ":" + JSON.stringify(data.streamers.map((s) => s.streamerId))) {
    filter.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Todos los streamers";
    filter.appendChild(all);
    for (const s of data.streamers) {
      const opt = document.createElement("option");
      opt.value = s.streamerId;
      opt.textContent = `${PLATFORM_EMOJI[s.platform] || ""} ${s.displayName}`;
      filter.appendChild(opt);
    }
    filter.dataset.loaded = state.guildId + ":" + JSON.stringify(data.streamers.map((s) => s.streamerId));
    filter.value = streamerId;
  }

  if (data.entries.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📜</span><h4 class="empty-title">Sin transmisiones registradas</h4><p class="empty-subtitle">Cuando un creador empiece y finalice un directo, se guardará aquí el registro con sus estadísticas.</p></div>';
    return;
  }

  for (const h of data.entries) {
    const card = document.createElement("div");
    card.className = "card history-row";

    const dot = document.createElement("span");
    dot.className = `dot ${h.endedAt ? "off" : "live"}`;

    const titleWrap = document.createElement("div");
    titleWrap.className = "history-title";
    const title = document.createElement("div");
    title.innerHTML = `<strong>${PLATFORM_EMOJI[h.platform]} ${esc(h.displayName)}</strong>${h.title ? ` · ${esc(h.title)}` : ""}`;

    const sub = document.createElement("div");
    sub.className = "history-meta";
    const startEnd = h.endedAt
      ? `${fmtDateTime(h.startedAt)} → ${fmtDateTime(h.endedAt)}`
      : `en curso desde ${fmtDateTime(h.startedAt)}`;
    const dur = fmtDuration(h.endedAt ? new Date(h.endedAt) - new Date(h.startedAt) : Date.now() - new Date(h.startedAt));
    sub.innerHTML = `<span>📅 ${startEnd}</span><span>⏱️ ${dur}</span><span>👀 Pico: ${(h.peakViewers || 0).toLocaleString("es-ES")}</span>`;

    titleWrap.append(title, sub);

    const stateBadge = document.createElement("span");
    stateBadge.className = h.endedAt ? "badge off" : "badge live";
    stateBadge.textContent = h.endedAt ? "Finalizado" : "EN CURSO";

    card.append(dot, titleWrap, stateBadge);
    container.appendChild(card);
  }
}

function renderSettingsSelects() {
  const cfg = state.config;
  if (!cfg) return;

  setOptions($("#cfg-channel"), state.channels, {
    value: "id",
    label: "name",
    placeholder: "— Elige el canal general de avisos —",
  });
  $("#cfg-channel").value = cfg.config.notifyChannelId ?? "";

  setOptions($("#cfg-live-role"), state.roles, { placeholder: "— Sin rol —" });
  $("#cfg-live-role").value = cfg.config.liveRoleId ?? "";

  setOptions($("#cfg-offline-role"), state.roles, { placeholder: "— Sin rol —" });
  $("#cfg-offline-role").value = cfg.config.offlineRoleId ?? "";
}

// ── Test de Twitch API ─────────────────────────────────────

async function testTwitchConnection() {
  const btn = $("#btn-test-twitch");
  const resultBox = $("#twitch-test-result");
  if (!btn || !resultBox) return;

  btn.disabled = true;
  btn.innerHTML = "<span>⏳ Probando...</span>";
  resultBox.className = "test-result-box hidden";

  try {
    const data = await api("/api/test-twitch", { method: "POST" });
    resultBox.className = "test-result-box ok";
    resultBox.innerHTML = `✅ <strong>Conexión con Twitch Exitosa:</strong> Token verificado, latencia ${data.latencyMs} ms. Respuesta de canal oficial recibida.`;
    resultBox.classList.remove("hidden");
    toast("Twitch API respondió con éxito");
  } catch (err) {
    resultBox.className = "test-result-box err";
    resultBox.innerHTML = `❌ <strong>Error conectando con Twitch:</strong> ${esc(err.message)}`;
    resultBox.classList.remove("hidden");
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "<span>⚡ Probar API</span>";
  }
}

// ── Modal: Añadir / Editar Streamer ────────────────────────

function autoDetectPlatform(input) {
  const s = input.toLowerCase();
  if (s.includes("twitch.tv")) return "twitch";
  if (s.includes("youtube.com") || s.includes("youtu.be")) return "youtube";
  if (s.includes("kick.com")) return "kick";
  return null;
}

function updateSelectedPlatformCard(platform) {
  $$(".platform-option input").forEach((radio) => {
    radio.checked = radio.value === platform;
  });
  $("#sf-platform").value = platform;
  updateDiscordMockup();
}

function updateDiscordMockup() {
  const platform = $("#sf-platform").value || "twitch";
  const channelVal = $("#sf-channel").value.trim() || "Canal de Transmisión";
  const colorHex = $("#sf-color").value.trim() || PLATFORM_COLOR[platform] || "#9146FF";
  const customMsg = $("#sf-message").value.trim();

  // Borde
  const bar = $("#preview-border");
  if (bar) bar.style.background = colorHex;

  // Canal icono
  const previewAvatar = $("#preview-avatar");
  if (previewAvatar) previewAvatar.textContent = PLATFORM_EMOJI[platform] || "🟣";

  // Canal nombre
  const previewChannelName = $("#preview-channel-name");
  if (previewChannelName) previewChannelName.textContent = `${channelVal} · ${PLATFORM_LABEL[platform]}`;

  // Título
  const previewTitle = $("#preview-title-text");
  if (previewTitle) previewTitle.textContent = `🔴 ¡${channelVal} está en directo ahora!`;

  // Mención
  const mentionLine = $("#discord-preview-mention");
  const pingSelect = $("#sf-ping-role");
  const pingVal = pingSelect ? pingSelect.value : "";
  let pingText = "@notificaciones";
  if (pingVal === "everyone") {
    pingText = "@everyone";
  } else if (pingVal === "here") {
    pingText = "@here";
  } else if (pingVal && pingSelect?.selectedOptions[0]) {
    pingText = pingSelect.selectedOptions[0].textContent;
  }
  if (mentionLine) {
    if (pingVal) {
      mentionLine.innerHTML = `<span class="discord-mention-pill">${esc(pingText)}</span> ${esc(customMsg || "¡Atención a todos, empezó el directo!")}`;
      mentionLine.classList.remove("hidden");
    } else if (customMsg) {
      mentionLine.innerHTML = `${esc(customMsg)}`;
      mentionLine.classList.remove("hidden");
    } else {
      mentionLine.innerHTML = "";
      mentionLine.classList.add("hidden");
    }
  }

  // Banner en vista previa
  const bannerBox = $("#preview-banner-box");
  if (bannerBox) {
    if (platform === "twitch") {
      bannerBox.style.background = "linear-gradient(135deg, rgba(145, 70, 255, 0.25), rgba(88, 101, 242, 0.25))";
      bannerBox.style.borderColor = "rgba(145, 70, 255, 0.5)";
      bannerBox.innerHTML = `<span>🖼️ Banner oficial de Twitch de <strong>${esc(channelVal)}</strong></span>`;
    } else {
      bannerBox.style.background = "linear-gradient(135deg, rgba(255, 0, 51, 0.15), rgba(88, 101, 242, 0.15))";
      bannerBox.style.borderColor = "rgba(255, 255, 255, 0.2)";
      bannerBox.innerHTML = `<span>🖼️ Miniatura del directo (${PLATFORM_LABEL[platform]})</span>`;
    }
  }
}

async function openModal(streamer = null) {
  await Promise.all([loadRoles(), loadMembers(), loadChannels()]);
  $("#modal").classList.remove("hidden");
  $("#sf-error").classList.add("hidden");
  const form = $("#streamer-form");
  form.reset();

  setOptions($("#sf-channel-notify"), state.channels, { placeholder: "— Usar canal global del servidor —" });
  setOptions($("#sf-user"), state.members, { value: "id", label: "tag", placeholder: "— Ninguno —" });
  setOptions($("#sf-live-role"), state.roles, { placeholder: "— Usar ajuste global del servidor —" });
  setOptions($("#sf-offline-role"), state.roles, { placeholder: "— Usar ajuste global del servidor —" });

  // Poblar opciones de ping con @everyone, @here y roles
  const pingSelect = $("#sf-ping-role");
  pingSelect.innerHTML = "";
  
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "— Sin mención (solo embed) —";
  pingSelect.appendChild(optNone);

  const optEveryone = document.createElement("option");
  optEveryone.value = "everyone";
  optEveryone.textContent = "📢 @everyone (Mencionar a todos)";
  pingSelect.appendChild(optEveryone);

  const optHere = document.createElement("option");
  optHere.value = "here";
  optHere.textContent = "🟢 @here (Mencionar a los conectados)";
  pingSelect.appendChild(optHere);

  if (state.roles && state.roles.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Roles del servidor";
    for (const r of state.roles) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `@${r.name}`;
      group.appendChild(opt);
    }
    pingSelect.appendChild(group);
  }

  const detectBadge = $("#sf-detect-badge");
  if (detectBadge) detectBadge.classList.add("hidden");

  if (streamer) {
    $("#modal-title").textContent = `Editar a ${streamer.displayName}`;
    $("#sf-id").value = streamer.id;
    updateSelectedPlatformCard(streamer.platform);
    $("#sf-channel").value = streamer.channel;
    $$(".platform-option input").forEach((r) => (r.disabled = true));
    $("#sf-channel").disabled = true;
    $("#sf-channel").dataset.lockAuto = "1";
    $("#sf-channel-notify").value = streamer.notifyChannelId ?? "";
    $("#sf-user").value = streamer.discordUserId ?? "";
    $("#sf-ping-role").value = streamer.mentionRoleId ?? "";
    $("#sf-live-role").value = streamer.liveRoleId ?? "";
    $("#sf-offline-role").value = streamer.offlineRoleId ?? "";
    const color = streamer.color ? `#${streamer.color.toString(16).padStart(6, "0")}` : PLATFORM_COLOR[streamer.platform];
    $("#sf-color").value = color;
    $("#sf-color-native").value = color.startsWith("#") && color.length === 7 ? color : "#9146FF";
    $("#sf-message").value = streamer.message ?? "";
    $("#sf-enabled").checked = streamer.enabled;
  } else {
    $("#modal-title").textContent = "Añadir Nuevo Streamer";
    $("#sf-id").value = "";
    $$(".platform-option input").forEach((r) => (r.disabled = false));
    $("#sf-channel").disabled = false;
    $("#sf-channel").dataset.lockAuto = "";
    updateSelectedPlatformCard("twitch");
    $("#sf-color").value = "#9146FF";
    $("#sf-color-native").value = "#9146FF";
    $("#sf-enabled").checked = true;
  }

  updateDiscordMockup();
  $("#sf-channel").focus();
}

function closeModal() {
  $("#modal").classList.add("hidden");
}

async function submitStreamer(e) {
  e.preventDefault();
  const id = $("#sf-id").value;
  const submitBtn = $("#sf-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Guardando…";

  const body = {
    platform: $("#sf-platform").value,
    channel: $("#sf-channel").value.trim(),
    notifyChannelId: $("#sf-channel-notify").value || null,
    discordUserId: $("#sf-user").value || null,
    mentionRoleId: $("#sf-ping-role").value || null,
    liveRoleId: $("#sf-live-role").value || null,
    offlineRoleId: $("#sf-offline-role").value || null,
    color: $("#sf-color").value.trim() || null,
    message: $("#sf-message").value.trim() || null,
    enabled: $("#sf-enabled").checked,
  };

  try {
    if (id) {
      delete body.platform;
      delete body.channel;
      await api(`/api/streamers/${encodeURIComponent(id)}?guildId=${encodeURIComponent(state.guildId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      toast("Streamer actualizado con éxito");
    } else {
      await api(`/api/streamers?guildId=${encodeURIComponent(state.guildId)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast("Streamer añadido y vigilancia iniciada");
    }
    closeModal();
    await loadConfig();
  } catch (err) {
    const errEl = $("#sf-error");
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Guardar Streamer";
  }
}

async function removeStreamer(s) {
  if (!confirm(`¿Eliminar a "${s.displayName}" de la lista de vigilancia?`)) return;
  try {
    await api(`/api/streamers/${encodeURIComponent(s.id)}?guildId=${encodeURIComponent(state.guildId)}`, {
      method: "DELETE",
    });
    toast(`"${s.displayName}" eliminado`);
    await loadConfig();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ── Modal: Añadir Varios ───────────────────────────────────

function openBulkModal() {
  $("#modal-bulk").classList.remove("hidden");
  $("#bulk-result").innerHTML = "";
  $("#bulk-input").focus();
}

function closeBulkModal() {
  $("#modal-bulk").classList.add("hidden");
}

async function submitBulk() {
  const lines = $("#bulk-input").value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    toast("Escribe al menos un canal o URL", "error");
    return;
  }
  const btn = $("#bulk-submit");
  btn.disabled = true;
  btn.textContent = "Añadiendo…";
  try {
    const data = await api(`/api/streamers/bulk?guildId=${encodeURIComponent(state.guildId)}`, {
      method: "POST",
      body: JSON.stringify({ channels: lines }),
    });
    const box = $("#bulk-result");
    box.innerHTML = "";
    const addLine = (cls, text) => {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      box.appendChild(p);
    };
    if (data.added.length) addLine("ok", `✅ Añadidos (${data.added.length}): ${data.added.map((s) => s.displayName).join(", ")}`);
    if (data.duplicates.length) addLine("warn", `⚠️ Ya estaban vigilados: ${data.duplicates.join(", ")}`);
    for (const e of data.errors) addLine("err", `❌ ${e.input}: ${e.error}`);
    if (data.added.length === 0 && data.errors.length === 0 && data.duplicates.length === 0) {
      addLine("warn", "No se añadió nada.");
    }
    $("#bulk-input").value = "";
    await loadConfig();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Añadir Lista";
  }
}

// ── Ajustes Globales ───────────────────────────────────────

async function saveConfig() {
  const btn = $("#save-config");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  const body = {
    notifyChannelId: $("#cfg-channel").value || null,
    liveRoleId: $("#cfg-live-role").value || null,
    offlineRoleId: $("#cfg-offline-role").value || null,
  };
  try {
    await api(`/api/config?guildId=${encodeURIComponent(state.guildId)}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    toast("Ajustes del gremio guardados correctamente");
    await loadConfig();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "<span>💾 Guardar Ajustes del Gremio</span>";
  }
}

// ── Acciones Globales ──────────────────────────────────────

async function checkNow() {
  const btn = $("#check-now");
  try {
    btn.disabled = true;
    btn.innerHTML = "<span>⏳ Comprobando...</span>";
    const data = await api(`/api/check?guildId=${encodeURIComponent(state.guildId)}`, { method: "POST" });
    const s = data.summary;
    toast(`Comprobación lista: ${s.live} en directo · ${s.offline} terminados · ${s.skipped} sin respuesta`);
    await loadConfig();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">⚡</span><span>Comprobar</span>';
  }
}

// ── Inicialización de Eventos ──────────────────────────────

function initApp() {
  if (state.initialized) return;
  state.initialized = true;

  // Pestañas
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
      const panel = $(`#tab-${tab.dataset.tab}`);
      if (panel) panel.classList.remove("hidden");
      if (tab.dataset.tab === "history") renderHistory();
      if (tab.dataset.tab === "settings") {
        Promise.all([loadRoles(), loadChannels()]).then(renderSettingsSelects);
      }
    });
  });

  // Filtros de streamers
  $$(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.activeFilter = chip.dataset.filter;
      renderStreamers();
    });
  });

  // Buscador de streamers
  $("#streamer-search")?.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderStreamers();
  });

  // Botones principales
  $("#add-streamer")?.addEventListener("click", () => openModal());
  $("#bulk-streamer")?.addEventListener("click", openBulkModal);
  $("#bulk-cancel")?.addEventListener("click", closeBulkModal);
  $("#bulk-top-close")?.addEventListener("click", closeBulkModal);
  $("#bulk-submit")?.addEventListener("click", submitBulk);
  $("#modal-cancel")?.addEventListener("click", closeModal);
  $("#modal-top-close")?.addEventListener("click", closeModal);
  $("#save-config")?.addEventListener("click", saveConfig);
  $("#check-now")?.addEventListener("click", checkNow);
  $("#btn-test-twitch")?.addEventListener("click", testTwitchConnection);

  $("#logout")?.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    showLogin();
  });

  $("#history-filter")?.addEventListener("change", renderHistory);

  $("#guild-select")?.addEventListener("change", async (e) => {
    state.guildId = e.target.value;
    state.config = null;
    await loadConfig();
    renderHistory();
    Promise.all([loadRoles(), loadChannels()]).then(renderSettingsSelects);
  });

  // Cierre de modales al clickear fuera
  $("#modal")?.addEventListener("click", (e) => {
    if (e.target === $("#modal")) closeModal();
  });
  $("#modal-bulk")?.addEventListener("click", (e) => {
    if (e.target === $("#modal-bulk")) closeBulkModal();
  });

  // Selector visual de plataforma en el modal
  $$(".platform-option input").forEach((radio) => {
    radio.addEventListener("change", (e) => {
      $("#sf-platform").value = e.target.value;
      const defaultCol = PLATFORM_COLOR[e.target.value];
      if (defaultCol) {
        $("#sf-color").value = defaultCol;
        $("#sf-color-native").value = defaultCol;
      }
      updateDiscordMockup();
    });
  });

  // Auto-detección al escribir o pegar URL
  $("#sf-channel")?.addEventListener("input", (e) => {
    if (e.target.dataset.lockAuto) return;
    const detected = autoDetectPlatform(e.target.value);
    const badge = $("#sf-detect-badge");
    if (detected) {
      updateSelectedPlatformCard(detected);
      if (badge) {
        badge.textContent = `Auto: ${PLATFORM_LABEL[detected]}`;
        badge.classList.remove("hidden");
      }
    } else if (badge) {
      badge.classList.add("hidden");
    }
    updateDiscordMockup();
  });

  // Sincronización de color
  $("#sf-color-native")?.addEventListener("input", (e) => {
    $("#sf-color").value = e.target.value;
    updateDiscordMockup();
  });
  $("#sf-color")?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    if (val.startsWith("#") && (val.length === 7 || val.length === 4)) {
      $("#sf-color-native").value = val;
    }
    updateDiscordMockup();
  });

  // Color swatches (paleta rápida)
  $$(".swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      const col = sw.dataset.color;
      $("#sf-color").value = col;
      $("#sf-color-native").value = col;
      updateDiscordMockup();
    });
  });

  // Mensaje personalizado y ping en mockup
  $("#sf-message")?.addEventListener("input", updateDiscordMockup);
  $("#sf-ping-role")?.addEventListener("change", updateDiscordMockup);

  // Chips de plantillas para añadir varios
  $$(".btn-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const textarea = $("#bulk-input");
      const sample = chip.dataset.sample;
      if (textarea.value.trim()) {
        textarea.value += "\n" + sample;
      } else {
        textarea.value = sample;
      }
    });
  });

  $("#streamer-form")?.addEventListener("submit", submitStreamer);
}

// ── Inicialización General ─────────────────────────────────

async function init() {
  try {
    const data = await api("/api/auth/status");
    if (data.authenticated) {
      await loadGuilds();
      if (!state.guildId) {
        showLogin();
        $("#login-password").value = "";
        $("#login-password").placeholder = "El bot no está en ningún servidor";
        return;
      }
      showApp();
      await loadConfig();
      if (state.refreshInterval) clearInterval(state.refreshInterval);
      state.refreshInterval = setInterval(() => {
        if (state.authed && state.guildId) loadConfig().catch(() => {});
      }, 10000);
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

$("#login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#login-error");
  const submitBtn = $("#btn-login-submit");
  errEl.classList.add("hidden");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = "<span>Verificando...</span>";
  }

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    state.guildId = null;
    state.initialized = false;
    state.config = null;
    await loadGuilds();
    if (!state.guildId) {
      toast("El bot no está en ningún servidor", "error");
      return;
    }
    showApp();
    await loadConfig();
    if (state.refreshInterval) clearInterval(state.refreshInterval);
    state.refreshInterval = setInterval(() => {
      if (state.authed && state.guildId) loadConfig().catch(() => {});
    }, 10000);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
    $("#login-password").value = "";
    $("#login-password").focus();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Acceder al Panel</span><span class="arrow-icon">→</span>';
    }
  }
});

init();