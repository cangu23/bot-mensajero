import { log } from "../logger.js";
import { httpGet } from "./http.js";
import type { PlatformAdapter } from "./types.js";
import type { Streamer, StreamSnapshot, StreamState } from "../types.js";

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const CHANNEL_ID_IN_HTML = /"channelId":"(UC[\w-]{22})"/;
const LIVE_KEYWORDS = /\b(live|directo|estreno|premiere|stream(ing)?|en vivo|直播)\b/i;
/** Re-comprobamos la página de un vídeo no-en-directo solo si es reciente o huele a directo */
const RECHECK_AGE_HOURS = 6;

interface YtEntry {
  videoId: string;
  title: string;
  published: string;
  thumbnail: string | null;
}

/** Último vídeo obtenido desde la página del canal (fallback cuando el feed RSS falla) */
interface LatestVideo {
  videoId: string;
  title: string;
  published: string;
  thumbnail: string | null;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
}

function cleanTitle(t: string): string {
  return t.replace(/\s*-\s*YouTube\s*$/i, "").trim();
}

// ── Estrategias de extracción del último vídeo desde el HTML del canal ─────

/**
 * Estrategia 1 (principal): Parsea ytInitialData y busca lockupViewModel.
 * Funciona con el layout actual (2024-2025).
 */
function extractViaLockupViewModel(data: unknown): { videoId: string; title: string } | null {
  return findFirstVideoLockup(data);
}

/**
 * Estrategia 2: Busca richItemRenderer → videoRenderer en ytInitialData.
 * Layout alternativo cuando YouTube sirve el grid sin lockupViewModel.
 */
function extractViaVideoRenderer(data: unknown): { videoId: string; title: string } | null {
  return findVideoRenderer(data);
}

/**
 * Estrategia 3 (fallback puro HTML): extrae IDs de vídeo directamente
 * de los hrefs /watch?v= que aparecen en el HTML del canal, sin depender
 * del JSON incrustado. Captura el primero que no sea un short (< 11 chars).
 */
function extractViaHtmlLinks(html: string): { videoId: string; title: string } | null {
  // Buscamos /watch?v=XXXXXXXXXXX en atributos href/data
  const re = /\/watch\?v=([\w-]{11})[^"'\s]*/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(html)) !== null) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    // Intentamos extraer el título cercano (texto entre comillas tras "title":)
    const surroundingStart = Math.max(0, m.index - 200);
    const surrounding = html.slice(surroundingStart, m.index + 200);
    const titleMatch = /"title":\s*"([^"]{3,100})"/.exec(surrounding);
    return { videoId: id, title: titleMatch?.[1] ?? "" };
  }
  return null;
}

/**
 * Punto de entrada: intenta las estrategias en orden hasta obtener un resultado.
 */
function extractLatestFromChannelPage(html: string): { videoId: string; title: string } | null {
  // Intentamos parsear el JSON primero (estrategias 1 y 2)
  const scriptRe = /(?:var ytInitialData\s*=\s*|window\["ytInitialData"\]\s*=\s*)(\{[\s\S]*?\});(?:\s*<\/script>|var )/;
  const match = scriptRe.exec(html);
  if (match?.[1]) {
    try {
      const data: unknown = JSON.parse(match[1]);
      const r1 = extractViaLockupViewModel(data);
      if (r1) return r1;
      const r2 = extractViaVideoRenderer(data);
      if (r2) return r2;
    } catch {
      // JSON inválido → pasamos al fallback HTML
    }
  }

  // Estrategia 3: HTML puro
  return extractViaHtmlLinks(html);
}

/**
 * Recorre el árbol en orden de documento y devuelve el primer lockupViewModel
 * que sea un vídeo (contentId de 11 caracteres con título). En la pestaña de
 * vídeos del canal, el primero es el último vídeo publicado (o el directo).
 */
function findFirstVideoLockup(node: unknown): { videoId: string; title: string } | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findFirstVideoLockup(item);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const lv = obj.lockupViewModel;
    if (lv && typeof lv === "object") {
      const lockup = lv as Record<string, unknown>;
      const contentId = typeof lockup.contentId === "string" ? lockup.contentId : null;
      if (contentId && /^[\w-]{11}$/.test(contentId) && !contentId.startsWith("UC")) {
        const meta = lockup.metadata as Record<string, unknown> | undefined;
        const title = (meta as Record<string, unknown> | undefined)?.lockupMetadataViewModel as
          | Record<string, unknown>
          | undefined;
        const titleText = (title?.title as Record<string, unknown> | undefined)?.content;
        if (typeof titleText === "string" && titleText.length > 0) {
          return { videoId: contentId, title: titleText };
        }
      }
    }
    for (const value of Object.values(obj)) {
      const r = findFirstVideoLockup(value);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Alternativa al lockupViewModel: busca videoRenderer (formato clásico de grid).
 */
function findVideoRenderer(node: unknown): { videoId: string; title: string } | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findVideoRenderer(item);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const vr = obj.videoRenderer;
    if (vr && typeof vr === "object") {
      const renderer = vr as Record<string, unknown>;
      const videoId = typeof renderer.videoId === "string" ? renderer.videoId : null;
      if (videoId && /^[\w-]{11}$/.test(videoId)) {
        // Título en title.runs[0].text o title.simpleText
        const titleObj = renderer.title as Record<string, unknown> | undefined;
        const simpleText = titleObj?.simpleText as string | undefined;
        const runsText = (titleObj?.runs as Array<{ text?: string }> | undefined)?.[0]?.text;
        const text = simpleText ?? runsText ?? "";
        if (text.length > 0) return { videoId, title: text };
      }
    }
    for (const value of Object.values(obj)) {
      const r = findVideoRenderer(value);
      if (r) return r;
    }
  }
  return null;
}

function parseFeed(xml: string): YtEntry[] {
  const entries: YtEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1] ?? "";
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(block)?.[1];
    if (!videoId) continue;
    const title = stripCdata(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "");
    const published = /<published>([^<]+)<\/published>/.exec(block)?.[1] ?? "";
    const thumbnail = /<media:thumbnail url="([^"]+)"/.exec(block)?.[1] ?? null;
    entries.push({ videoId, title, published, thumbnail });
  }
  return entries;
}

/** Comprueba si un vídeo está emitiéndose en directo ahora mismo. null = no se pudo comprobar. */
async function isVideoLive(videoId: string): Promise<boolean | null> {
  try {
    const r = await httpGet(`https://www.youtube.com/watch?v=${videoId}`, {
      Cookie: "CONSENT=YES+1; SOCS=CAI",
    });
    if (!r.ok) return null;
    if (/video unavailable/i.test(r.body)) return false;
    // Dos señales: la propiedad isLive del JSON o el badge LIVE en el HTML
    const isLiveJson = /"isLive"\s*:\s*true/.test(r.body);
    const isLiveBadge = /"style"\s*:\s*"LIVE"/.test(r.body) || /class="[^"]*ytp-live[^"]*"/.test(r.body);
    return isLiveJson || isLiveBadge;
  } catch {
    return null;
  }
}

async function resolveHandle(handle: string): Promise<{ channelId: string; displayName: string } | null> {
  const candidates = [
    `https://www.youtube.com/@${handle}`,
    `https://www.youtube.com/user/${handle}`,
    `https://www.youtube.com/c/${handle}`,
  ];
  for (const url of candidates) {
    try {
      const r = await httpGet(url);
      if (!r.ok) continue;
      const channelId = CHANNEL_ID_IN_HTML.exec(r.body)?.[1];
      if (!channelId) continue;
      const title = /<title>([\s\S]*?)<\/title>/.exec(r.body)?.[1];
      return { channelId, displayName: cleanTitle(title ?? handle) };
    } catch {
      // probamos el siguiente formato de URL
    }
  }
  return null;
}

function liveSnapshot(entry: YtEntry | LatestVideo, channel: string): StreamSnapshot {
  return {
    ok: true,
    isLive: true,
    title: entry.title,
    category: "YouTube",
    url: `https://www.youtube.com/watch?v=${entry.videoId}`,
    thumbnailUrl: entry.thumbnail ?? undefined,
    startedAt: entry.published || undefined,
  };
}

const offlineSnapshot = (channel: string): StreamSnapshot => ({
  ok: true,
  isLive: false,
  url: `https://www.youtube.com/channel/${channel}`,
});

/** Último vídeo del canal: feed RSS primero, página del canal como fallback. */
async function getLatest(channel: string): Promise<YtEntry | LatestVideo | null> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel)}`;
  const r = await httpGet(feedUrl);
  if (r.ok) {
    const entries = parseFeed(r.body);
    if (entries.length > 0) return entries[0]!;
  }
  // Fallback: página de vídeos del canal (/videos tab)
  const page = await httpGet(`https://www.youtube.com/channel/${encodeURIComponent(channel)}/videos`);
  if (!page.ok) return null;
  const v = extractLatestFromChannelPage(page.body);
  if (!v) {
    log(`⚠️ YouTube: no se pudo extraer el último vídeo del canal ${channel} (HTML puede haber cambiado)`);
    return null;
  }
  return {
    videoId: v.videoId,
    title: v.title,
    published: "",
    thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
  };
}

export const youtube: PlatformAdapter = {
  platform: "youtube",

  async resolve(input) {
    const value = input.trim().replace(/^@/, "");
    if (CHANNEL_ID_RE.test(value)) {
      return { channel: value, displayName: value };
    }
    const r = await resolveHandle(value);
    return r ? { channel: r.channelId, displayName: r.displayName } : null;
  },

  async check(streamer: Streamer, state: StreamState) {
    const channelUrl = `https://www.youtube.com/channel/${streamer.channel}`;
    try {
      const latest = await getLatest(streamer.channel);
      const patch: Partial<StreamState> = { lastVideoId: latest ? latest.videoId : null };
      if (!latest) return { snapshot: { ok: false, isLive: false, url: channelUrl } };

      // Mismo vídeo que ya conocemos
      if (state.lastVideoId === latest.videoId) {
        if (state.isLive) {
          // Seguimos un directo: comprobar si sigue en directo (para detectar el final)
          const live = await isVideoLive(latest.videoId);
          if (live === null) return { snapshot: { ok: false, isLive: false, url: channelUrl }, state: patch };
          return { snapshot: live ? liveSnapshot(latest, streamer.channel) : offlineSnapshot(streamer.channel), state: patch };
        }
        // No estamos en directo: re-comprobar solo si es reciente o tiene pinta de directo
        const ageH = latest.published ? (Date.now() - new Date(latest.published).getTime()) / 3_600_000 : Infinity;
        const isRecent = Number.isFinite(ageH) && ageH <= RECHECK_AGE_HOURS;
        if (state.lastCheckedVideoId !== latest.videoId || isRecent || LIVE_KEYWORDS.test(latest.title)) {
          const live = await isVideoLive(latest.videoId);
          if (live === null) return { snapshot: { ok: false, isLive: false, url: channelUrl }, state: patch };
          patch.lastCheckedVideoId = latest.videoId;
          if (live) return { snapshot: liveSnapshot(latest, streamer.channel), state: { ...patch, lastVideoId: latest.videoId } };
        }
        return { snapshot: offlineSnapshot(streamer.channel), state: patch };
      }

      // Vídeo nuevo en el feed: comprobar si está en directo ahora
      const live = await isVideoLive(latest.videoId);
      if (live === null) return { snapshot: { ok: false, isLive: false, url: channelUrl }, state: patch };
      patch.lastCheckedVideoId = latest.videoId;
      if (live) return { snapshot: liveSnapshot(latest, streamer.channel), state: { ...patch, lastVideoId: latest.videoId } };
      return { snapshot: offlineSnapshot(streamer.channel), state: { ...patch, lastVideoId: latest.videoId } };
    } catch (e) {
      log("⚠️ YouTube: error comprobando", streamer.channel, "→", e instanceof Error ? e.message : String(e));
      return { snapshot: { ok: false, isLive: false, url: channelUrl } };
    }
  },
};