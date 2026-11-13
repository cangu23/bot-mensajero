import { env, twitchConfigured } from "../env.js";
import { log } from "../logger.js";
import { jsonGet } from "./http.js";
import type { PlatformAdapter } from "./types.js";
import type { Streamer, StreamSnapshot, StreamState } from "../types.js";

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  offline_image_url: string;
}

interface TwitchStream {
  user_login: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
  type: string;
  thumbnail_url: string;
}

interface TwitchVideo {
  id: string;
  user_id: string;
  created_at: string;
  duration: string;
}

export function parseTwitchDurationMs(durationStr: string): number {
  let ms = 0;
  const h = durationStr.match(/(\d+)h/i);
  const m = durationStr.match(/(\d+)m/i);
  const s = durationStr.match(/(\d+)s/i);
  if (h) ms += parseInt(h[1]!, 10) * 3600_000;
  if (m) ms += parseInt(m[1]!, 10) * 60_000;
  if (s) ms += parseInt(s[1]!, 10) * 1000;
  return ms;
}

export async function getTwitchVodEndTime(channel: string, startedAt: string | null): Promise<string | null> {
  if (!startedAt) return null;
  const user = await getUser(channel.toLowerCase());
  if (!user) return null;
  try {
    const videos = await helix<TwitchVideo[]>(`videos?user_id=${user.id}&type=archive&first=5`);
    if (!videos || videos.length === 0) return null;

    const streamStartMs = new Date(startedAt).getTime();
    if (isNaN(streamStartMs)) return null;

    // Buscar el VOD más cercano al inicio del directo (dentro de un margen de 2 horas)
    for (const v of videos) {
      if (!v || !v.duration || !v.created_at) continue;
      const vodStartMs = new Date(v.created_at).getTime();
      if (isNaN(vodStartMs)) continue;

      if (Math.abs(vodStartMs - streamStartMs) <= 2 * 3600_000) {
        const durMs = parseTwitchDurationMs(v.duration);
        if (durMs > 0) {
          return new Date(vodStartMs + durMs).toISOString();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

let token: { access: string; expiresAt: number } | null = null;

async function ensureToken(): Promise<string | null> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.access;
  if (!twitchConfigured()) return null;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID!,
        client_secret: env.TWITCH_CLIENT_SECRET!,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    token = { access: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return token.access;
  } catch (e) {
    log("⚠️ Twitch: error obteniendo token:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function helix<T>(path: string): Promise<T | null> {
  let access = await ensureToken();
  if (!access) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await jsonGet<{ data: T }>(`https://api.twitch.tv/helix/${path}`, {
      "Client-Id": env.TWITCH_CLIENT_ID!,
      Authorization: `Bearer ${access}`,
    });
    if (r.ok && r.data) return r.data.data;
    if (r.status === 401 && attempt === 0) {
      token = null;
      access = await ensureToken();
      if (access) continue;
    }
    return null;
  }
  return null;
}

const userCache = new Map<string, { user: TwitchUser; expiresAt: number }>();

async function getUser(login: string): Promise<TwitchUser | null> {
  const key = login.toLowerCase();
  const hit = userCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.user;
  if (hit) userCache.delete(key);
  const users = await helix<TwitchUser[]>(`users?login=${encodeURIComponent(key)}`);
  const user = users?.[0] ?? null;
  if (user) userCache.set(key, { user, expiresAt: Date.now() + 3_600_000 });
  return user;
}

export async function getTwitchAvatar(channel: string): Promise<string | null> {
  const user = await getUser(channel.toLowerCase());
  return user?.profile_image_url ?? null;
}

export const twitch: PlatformAdapter = {
  platform: "twitch",

  async resolve(input) {
    if (!twitchConfigured()) return null;
    const login = input.trim().toLowerCase();
    const user = await getUser(login);
    if (!user) return null;
    return { channel: user.login.toLowerCase(), displayName: user.display_name };
  },

  async check(streamer: Streamer): Promise<{ snapshot: StreamSnapshot; state?: Partial<StreamState> }> {
    const url = `https://www.twitch.tv/${streamer.channel}`;
    try {
      const streams = await helix<TwitchStream[]>(`streams?user_login=${encodeURIComponent(streamer.channel)}`);
      if (streams === null) return { snapshot: { ok: false, isLive: false, url } };
      const s = streams[0];
      if (!s || s.type !== "live") return { snapshot: { ok: true, isLive: false, url } };
      const user = await getUser(streamer.channel);
      return {
        snapshot: {
          ok: true,
          isLive: true,
          title: s.title,
          category: s.game_name || undefined,
          viewers: s.viewer_count,
          thumbnailUrl: s.thumbnail_url.replace("{width}", "1280").replace("{height}", "720"),
          avatarUrl: user?.profile_image_url ?? undefined,
          bannerUrl: user?.offline_image_url?.trim() ? user.offline_image_url : undefined,
          url,
          startedAt: s.started_at,
        },
      };
    } catch (e) {
      log("⚠️ Twitch: error comprobando", streamer.channel, "→", e instanceof Error ? e.message : String(e));
      return { snapshot: { ok: false, isLive: false, url } };
    }
  },
};