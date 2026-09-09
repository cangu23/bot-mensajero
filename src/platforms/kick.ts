import { log } from "../logger.js";
import { jsonGet } from "./http.js";
import type { PlatformAdapter } from "./types.js";
import type { Streamer, StreamSnapshot, StreamState } from "../types.js";

interface KickChannel {
  user?: {
    username?: string;
    slug?: string;
    profile_pic?: string | null;
  } | null;
  livestream?: {
    session_title?: string;
    viewers?: number;
    started_at?: string;
    thumbnail?: { url?: string } | null;
    categories?: Array<{ name?: string }>;
  } | null;
}

const apiUrl = (slug: string) => `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
const url = (slug: string) => `https://kick.com/${encodeURIComponent(slug)}`;

/**
 * Kick no tiene API oficial pública; este endpoint público no documentado
 * se usa ampliamente por la comunidad. Puede cambiar o limitarse: si eso
 * ocurre, el monitor simplemente marcará las comprobaciones como "sin respuesta".
 */
export const kick: PlatformAdapter = {
  platform: "kick",

  async resolve(input) {
    const slug = input.trim().toLowerCase().replace(/^@/, "");
    const r = await jsonGet<KickChannel>(apiUrl(slug));
    if (!r.ok || !r.data?.user?.username) {
      if (r.status === 429) log("⚠️ Kick: rate limit en resolve");
      return null;
    }
    return {
      channel: r.data.user.slug ?? slug,
      displayName: r.data.user.username ?? slug,
    };
  },

  async check(streamer: Streamer): Promise<{ snapshot: StreamSnapshot; state?: Partial<StreamState> }> {
    try {
      const r = await jsonGet<KickChannel>(apiUrl(streamer.channel));
      if (!r.ok || !r.data) {
        if (r.status === 429) log("⚠️ Kick: rate limit en", streamer.channel);
        return { snapshot: { ok: false, isLive: false, url: url(streamer.channel) } };
      }
      const ls = r.data.livestream;
      if (!ls) return { snapshot: { ok: true, isLive: false, url: url(streamer.channel) } };
      return {
        snapshot: {
          ok: true,
          isLive: true,
          title: ls.session_title ?? "Directo de Kick",
          category: ls.categories?.[0]?.name ?? undefined,
          viewers: ls.viewers ?? 0,
          thumbnailUrl: ls.thumbnail?.url ?? undefined,
          avatarUrl: r.data.user?.profile_pic ?? undefined,
          url: url(streamer.channel),
          startedAt: ls.started_at ?? undefined,
        },
      };
    } catch (e) {
      log("⚠️ Kick: error comprobando", streamer.channel, "→", e instanceof Error ? e.message : String(e));
      return { snapshot: { ok: false, isLive: false, url: url(streamer.channel) } };
    }
  },
};