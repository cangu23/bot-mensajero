import type { Client } from "discord.js";
import { env } from "./env.js";
import { log } from "./logger.js";
import type { Store } from "./store.js";
import type { Platform, Streamer } from "./types.js";

interface CreatorProfileItem {
  id: string;
  displayName?: string | null;
  twitchUrl?: string | null;
  youtubeUrl?: string | null;
  kickUrl?: string | null;
  isApproved?: boolean;
  user?: {
    id: string;
    username: string;
    role?: string;
  };
}

interface ApiResponse {
  data?: CreatorProfileItem[];
  meta?: {
    total: number;
  };
}

interface ParsedStreamTarget {
  platform: Platform;
  channel: string;
  displayName: string;
}

let syncIntervalHandle: NodeJS.Timeout | null = null;
let isSyncRunning = false;

/**
 * Extrae los canales de Twitch, YouTube o Kick a partir de las URLs de un perfil
 */
export function extractStreamTargets(profile: CreatorProfileItem): ParsedStreamTarget[] {
  const targets: ParsedStreamTarget[] = [];
  const displayName = (profile.displayName?.trim() || profile.user?.username?.trim() || "Creador Estelar").trim();

  // 1. Twitch
  if (profile.twitchUrl) {
    const match = profile.twitchUrl.match(/(?:twitch\.tv\/)([a-zA-Z0-9_]{3,25})/i);
    if (match && match[1]) {
      targets.push({
        platform: "twitch",
        channel: match[1].toLowerCase(),
        displayName,
      });
    }
  }

  // 2. YouTube (@handle o /channel/UC...)
  if (profile.youtubeUrl) {
    const matchHandle = profile.youtubeUrl.match(/(?:youtube\.com\/|youtu\.be\/)(@[a-zA-Z0-9_\-\.]+)/i);
    const matchChannel = profile.youtubeUrl.match(/(?:youtube\.com\/channel\/)(UC[a-zA-Z0-9_\-]{22})/i);

    if (matchHandle && matchHandle[1]) {
      targets.push({
        platform: "youtube",
        channel: matchHandle[1],
        displayName,
      });
    } else if (matchChannel && matchChannel[1]) {
      targets.push({
        platform: "youtube",
        channel: matchChannel[1],
        displayName,
      });
    }
  }

  // 3. Kick
  if (profile.kickUrl) {
    const match = profile.kickUrl.match(/(?:kick\.com\/)([a-zA-Z0-9_\-]+)/i);
    if (match && match[1]) {
      targets.push({
        platform: "kick",
        channel: match[1].toLowerCase(),
        displayName,
      });
    }
  }

  return targets;
}

/**
 * Consulta la API de Gremio Web y sincroniza automáticamente creadores registrados
 */
export async function syncCreatorsFromGremio(
  client: Client,
  store: Store,
): Promise<{ added: number; updated: number; total: number }> {
  if (isSyncRunning) {
    return { added: 0, updated: 0, total: 0 };
  }

  isSyncRunning = true;
  let addedCount = 0;
  let updatedCount = 0;

  try {
    const baseApi = env.GREMIO_API_URL.replace(/\/+$/, "");

    // Peticiones paralelas a /vtubers y /streamers
    const [vtubersRes, streamersRes] = await Promise.allSettled([
      fetch(`${baseApi}/vtubers?limit=100`, {
        headers: { "User-Agent": "BotMensajero-AutoSync/1.0" },
        signal: AbortSignal.timeout(15000),
      }),
      fetch(`${baseApi}/streamers?limit=100`, {
        headers: { "User-Agent": "BotMensajero-AutoSync/1.0" },
        signal: AbortSignal.timeout(15000),
      }),
    ]);

    const allProfiles: CreatorProfileItem[] = [];

    if (vtubersRes.status === "fulfilled" && vtubersRes.value.ok) {
      const json = (await vtubersRes.value.json()) as ApiResponse;
      if (Array.isArray(json.data)) {
        allProfiles.push(...json.data);
      }
    } else {
      log("✧ [GremioSync] No se pudo obtener el directorio de VTubers");
    }

    if (streamersRes.status === "fulfilled" && streamersRes.value.ok) {
      const json = (await streamersRes.value.json()) as ApiResponse;
      if (Array.isArray(json.data)) {
        allProfiles.push(...json.data);
      }
    } else {
      log("✧ [GremioSync] No se pudo obtener el directorio de Streamers");
    }

    if (allProfiles.length === 0) {
      return { added: 0, updated: 0, total: 0 };
    }

    // Extraer todos los canales válidos
    const streamTargetsMap = new Map<string, ParsedStreamTarget>(); // `${platform}:${channel}` -> target

    for (const profile of allProfiles) {
      const targets = extractStreamTargets(profile);
      for (const t of targets) {
        const id = `${t.platform}:${t.channel}`;
        if (!streamTargetsMap.has(id)) {
          streamTargetsMap.set(id, t);
        }
      }
    }

    // Sincronizar en todos los servidores donde está el bot
    const guilds = Array.from(client.guilds.cache.values());

    for (const guild of guilds) {
      for (const [id, target] of streamTargetsMap.entries()) {
        const existing = store.getStreamer(guild.id, id);

        if (!existing) {
          const newStreamer: Streamer = {
            id,
            platform: target.platform,
            channel: target.channel,
            displayName: target.displayName,
            discordUserId: null,
            mentionRoleId: null,
            liveRoleId: null,
            offlineRoleId: null,
            notifyChannelId: null, // hereda el canal por defecto del gremio
            color: null,
            message: null,
            enabled: true,
          };

          store.addStreamer(guild.id, newStreamer);
          addedCount++;
        } else if (existing.displayName !== target.displayName && target.displayName) {
          // Actualizar nombre visible si cambió en la web
          existing.displayName = target.displayName;
          store.updateStreamer(existing);
          updatedCount++;
        }
      }
    }

    log(
      `✦ [GremioSync] Sincronización completada: ${addedCount} canales agregados, ${updatedCount} actualizados (${streamTargetsMap.size} creadores vigentes)`,
    );

    return {
      added: addedCount,
      updated: updatedCount,
      total: streamTargetsMap.size,
    };
  } catch (err: any) {
    log(`★ [GremioSync] Error durante la sincronización automática: ${err?.message || err}`);
    return { added: addedCount, updated: updatedCount, total: 0 };
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Inicia el temporizador de auto-sincronización periódica
 */
export function startGremioSync(client: Client, store: Store): void {
  if (!env.AUTO_SYNC_GREMIO) {
    log("✧ [GremioSync] Sincronización automática deshabilitada por configuración");
    return;
  }

  if (syncIntervalHandle) return;

  log(`✦ [GremioSync] Servicio de auto-sincronización activado (cada ${Math.round(env.GREMIO_SYNC_INTERVAL_MS / 60000)} min)`);

  // Primer barrido a los 6 segundos de arrancar
  setTimeout(() => {
    void syncCreatorsFromGremio(client, store);
  }, 6000).unref?.();

  syncIntervalHandle = setInterval(() => {
    void syncCreatorsFromGremio(client, store);
  }, env.GREMIO_SYNC_INTERVAL_MS);

  syncIntervalHandle.unref?.();
}

/**
 * Detiene el temporizador de sincronización
 */
export function stopGremioSync(): void {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
    log("✧ [GremioSync] Servicio de sincronización detenido.");
  }
}
