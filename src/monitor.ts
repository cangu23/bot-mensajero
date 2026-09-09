import { randomUUID } from "node:crypto";
import { Client, Guild } from "discord.js";
import { log } from "./logger.js";
import { markOffline, notifyLive } from "./notifications.js";
import { adapters } from "./platforms/index.js";
import type { CheckResult } from "./platforms/types.js";
import { applyLive, applyOffline } from "./roles.js";
import { Store } from "./store.js";
import type { GuildConfig, Streamer } from "./types.js";

/** Comprobaciones consecutivas "no hay directo" antes de darlo por terminado (evita parpadeos de API) */
const CONFIRM_OFFLINE_CHECKS = 2;
const SKIP_LOG_INTERVAL_MS = 10 * 60_000;
/** Delay antes del primer poll en arranques limpios (ms) */
const FIRST_POLL_DELAY_MS = 2_000;
/** Delay antes del primer poll cuando se detecta otra instancia viva (ms) */
const FIRST_POLL_DELAY_DUPLICATE_MS = 15_000;

export interface PollSummary {
  total: number;
  live: number;
  offline: number;
  skipped: number;
  errors: number;
  liveNames: string[];
  /** true si ya había una comprobación en curso y esta se descartó */
  busy?: boolean;
}

export class Monitor {
  lastPollAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private skipLogs = new Map<string, number>();
  private lastPlatformPoll = new Map<string, number>();
  private running = false;

  isBusy(): boolean {
    return this.running;
  }

  constructor(
    private client: Client,
    private store: Store,
  ) {}

  start(intervalSeconds: number, cleanStart = true): void {
    const ms = Math.max(10, intervalSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, ms);
    this.timer.unref?.();
    log(`⏱ Monitor activo: comprobación cada ${intervalSeconds}s`);
    // Primer barrido poco después de arrancar (detecta directos iniciados mientras el bot estaba apagado)
    const delay = cleanStart ? FIRST_POLL_DELAY_MS : FIRST_POLL_DELAY_DUPLICATE_MS;
    if (!cleanStart) {
      log(`⚠️ Monitor: primer poll retrasado ${delay / 1000}s por posible instancia duplicada`);
    }
    setTimeout(() => {
      void this.pollOnce();
    }, delay);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async getGuild(guildId: string): Promise<Guild | null> {
    let guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      try {
        guild = await this.client.guilds.fetch(guildId);
      } catch {
        return null;
      }
    }
    return guild;
  }

  private logSkipped(streamerId: string, msg: string): void {
    const now = Date.now();
    const last = this.skipLogs.get(streamerId) ?? 0;
    if (now - last > SKIP_LOG_INTERVAL_MS) {
      log(`⚠️ ${streamerId}: ${msg}`);
      this.skipLogs.set(streamerId, now);
    }
  }

  async pollOnce(): Promise<PollSummary> {
    if (this.running) {
      return { total: 0, live: 0, offline: 0, skipped: 0, errors: 0, liveNames: [], busy: true };
    }
    this.running = true;
    this.lastPollAt = new Date();
    const summary: PollSummary = { total: 0, live: 0, offline: 0, skipped: 0, errors: 0, liveNames: [] };

    try {
      await this.pollAll(summary);
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async pollAll(summary: PollSummary): Promise<void> {
    const tasks: Promise<void>[] = [];
    const now = Date.now();

    for (const guild of this.client.guilds.cache.values()) {
      const cfg = this.store.getGuild(guild.id);
      for (const streamer of cfg.streamers.filter((s) => s.enabled)) {
        // En plataformas basadas en scraping (YouTube, Kick), no consultar más de 1 vez cada 60s
        // Twitch usa la API oficial y se consulta a máxima velocidad (en cada intervalo)
        if (streamer.platform !== "twitch") {
          const lastCheck = this.lastPlatformPoll.get(streamer.id) ?? 0;
          if (now - lastCheck < 55_000) {
            continue;
          }
        }
        this.lastPlatformPoll.set(streamer.id, now);
        summary.total++;
        tasks.push(this.checkStreamer(guild, cfg, streamer, summary));
      }
    }
    await Promise.allSettled(tasks);
  }

  private async checkStreamer(
    guild: Guild,
    cfg: GuildConfig,
    streamer: Streamer,
    summary: PollSummary,
  ): Promise<void> {
    const adapter = adapters[streamer.platform];
    if (!adapter) {
      summary.errors++;
      return;
    }
    const state = this.store.getState(streamer.id);
    let result: CheckResult;
    try {
      result = await adapter.check(streamer, state);
    } catch (e) {
      summary.errors++;
      this.logSkipped(streamer.id, `error al comprobar: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const snap = result.snapshot;
    if (!snap.ok) {
      summary.skipped++;
      this.logSkipped(streamer.id, `sin respuesta de ${streamer.platform} (API/servicio)`);
      return;
    }
    if (result.state) Object.assign(state, result.state);

    const guildObj = await this.getGuild(guild.id);
    if (!guildObj) {
      summary.skipped++;
      return;
    }

    if (snap.isLive) {
      state.consecutiveOffline = 0;
      if (!state.isLive) {
        // Transición: empieza el directo
        state.isLive = true;
        state.title = snap.title ?? null;
        state.startedAt = snap.startedAt ?? null;
        state.peakViewers = snap.viewers ?? 0;
        const sent = await notifyLive(guildObj, cfg, streamer, snap);
        state.notifyMessageId = sent?.message.id ?? null;
        // Guardamos el canal REAL donde se publicó (puede ser el propio del streamer)
        state.notifyChannelId = sent?.channelId ?? null;
        // Historial: abrimos una entrada para este directo
        const historyId = randomUUID();
        state.activeHistoryId = historyId;
        this.store.addHistory({
          id: historyId,
          guildId: guild.id,
          streamerId: streamer.id,
          platform: streamer.platform,
          channel: streamer.channel,
          displayName: streamer.displayName,
          title: state.title,
          url: snap.url,
          startedAt: snap.startedAt ?? new Date().toISOString(),
          endedAt: null,
          peakViewers: state.peakViewers,
        });
        await applyLive(guildObj, cfg, streamer);
        summary.live++;
        summary.liveNames.push(streamer.displayName);
      } else {
        state.peakViewers = Math.max(state.peakViewers ?? 0, snap.viewers ?? 0);
        summary.live++;
        summary.liveNames.push(streamer.displayName);
      }
    } else if (state.isLive) {
      state.consecutiveOffline++;
      if (state.consecutiveOffline >= CONFIRM_OFFLINE_CHECKS) {
        // Transición: termina el directo
        state.isLive = false;
        await markOffline(guildObj, cfg, streamer, state);
        // Historial: cerramos la entrada abierta
        this.store.finalizeHistory(state.activeHistoryId ?? "", new Date().toISOString(), state.peakViewers ?? 0);
        state.activeHistoryId = null;
        state.notifyMessageId = null;
        state.notifyChannelId = null;
        await applyOffline(guildObj, cfg, streamer);
        summary.offline++;
      }
    } else {
      state.consecutiveOffline = 0;
    }

    this.store.setState(streamer.id, state);
  }
}