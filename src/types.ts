export type Platform = "twitch" | "youtube" | "kick";

export interface Streamer {
  /** Identificador único: `${platform}:${canalCanonico}` */
  id: string;
  platform: Platform;
  /** Login de Twitch, channelId de YouTube o slug de Kick */
  channel: string;
  displayName: string;
  /** Usuario de Discord que recibe los roles de directo (null = sin rol) */
  discordUserId: string | null;
  /** Rol que se pinguea en el aviso (null = sin ping) */
  mentionRoleId: string | null;
  /** Override del rol "en directo" por streamer */
  liveRoleId: string | null;
  /** Override del rol "fuera de directo" por streamer */
  offlineRoleId: string | null;
  /** Canal donde anunciar a este streamer (null = usar el canal global del gremio) */
  notifyChannelId: string | null;
  /** Color del embed en hexadecimal (0xRRGGBB), null = color de la plataforma */
  color: number | null;
  /** Mensaje personalizado que acompaña al aviso */
  message: string | null;
  enabled: boolean;
}

export interface GuildConfig {
  notifyChannelId: string | null;
  liveRoleId: string | null;
  offlineRoleId: string | null;
  streamers: Streamer[];
}

export interface StreamState {
  isLive: boolean;
  /** Comprobaciones consecutivas sin directo (evita falsos negativos) */
  consecutiveOffline: number;
  notifyMessageId: string | null;
  notifyChannelId: string | null;
  title: string | null;
  startedAt: string | null;
  /** YouTube: último vídeo visto en el feed */
  lastVideoId: string | null;
  /** YouTube: último vídeo cuya página hemos comprobado */
  lastCheckedVideoId: string | null;
  /** Entrada de historial activa del directo en curso */
  activeHistoryId: string | null;
  /** Pico de espectadores del directo en curso */
  peakViewers: number;
}

export interface HistoryEntry {
  id: string;
  guildId: string;
  streamerId: string;
  platform: Platform;
  channel: string;
  displayName: string;
  title: string | null;
  url: string;
  startedAt: string;
  endedAt: string | null;
  peakViewers: number;
}

export interface StreamSnapshot {
  /** false = no pudimos comprobar (error de API); no cambiar de estado */
  ok: boolean;
  isLive: boolean;
  title?: string;
  category?: string;
  viewers?: number;
  thumbnailUrl?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  url: string;
  startedAt?: string;
}