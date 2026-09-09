import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";
import type { GuildConfig, HistoryEntry, Streamer, StreamState } from "./types.js";

/** Máximo de entradas de historial que conservamos (las más recientes) */
const MAX_HISTORY = 5000;

// ── Helpers ────────────────────────────────────────────────────────────────

function toJson(v: unknown): string {
  return JSON.stringify(v);
}

function fromJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function defaultGuildConfig(): GuildConfig {
  return { notifyChannelId: null, liveRoleId: null, offlineRoleId: null, streamers: [] };
}

function defaultState(): StreamState {
  return {
    isLive: false,
    consecutiveOffline: 0,
    notifyMessageId: null,
    notifyChannelId: null,
    title: null,
    startedAt: null,
    lastVideoId: null,
    lastCheckedVideoId: null,
    activeHistoryId: null,
    peakViewers: 0,
  };
}

// ── Tipos internos del JSON legacy (para migración) ───────────────────────

interface LegacyStoreData {
  guilds: Record<string, GuildConfig>;
  states: Record<string, StreamState>;
  history: HistoryEntry[];
}

// ── Store ──────────────────────────────────────────────────────────────────

/**
 * Almacenamiento SQLite con WAL.
 * Mantiene la misma interfaz pública que el Store JSON anterior,
 * por lo que el resto del código no necesita cambios.
 * Al primer arranque migra automáticamente desde store.json si existe.
 */
export class Store {
  private db: Database.Database;

  constructor(private readonly file: string) {
    // Aseguramos que el directorio existe
    mkdirSync(dirname(file), { recursive: true });

    this.db = new Database(file);
    // WAL: escrituras no bloquean lecturas
    this.db.pragma("journal_mode = WAL");
    // Mejora rendimiento en inserciones masivas
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    this.createSchema();
    this.migrateFromJson();

    log(`📂 Base de datos cargada desde ${file}`);
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        guild_id    TEXT PRIMARY KEY,
        notify_channel_id TEXT,
        live_role_id      TEXT,
        offline_role_id   TEXT
      );

      CREATE TABLE IF NOT EXISTS streamers (
        id               TEXT PRIMARY KEY,
        guild_id         TEXT NOT NULL,
        platform         TEXT NOT NULL,
        channel          TEXT NOT NULL,
        display_name     TEXT NOT NULL,
        discord_user_id  TEXT,
        mention_role_id  TEXT,
        live_role_id     TEXT,
        offline_role_id  TEXT,
        notify_channel_id TEXT,
        color            INTEGER,
        message          TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS states (
        streamer_id           TEXT PRIMARY KEY,
        is_live               INTEGER NOT NULL DEFAULT 0,
        consecutive_offline   INTEGER NOT NULL DEFAULT 0,
        notify_message_id     TEXT,
        notify_channel_id     TEXT,
        title                 TEXT,
        started_at            TEXT,
        last_video_id         TEXT,
        last_checked_video_id TEXT,
        active_history_id     TEXT,
        peak_viewers          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS history (
        id           TEXT PRIMARY KEY,
        guild_id     TEXT NOT NULL,
        streamer_id  TEXT NOT NULL,
        platform     TEXT NOT NULL,
        channel      TEXT NOT NULL,
        display_name TEXT NOT NULL,
        title        TEXT,
        url          TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        ended_at     TEXT,
        peak_viewers INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_streamers_guild ON streamers(guild_id);
      CREATE INDEX IF NOT EXISTS idx_history_guild   ON history(guild_id);
      CREATE INDEX IF NOT EXISTS idx_history_streamer ON history(streamer_id);
    `);
  }

  // ── Migración desde JSON ─────────────────────────────────────────────────

  private migrateFromJson(): void {
    // Derivamos la ruta del JSON a partir del path de la DB
    const jsonPath = this.file.replace(/\.db$/, ".json");
    if (!existsSync(jsonPath)) return;

    // Solo migramos si la DB está vacía
    const count = (this.db.prepare("SELECT COUNT(*) as c FROM guilds").get() as { c: number }).c;
    if (count > 0) return;

    try {
      const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Partial<LegacyStoreData>;
      const guilds = raw.guilds ?? {};
      const states = raw.states ?? {};
      const history = Array.isArray(raw.history) ? raw.history : [];

      const migrate = this.db.transaction(() => {
        for (const [guildId, cfg] of Object.entries(guilds)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO guilds (guild_id, notify_channel_id, live_role_id, offline_role_id)
            VALUES (?, ?, ?, ?)
          `).run(guildId, cfg.notifyChannelId ?? null, cfg.liveRoleId ?? null, cfg.offlineRoleId ?? null);

          for (const s of cfg.streamers ?? []) {
            this.db.prepare(`
              INSERT OR IGNORE INTO streamers
                (id, guild_id, platform, channel, display_name, discord_user_id, mention_role_id,
                 live_role_id, offline_role_id, notify_channel_id, color, message, enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              s.id, guildId, s.platform, s.channel, s.displayName,
              s.discordUserId ?? null, s.mentionRoleId ?? null,
              s.liveRoleId ?? null, s.offlineRoleId ?? null,
              s.notifyChannelId ?? null, s.color ?? null,
              s.message ?? null, s.enabled ? 1 : 0,
            );
          }
        }

        for (const [streamerId, st] of Object.entries(states)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO states
              (streamer_id, is_live, consecutive_offline, notify_message_id, notify_channel_id,
               title, started_at, last_video_id, last_checked_video_id, active_history_id, peak_viewers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            streamerId, st.isLive ? 1 : 0, st.consecutiveOffline ?? 0,
            st.notifyMessageId ?? null, st.notifyChannelId ?? null,
            st.title ?? null, st.startedAt ?? null,
            st.lastVideoId ?? null, st.lastCheckedVideoId ?? null,
            st.activeHistoryId ?? null, st.peakViewers ?? 0,
          );
        }

        for (const h of history) {
          this.db.prepare(`
            INSERT OR IGNORE INTO history
              (id, guild_id, streamer_id, platform, channel, display_name, title, url, started_at, ended_at, peak_viewers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            h.id, h.guildId, h.streamerId, h.platform, h.channel, h.displayName,
            h.title ?? null, h.url, h.startedAt, h.endedAt ?? null, h.peakViewers ?? 0,
          );
        }
      });

      migrate();
      renameSync(jsonPath, `${jsonPath}.migrated`);
      log(`✅ Datos migrados desde ${jsonPath} → SQLite (renombrado a .migrated)`);
    } catch (e) {
      log(`⚠️ No pude migrar ${jsonPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Guilds ────────────────────────────────────────────────────────────────

  getGuild(guildId: string): GuildConfig {
    // Upsert silencioso: la primera vez que se pide un guild lo creamos
    this.db.prepare(`
      INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)
    `).run(guildId);

    const row = this.db.prepare(`
      SELECT notify_channel_id, live_role_id, offline_role_id FROM guilds WHERE guild_id = ?
    `).get(guildId) as { notify_channel_id: string | null; live_role_id: string | null; offline_role_id: string | null };

    const streamers = this.getStreamersForGuild(guildId);

    const cfg: GuildConfig = {
      notifyChannelId: row.notify_channel_id,
      liveRoleId:      row.live_role_id,
      offlineRoleId:   row.offline_role_id,
      streamers,
    };

    // Proxy: cualquier mutación directa sobre cfg.notifyChannelId etc. la persistimos
    // (igual que hacía el Store JSON)
    return new Proxy(cfg, {
      set: (target, prop, value) => {
        (target as unknown as Record<string, unknown>)[prop as string] = value;
        if (prop === "notifyChannelId" || prop === "liveRoleId" || prop === "offlineRoleId") {
          this.db.prepare(`
            UPDATE guilds SET notify_channel_id = ?, live_role_id = ?, offline_role_id = ? WHERE guild_id = ?
          `).run(target.notifyChannelId ?? null, target.liveRoleId ?? null, target.offlineRoleId ?? null, guildId);
          this.onChange?.();
        }
        return true;
      },
    });
  }

  private getStreamersForGuild(guildId: string): Streamer[] {
    const rows = this.db.prepare(`
      SELECT * FROM streamers WHERE guild_id = ? ORDER BY rowid
    `).all(guildId) as Array<Record<string, unknown>>;

    return rows.map(this.rowToStreamer);
  }

  private rowToStreamer(row: Record<string, unknown>): Streamer {
    return {
      id:              row.id as string,
      platform:        row.platform as Streamer["platform"],
      channel:         row.channel as string,
      displayName:     row.display_name as string,
      discordUserId:   (row.discord_user_id as string | null) ?? null,
      mentionRoleId:   (row.mention_role_id as string | null) ?? null,
      liveRoleId:      (row.live_role_id as string | null) ?? null,
      offlineRoleId:   (row.offline_role_id as string | null) ?? null,
      notifyChannelId: (row.notify_channel_id as string | null) ?? null,
      color:           (row.color as number | null) ?? null,
      message:         (row.message as string | null) ?? null,
      enabled:         Boolean(row.enabled),
    };
  }

  public onChange?: () => void;

  addStreamer(guildId: string, streamer: Streamer): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)
    `).run(guildId);

    this.db.prepare(`
      INSERT OR REPLACE INTO streamers
        (id, guild_id, platform, channel, display_name, discord_user_id, mention_role_id,
         live_role_id, offline_role_id, notify_channel_id, color, message, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      streamer.id, guildId, streamer.platform, streamer.channel, streamer.displayName,
      streamer.discordUserId ?? null, streamer.mentionRoleId ?? null,
      streamer.liveRoleId ?? null, streamer.offlineRoleId ?? null,
      streamer.notifyChannelId ?? null, streamer.color ?? null,
      streamer.message ?? null, streamer.enabled ? 1 : 0,
    );
    this.onChange?.();
  }

  removeStreamer(guildId: string, streamerId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM streamers WHERE id = ? AND guild_id = ?
    `).run(streamerId, guildId);
    if (result.changes > 0) {
      this.onChange?.();
      return true;
    }
    return false;
  }

  getStreamer(guildId: string, streamerId: string): Streamer | undefined {
    const row = this.db.prepare(`
      SELECT * FROM streamers WHERE id = ? AND guild_id = ?
    `).get(streamerId, guildId) as Record<string, unknown> | undefined;
    return row ? this.rowToStreamer(row) : undefined;
  }

  streamerCount(guildId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c FROM streamers WHERE guild_id = ?
    `).get(guildId) as { c: number };
    return row.c;
  }

  /** Persiste cambios a un Streamer concreto (llamado cuando se edita via API). */
  updateStreamer(streamer: Streamer): void {
    this.db.prepare(`
      UPDATE streamers SET
        display_name      = ?,
        discord_user_id   = ?,
        mention_role_id   = ?,
        live_role_id      = ?,
        offline_role_id   = ?,
        notify_channel_id = ?,
        color             = ?,
        message           = ?,
        enabled           = ?
      WHERE id = ?
    `).run(
      streamer.displayName,
      streamer.discordUserId ?? null,
      streamer.mentionRoleId ?? null,
      streamer.liveRoleId ?? null,
      streamer.offlineRoleId ?? null,
      streamer.notifyChannelId ?? null,
      streamer.color ?? null,
      streamer.message ?? null,
      streamer.enabled ? 1 : 0,
      streamer.id,
    );
    this.onChange?.();
  }

  // ── Stream states ──────────────────────────────────────────────────────────

  getState(streamerId: string): StreamState {
    const row = this.db.prepare(`
      SELECT * FROM states WHERE streamer_id = ?
    `).get(streamerId) as Record<string, unknown> | undefined;

    if (!row) {
      const s = defaultState();
      // Insertamos el estado por defecto
      this.db.prepare(`
        INSERT OR IGNORE INTO states (streamer_id) VALUES (?)
      `).run(streamerId);
      return s;
    }

    return {
      isLive:              Boolean(row.is_live),
      consecutiveOffline:  (row.consecutive_offline as number) ?? 0,
      notifyMessageId:     (row.notify_message_id as string | null) ?? null,
      notifyChannelId:     (row.notify_channel_id as string | null) ?? null,
      title:               (row.title as string | null) ?? null,
      startedAt:           (row.started_at as string | null) ?? null,
      lastVideoId:         (row.last_video_id as string | null) ?? null,
      lastCheckedVideoId:  (row.last_checked_video_id as string | null) ?? null,
      activeHistoryId:     (row.active_history_id as string | null) ?? null,
      peakViewers:         (row.peak_viewers as number) ?? 0,
    };
  }

  setState(streamerId: string, state: StreamState): void {
    this.db.prepare(`
      INSERT INTO states
        (streamer_id, is_live, consecutive_offline, notify_message_id, notify_channel_id,
         title, started_at, last_video_id, last_checked_video_id, active_history_id, peak_viewers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(streamer_id) DO UPDATE SET
        is_live               = excluded.is_live,
        consecutive_offline   = excluded.consecutive_offline,
        notify_message_id     = excluded.notify_message_id,
        notify_channel_id     = excluded.notify_channel_id,
        title                 = excluded.title,
        started_at            = excluded.started_at,
        last_video_id         = excluded.last_video_id,
        last_checked_video_id = excluded.last_checked_video_id,
        active_history_id     = excluded.active_history_id,
        peak_viewers          = excluded.peak_viewers
    `).run(
      streamerId,
      state.isLive ? 1 : 0,
      state.consecutiveOffline,
      state.notifyMessageId ?? null,
      state.notifyChannelId ?? null,
      state.title ?? null,
      state.startedAt ?? null,
      state.lastVideoId ?? null,
      state.lastCheckedVideoId ?? null,
      state.activeHistoryId ?? null,
      state.peakViewers ?? 0,
    );
  }

  // ── Historial ──────────────────────────────────────────────────────────────

  addHistory(entry: HistoryEntry): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO history
        (id, guild_id, streamer_id, platform, channel, display_name, title, url, started_at, ended_at, peak_viewers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.guildId, entry.streamerId, entry.platform,
      entry.channel, entry.displayName, entry.title ?? null,
      entry.url, entry.startedAt, entry.endedAt ?? null, entry.peakViewers ?? 0,
    );

    // Poda: mantenemos solo los MAX_HISTORY más recientes por guild
    this.db.prepare(`
      DELETE FROM history WHERE guild_id = ? AND id NOT IN (
        SELECT id FROM history WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?
      )
    `).run(entry.guildId, entry.guildId, MAX_HISTORY);
  }

  /** Cierra una entrada de historial abierta (fin del directo). */
  finalizeHistory(id: string, endedAt: string, peakViewers: number): void {
    this.db.prepare(`
      UPDATE history SET ended_at = ?, peak_viewers = MAX(peak_viewers, ?) WHERE id = ?
    `).run(endedAt, peakViewers, id);
  }

  getHistory(opts: { guildId?: string; streamerId?: string; limit?: number }): HistoryEntry[] {
    const { guildId, streamerId, limit = 100 } = opts;
    const safeLimit = Math.min(Math.max(limit, 1), 500);

    let sql = `SELECT * FROM history WHERE 1=1`;
    const params: unknown[] = [];
    if (guildId) { sql += ` AND guild_id = ?`; params.push(guildId); }
    if (streamerId) { sql += ` AND streamer_id = ?`; params.push(streamerId); }
    sql += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(safeLimit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id:          row.id as string,
      guildId:     row.guild_id as string,
      streamerId:  row.streamer_id as string,
      platform:    row.platform as HistoryEntry["platform"],
      channel:     row.channel as string,
      displayName: row.display_name as string,
      title:       (row.title as string | null) ?? null,
      url:         row.url as string,
      startedAt:   row.started_at as string,
      endedAt:     (row.ended_at as string | null) ?? null,
      peakViewers: (row.peak_viewers as number) ?? 0,
    }));
  }

  /** Streamers distintos que aparecen en el historial de un gremio (para filtros). */
  historyStreamers(guildId: string): Array<{ streamerId: string; displayName: string }> {
    const rows = this.db.prepare(`
      SELECT streamer_id, MAX(display_name) as display_name
      FROM history WHERE guild_id = ?
      GROUP BY streamer_id
      ORDER BY MAX(started_at) DESC
    `).all(guildId) as Array<{ streamer_id: string; display_name: string }>;
    return rows.map((r) => ({ streamerId: r.streamer_id, displayName: r.display_name }));
  }

  /** Total de streamers en todos los servidores. */
  streamerCountAll(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM streamers").get() as { c: number };
    return row.c;
  }

  /** Exporta toda la configuración y streamers a formato JSON. */
  exportJson(): string {
    const guildsRows = this.db.prepare("SELECT * FROM guilds").all() as Array<Record<string, unknown>>;
    const guilds: Record<string, GuildConfig> = {};
    for (const g of guildsRows) {
      const gid = g.guild_id as string;
      guilds[gid] = {
        notifyChannelId: (g.notify_channel_id as string | null) ?? null,
        liveRoleId: (g.live_role_id as string | null) ?? null,
        offlineRoleId: (g.offline_role_id as string | null) ?? null,
        streamers: this.getStreamersForGuild(gid),
      };
    }
    return JSON.stringify({ guilds, version: 1, exportedAt: new Date().toISOString() }, null, 2);
  }

  /** Importa configuración y streamers desde JSON. */
  importJson(rawJson: string): boolean {
    try {
      const data = JSON.parse(rawJson);
      const guilds = data.guilds ?? {};
      const tx = this.db.transaction(() => {
        for (const [guildId, cfg] of Object.entries(guilds as Record<string, GuildConfig>)) {
          this.db.prepare(`
            INSERT OR REPLACE INTO guilds (guild_id, notify_channel_id, live_role_id, offline_role_id)
            VALUES (?, ?, ?, ?)
          `).run(guildId, cfg.notifyChannelId ?? null, cfg.liveRoleId ?? null, cfg.offlineRoleId ?? null);

          for (const s of cfg.streamers ?? []) {
            this.db.prepare(`
              INSERT OR REPLACE INTO streamers
                (id, guild_id, platform, channel, display_name, discord_user_id, mention_role_id,
                 live_role_id, offline_role_id, notify_channel_id, color, message, enabled)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              s.id, guildId, s.platform, s.channel, s.displayName,
              s.discordUserId ?? null, s.mentionRoleId ?? null,
              s.liveRoleId ?? null, s.offlineRoleId ?? null,
              s.notifyChannelId ?? null, s.color ?? null,
              s.message ?? null, s.enabled ? 1 : 0,
            );
          }
        }
      });
      tx();
      log(`📥 Copia importada con éxito: ${this.streamerCountAll()} streamers cargados.`);
      return true;
    } catch (e) {
      log("⚠️ Error importando JSON:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // ── Compatibilidad con el Store JSON ──────────────────────────────────────

  /**
   * En el Store JSON, `persist()` guardaba todo a disco con debounce.
   * En SQLite las escrituras son inmediatas, así que esto es un no-op.
   * Se mantiene por compatibilidad con los llamadores existentes.
   */
  persist(): void { /* SQLite escribe de forma inmediata y atómica */ }

  /** Igual que persist(), mantenido por compatibilidad con shutdown(). */
  flushNow(): void { /* no-op */ }

  /** Cierra la conexión con la DB (llamar al apagar). */
  close(): void {
    this.db.close();
  }
}