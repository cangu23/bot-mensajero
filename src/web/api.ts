import { Client, Guild } from "discord.js";
import { env, twitchConfigured } from "../env.js";
import { log } from "../logger.js";
import { Monitor } from "../monitor.js";
import { adapters } from "../platforms/index.js";
import { getTwitchAvatar } from "../platforms/twitch.js";
import { getKickAvatar } from "../platforms/kick.js";
import { getYoutubeAvatar } from "../platforms/youtube.js";
import { applyOffline } from "../roles.js";
import { Store } from "../store.js";
import { cleanHandle, detectPlatformFromInput, parseColor, platformUrl } from "../util.js";
import type { Platform, Streamer } from "../types.js";

export interface ApiContext {
  url: URL;
  method: string;
  body: unknown;
  client: Client;
  store: Store;
  monitor: Monitor;
  sendJson: (status: number, data: unknown) => void;
}

const PLATFORMS: Platform[] = ["twitch", "youtube", "kick"];
const NAME_TTL_MS = 30_000;
const nameCache = new Map<string, { value: string | null; exp: number }>();

const avatarCache = new Map<string, { url: string; exp: number }>();

export async function resolveAvatar(platform: Platform, channel: string): Promise<string | null> {
  const key = `${platform}:${channel.toLowerCase()}`;
  const hit = avatarCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.url;

  let url: string | null = null;
  try {
    if (platform === "twitch") url = await getTwitchAvatar(channel);
    else if (platform === "kick") url = await getKickAvatar(channel);
    else if (platform === "youtube") url = await getYoutubeAvatar(channel);
  } catch {
    url = null;
  }

  if (url) {
    avatarCache.set(key, { url, exp: Date.now() + 4 * 3600 * 1000 });
  }
  return url;
}

async function cachedName(key: string, loader: () => Promise<string | null>): Promise<string | null> {
  const hit = nameCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (hit) nameCache.delete(key);
  const value = await loader();
  nameCache.set(key, { value, exp: Date.now() + NAME_TTL_MS });
  return value;
}

function resolveRoleName(guild: Guild, roleId: string): Promise<string | null> {
  if (roleId === "everyone" || roleId === guild.id) return Promise.resolve("everyone");
  if (roleId === "here") return Promise.resolve("here");
  return cachedName(`role:${guild.id}:${roleId}`, async () => {
    try {
      const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
      return role?.name ?? null;
    } catch {
      return null;
    }
  });
}

function resolveChannelName(guild: Guild, channelId: string): Promise<string | null> {
  return cachedName(`channel:${guild.id}:${channelId}`, async () => {
    try {
      const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
      return ch?.name ?? null;
    } catch {
      return null;
    }
  });
}

function resolveMemberName(guild: Guild, userId: string): Promise<string | null> {
  return cachedName(`member:${guild.id}:${userId}`, async () => {
    try {
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
      return member?.user.tag ?? null;
    } catch {
      return null;
    }
  });
}

async function resolveGuild(ctx: ApiContext): Promise<Guild | null> {
  const requested = ctx.url.searchParams.get("guildId");
  const id = requested ?? ctx.client.guilds.cache.first()?.id;
  if (!id) {
    ctx.sendJson(409, { error: "El bot no está en ningún servidor." });
    return null;
  }
  let guild = ctx.client.guilds.cache.get(id);
  if (!guild) {
    try {
      guild = await ctx.client.guilds.fetch(id);
    } catch {
      ctx.sendJson(404, { error: "Servidor no encontrado." });
      return null;
    }
  }
  return guild;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function handleApi(ctx: ApiContext): Promise<void> {
  const { url, method } = ctx;
  const path = url.pathname;
  try {
    if (path === "/api/guilds" && method === "GET") return apiGuilds(ctx);
    if (path === "/api/config" && method === "GET") return apiGetConfig(ctx);
    if (path === "/api/config" && method === "POST") return apiPostConfig(ctx);
    if (path === "/api/roles" && method === "GET") return apiRoles(ctx);
    if (path === "/api/channels" && method === "GET") return apiChannels(ctx);
    if (path === "/api/members" && method === "GET") return apiMembers(ctx);
    if (path === "/api/streamers" && method === "POST") return apiAddStreamer(ctx);
    if (path === "/api/streamers/bulk" && method === "POST") return apiBulkAddStreamers(ctx);
    if (path === "/api/check" && method === "POST") return apiCheck(ctx);
    if (path === "/api/history" && method === "GET") return apiHistory(ctx);
    if (path === "/api/test-twitch" && method === "POST") return apiTestTwitch(ctx);
    const match = path.match(/^\/api\/streamers\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1] ?? "");
      if (method === "PUT") return apiUpdateStreamer(ctx, id);
      if (method === "DELETE") return apiDeleteStreamer(ctx, id);
    }
    ctx.sendJson(404, { error: "Endpoint no encontrado" });
  } catch (e) {
    log("❌ Panel: error en API:", e instanceof Error ? e.stack ?? e.message : String(e));
    ctx.sendJson(500, { error: "Error interno del servidor" });
  }
}

async function apiTestTwitch(ctx: ApiContext): Promise<void> {
  if (!twitchConfigured()) {
    ctx.sendJson(400, { ok: false, error: "Twitch no está configurado en .env" });
    return;
  }
  const t0 = Date.now();
  try {
    const res = await adapters.twitch.resolve("twitch");
    const latencyMs = Date.now() - t0;
    if (!res) {
      ctx.sendJson(502, { ok: false, error: "Twitch API no respondió correctamente. Verifica tus credenciales." });
      return;
    }
    ctx.sendJson(200, { ok: true, latencyMs, channel: res.displayName });
  } catch (e) {
    ctx.sendJson(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function apiGuilds(ctx: ApiContext): void {
  const guilds = ctx.client.guilds.cache.map((g) => ({ id: g.id, name: g.name }));
  ctx.sendJson(200, { guilds });
}

async function apiGetConfig(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const cfg = ctx.store.getGuild(guild.id);
  const streamers = await Promise.all(
    cfg.streamers.map(async (s) => {
      const st = ctx.store.getState(s.id);
      let avatarUrl = avatarCache.get(`${s.platform}:${s.channel.toLowerCase()}`)?.url ?? null;
      if (!avatarUrl) {
        try {
          avatarUrl = await resolveAvatar(s.platform, s.channel);
        } catch {
          avatarUrl = null;
        }
      }
      return {
        ...s,
        avatarUrl: avatarUrl ?? `/api/avatar?platform=${s.platform}&channel=${encodeURIComponent(s.channel)}`,
        url: platformUrl(s.platform, s.channel),
        live: st.isLive,
        liveTitle: st.title,
        startedAt: st.startedAt,
        notifyChannelName: s.notifyChannelId ? await resolveChannelName(guild, s.notifyChannelId) : null,
        discordUserName: s.discordUserId ? await resolveMemberName(guild, s.discordUserId) : null,
        mentionRoleName: s.mentionRoleId ? await resolveRoleName(guild, s.mentionRoleId) : null,
        liveRoleName: s.liveRoleId ? await resolveRoleName(guild, s.liveRoleId) : null,
        offlineRoleName: s.offlineRoleId ? await resolveRoleName(guild, s.offlineRoleId) : null,
      };
    }),
  );
  ctx.sendJson(200, {
    guild: { id: guild.id, name: guild.name },
    config: {
      notifyChannelId: cfg.notifyChannelId,
      notifyChannelName: cfg.notifyChannelId ? await resolveChannelName(guild, cfg.notifyChannelId) : null,
      liveRoleId: cfg.liveRoleId,
      liveRoleName: cfg.liveRoleId ? await resolveRoleName(guild, cfg.liveRoleId) : null,
      offlineRoleId: cfg.offlineRoleId,
      offlineRoleName: cfg.offlineRoleId ? await resolveRoleName(guild, cfg.offlineRoleId) : null,
    },
    streamers,
    status: {
      lastPollAt: ctx.monitor.lastPollAt?.toISOString() ?? null,
      pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
      twitchConfigured: twitchConfigured(),
      twitchClientIdMasked: env.TWITCH_CLIENT_ID ? `${env.TWITCH_CLIENT_ID.slice(0, 8)}...${env.TWITCH_CLIENT_ID.slice(-4)}` : null,
      guildCount: ctx.client.guilds.cache.size,
      botUser: {
        id: ctx.client.user?.id,
        tag: ctx.client.user?.tag,
        avatar: ctx.client.user?.displayAvatarURL(),
      },
      busy: ctx.monitor.isBusy(),
    },
  });
}

async function apiPostConfig(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const cfg = ctx.store.getGuild(guild.id);
  if ("notifyChannelId" in body) cfg.notifyChannelId = strOrNull(body.notifyChannelId);
  if ("liveRoleId" in body) cfg.liveRoleId = strOrNull(body.liveRoleId);
  if ("offlineRoleId" in body) cfg.offlineRoleId = strOrNull(body.offlineRoleId);
  ctx.store.persist();
  ctx.sendJson(200, { ok: true });
}

async function apiRoles(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const roles = guild.roles.cache
    .filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.color === 0 ? null : `#${r.color.toString(16).padStart(6, "0")}` }));
  ctx.sendJson(200, { roles });
}

async function apiChannels(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const channels = guild.channels.cache
    .filter((ch) => ch.isTextBased() && !ch.isThread())
    .sort((a, b) => a.position - b.position)
    .map((ch) => ({ id: ch.id, name: ch.name }));
  ctx.sendJson(200, { channels });
}

async function apiMembers(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const query = (ctx.url.searchParams.get("query") ?? "").toLowerCase().trim();
  if (guild.members.cache.size === 0) {
    try {
      await guild.members.fetch();
    } catch {
      // sin intent privilegiado: seguimos con la caché
    }
  }
  const members = [...guild.members.cache.values()]
    .filter((m) => {
      if (!query) return true;
      return (
        m.user.tag.toLowerCase().includes(query) ||
        m.user.username.toLowerCase().includes(query) ||
        (m.nickname ?? "").toLowerCase().includes(query)
      );
    })
    .sort((a, b) => a.user.tag.localeCompare(b.user.tag))
    .slice(0, 200)
    .map((m) => ({ id: m.id, tag: m.user.tag, nickname: m.nickname, username: m.user.username }));
  ctx.sendJson(200, { members });
}

async function apiAddStreamer(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const raw = typeof body.channel === "string" ? body.channel : "";
  if (!raw.trim()) {
    ctx.sendJson(400, { error: "Falta el canal" });
    return;
  }
  // La URL manda; si no hay URL, usamos la plataforma explícita
  const platform = detectPlatformFromInput(raw) ?? (body.platform as Platform);
  if (!platform || !PLATFORMS.includes(platform)) {
    ctx.sendJson(400, { error: "No pude detectar la plataforma: pega la URL del canal (twitch.tv/…, youtube.com/@…, kick.com/…) o elige plataforma" });
    return;
  }
  if (platform === "twitch" && !twitchConfigured()) {
    ctx.sendJson(400, { error: "Twitch no está configurado: añade TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET a .env" });
    return;
  }
  const input = cleanHandle(raw, platform);
  const resolved = await adapters[platform].resolve(input);
  if (!resolved) {
    ctx.sendJson(404, { error: `No encontré el canal "${input}" en ${platform}` });
    return;
  }
  const cfg = ctx.store.getGuild(guild.id);
  const id = `${platform}:${resolved.channel}`;
  if (cfg.streamers.some((s) => s.id === id)) {
    ctx.sendJson(409, { error: `${resolved.displayName} ya está vigilado` });
    return;
  }
  const colorRaw = typeof body.color === "string" ? body.color : null;
  const color = parseColor(colorRaw);
  if (colorRaw && colorRaw.trim() && color === null) {
    ctx.sendJson(400, { error: "Color no válido (usa formato #RRGGBB)" });
    return;
  }
  const streamer: Streamer = {
    id,
    platform,
    channel: resolved.channel,
    displayName: resolved.displayName,
    notifyChannelId: strOrNull(body.notifyChannelId),
    discordUserId: strOrNull(body.discordUserId),
    mentionRoleId: strOrNull(body.mentionRoleId),
    liveRoleId: strOrNull(body.liveRoleId),
    offlineRoleId: strOrNull(body.offlineRoleId),
    color,
    message: strOrNull(body.message),
    enabled: body.enabled !== false,
  };
  ctx.store.addStreamer(guild.id, streamer);
  log(`🌐 Panel: añadido streamer ${id}`);
  ctx.sendJson(201, { streamer: { ...streamer, url: platformUrl(platform, resolved.channel) } });
}

async function apiUpdateStreamer(ctx: ApiContext, id: string): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const cfg = ctx.store.getGuild(guild.id);
  const streamer = cfg.streamers.find((s) => s.id === id);
  if (!streamer) {
    ctx.sendJson(404, { error: "Streamer no encontrado" });
    return;
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const oldEnabled = streamer.enabled;
  if (typeof body.displayName === "string" && body.displayName.trim()) streamer.displayName = body.displayName.trim();
  if ("notifyChannelId" in body) streamer.notifyChannelId = strOrNull(body.notifyChannelId);
  if ("discordUserId" in body) streamer.discordUserId = strOrNull(body.discordUserId);
  if ("mentionRoleId" in body) streamer.mentionRoleId = strOrNull(body.mentionRoleId);
  if ("liveRoleId" in body) streamer.liveRoleId = strOrNull(body.liveRoleId);
  if ("offlineRoleId" in body) streamer.offlineRoleId = strOrNull(body.offlineRoleId);
  if ("message" in body) streamer.message = strOrNull(body.message);
  if ("enabled" in body) streamer.enabled = Boolean(body.enabled);
  if ("color" in body) {
    const colorRaw = typeof body.color === "string" ? body.color : null;
    if (colorRaw && colorRaw.trim()) {
      const color = parseColor(colorRaw);
      if (color === null) {
        ctx.sendJson(400, { error: "Color no válido (usa formato #RRGGBB)" });
        return;
      }
      streamer.color = color;
    } else {
      streamer.color = null;
    }
  }

  // Si se desactiva estando en directo, cerramos historial y quitamos roles
  const st = ctx.store.getState(streamer.id);
  if (oldEnabled && !streamer.enabled && st.isLive) {
    ctx.store.finalizeHistory(st.activeHistoryId ?? "", new Date().toISOString(), st.peakViewers ?? 0);
    st.isLive = false;
    st.activeHistoryId = null;
    ctx.store.setState(streamer.id, st);
    if (streamer.discordUserId) await applyOffline(guild, cfg, streamer);
  }

  ctx.store.updateStreamer(streamer);
  ctx.sendJson(200, { ok: true });
}

async function apiDeleteStreamer(ctx: ApiContext, id: string): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const cfg = ctx.store.getGuild(guild.id);
  const streamer = cfg.streamers.find((s) => s.id === id);
  if (!streamer) {
    ctx.sendJson(404, { error: "Streamer no encontrado" });
    return;
  }
  const removed = ctx.store.removeStreamer(guild.id, id);
  if (!removed) {
    ctx.sendJson(500, { error: "No se pudo eliminar" });
    return;
  }
  const st = ctx.store.getState(id);
  if (st.isLive) {
    ctx.store.finalizeHistory(st.activeHistoryId ?? "", new Date().toISOString(), st.peakViewers ?? 0);
    st.isLive = false;
    st.activeHistoryId = null;
    ctx.store.setState(id, st);
    if (streamer.discordUserId) await applyOffline(guild, cfg, streamer);
  }
  log(`🌐 Panel: eliminado streamer ${id}`);
  ctx.sendJson(200, { ok: true });
}

/** Añade varios streamers de golpe (una URL/canal por línea). */
async function apiBulkAddStreamers(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const channels = Array.isArray(body.channels)
    ? body.channels.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  if (channels.length === 0) {
    ctx.sendJson(400, { error: "Escribe al menos un canal o URL" });
    return;
  }
  if (channels.length > 100) {
    ctx.sendJson(400, { error: "Máximo 100 canales por lote" });
    return;
  }
  const cfg = ctx.store.getGuild(guild.id);
  const added: unknown[] = [];
  const duplicates: string[] = [];
  const errors: Array<{ input: string; error: string }> = [];

  for (const raw of channels) {
    const platform = detectPlatformFromInput(raw);
    if (!platform) {
      errors.push({ input: raw, error: "No pude detectar la plataforma (pega la URL del canal)" });
      continue;
    }
    if (platform === "twitch" && !twitchConfigured()) {
      errors.push({ input: raw, error: "Twitch no configurado (.env)" });
      continue;
    }
    const input = cleanHandle(raw, platform);
    try {
      const resolved = await adapters[platform].resolve(input);
      if (!resolved) {
        errors.push({ input: raw, error: `No encontré el canal "${input}"` });
        continue;
      }
      const id = `${platform}:${resolved.channel}`;
      if (cfg.streamers.some((s) => s.id === id)) {
        duplicates.push(resolved.displayName);
        continue;
      }
      const streamer: Streamer = {
        id,
        platform,
        channel: resolved.channel,
        displayName: resolved.displayName,
        notifyChannelId: null,
        discordUserId: null,
        mentionRoleId: null,
        liveRoleId: null,
        offlineRoleId: null,
        color: null,
        message: null,
        enabled: true,
      };
      ctx.store.addStreamer(guild.id, streamer);
      added.push({ ...streamer, url: platformUrl(platform, resolved.channel) });
    } catch (e) {
      errors.push({ input: raw, error: e instanceof Error ? e.message : String(e) });
    }
  }
  log(`🌐 Panel: lote añadido (${added.length} ok, ${duplicates.length} duplicados, ${errors.length} errores)`);
  ctx.sendJson(200, { added, duplicates, errors });
}

async function apiCheck(ctx: ApiContext): Promise<void> {
  if (ctx.monitor.isBusy()) {
    ctx.sendJson(409, { error: "Ya hay una comprobación en curso" });
    return;
  }
  const summary = await ctx.monitor.pollOnce();
  ctx.sendJson(200, { summary });
}

async function apiHistory(ctx: ApiContext): Promise<void> {
  const guild = await resolveGuild(ctx);
  if (!guild) return;
  const streamerId = ctx.url.searchParams.get("streamerId") ?? undefined;
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get("limit") ?? 100) || 100, 1), 500);
  const entries = ctx.store.getHistory({ guildId: guild.id, streamerId, limit });
  const streamers = ctx.store.historyStreamers(guild.id);
  ctx.sendJson(200, { entries, streamers });
}