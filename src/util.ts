import type { Platform } from "./types.js";

export function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export function formatNumber(n: number | undefined): string {
  return n === undefined ? "—" : n.toLocaleString("es-ES");
}

export const PLATFORM_EMOJI: Record<Platform, string> = {
  twitch: "🟣",
  youtube: "🔴",
  kick: "🟢",
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
  kick: "Kick",
};

export const PLATFORM_COLOR: Record<Platform, number> = {
  twitch: 0x9146ff,
  youtube: 0xff0000,
  kick: 0x53fc18,
};

export function parseColor(s: string | null): number | null {
  if (!s) return null;
  const hex = s.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) return parseInt(hex.split("").map((c) => c + c).join(""), 16);
  return null;
}

export function platformUrl(platform: Platform, channel: string): string {
  switch (platform) {
    case "twitch":
      return `https://www.twitch.tv/${encodeURIComponent(channel)}`;
    case "youtube":
      return `https://www.youtube.com/channel/${encodeURIComponent(channel)}`;
    case "kick":
      return `https://kick.com/${encodeURIComponent(channel)}`;
  }
}

/** Detecta la plataforma a partir de una URL (o null si no hay pista). */
export function detectPlatformFromInput(raw: string): Platform | null {
  const s = raw.toLowerCase();
  if (s.includes("twitch.tv")) return "twitch";
  if (s.includes("youtube.com") || s.includes("youtu.be")) return "youtube";
  if (s.includes("kick.com")) return "kick";
  return null;
}

/** Convierte el input del usuario en el "canal" limpio (login/ID/slug). */
export function cleanHandle(raw: string, platform: Platform): string {
  let s = raw.trim().replace(/^https?:\/\//, "");
  if (platform === "youtube") {
    const m = s.match(/(?:^|\/)channel\/(UC[\w-]{22})/);
    if (m) return m[1] ?? s;
    s = s.replace(/^[^/@]+\//, "").replace(/\/.*$/, "").replace(/^@/, "");
    return s;
  }
  s = s.replace(/^[^/]+\//, "").replace(/\/.*$/, "");
  return s.replace(/^@/, "");
}