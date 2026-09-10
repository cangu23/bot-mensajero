// src/agentWorker.ts
// Worker del protocolo CHRISTEND-AGENT v1: recibe órdenes de Christend
// publicadas en el canal de coordinación y las ejecuta contra el Store
// de streamers. Reutiliza los adapters de plataforma (resolve()) para
// validar el canal antes de guardar.
//
// Tareas soportadas:
//  - vigilar:         payload { plataforma, canal, nombre? }
//  - dejar_vigilar:   payload { streamer_id }  |  { plataforma, canal }
//  - lista_vigilados: payload {}

import type { Client, Message } from "discord.js";
import { adapters } from "./platforms/index.js";
import type { Platform, Streamer } from "./types.js";
import type { Monitor } from "./monitor.js";
import type { Store } from "./store.js";
import { log } from "./logger.js";

const PROTOCOLO = "CHRISTEND-AGENT v1";
const CANAL_COORDINACION = process.env.AGENT_COORD_CHANNEL ?? "1466445473509412876";

const PLATAFORMAS: Platform[] = ["twitch", "youtube", "kick"];

export function registerAgentWorker(client: Client, store: Store, monitor: Monitor): void {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot !== true) return; // solo bots (Christend)
      if (message.author.id === client.user?.id) return;
      if (message.channel.id !== CANAL_COORDINACION) return;

      const m = message.content.match(/\{[\s\S]*\}/);
      if (!m) return;

      let orden: Record<string, unknown>;
      try {
        orden = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        return;
      }
      if (orden.protocolo !== PROTOCOLO) return;
      if (orden.worker !== "notificaciones") return;

      await ejecutarOrden(message, orden, store);
    } catch (e) {
      log("agentWorker error:", e instanceof Error ? e.message : String(e));
    }
  });
}

async function ejecutarOrden(
  message: Message,
  orden: Record<string, unknown>,
  store: Store,
): Promise<void> {
  const ordenId = String(orden.orden_id ?? "?");
  const tarea = String(orden.tarea ?? "");
  const payload = (orden.payload ?? {}) as Record<string, unknown>;

  const confirmar = async (estado: "completada" | "error", detalle: string): Promise<void> => {
    const respuesta = JSON.stringify({
      protocolo: PROTOCOLO,
      orden_id: ordenId,
      worker: "notificaciones",
      estado,
      detalle: detalle.slice(0, 400),
    });
    try {
      await message.reply(`\`\`\`json\n${respuesta}\n\`\`\``);
    } catch (e) {
      log("agentWorker: no pude confirmar la orden:", e instanceof Error ? e.message : String(e));
    }
  };

  // Necesitamos un guild para operar; la orden viaja sin guild_id explícito,
  // usamos el primer guild donde vive el canal de coordinación.
  const guild = message.guild;
  if (!guild) return confirmar("error", "Orden sin servidor asociado.");
  const guildId = guild.id;

  if (tarea === "vigilar") {
    const plataforma = String(payload.plataforma ?? "").toLowerCase() as Platform;
    const canalInput = String(payload.canal ?? "").trim();
    if (!PLATAFORMAS.includes(plataforma)) {
      return confirmar("error", `Plataforma inválida: '${plataforma}'. Usa twitch, youtube o kick.`);
    }
    if (!canalInput) return confirmar("error", "Falta 'canal' en el payload.");

    // Limpiar URLs: aceptamos login/channelId/slug directo
    const limpio = canalInput
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "")
      .replace(/^https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|@)?/i, "")
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .replace(/\/+$/, "")
      .trim();

    const adapter = adapters[plataforma];
    const resuelto = await adapter.resolve(limpio).catch(() => null);
    if (!resuelto) {
      return confirmar("error", `No pude resolver '${limpio}' en ${plataforma}. ¿Existe el canal?`);
    }

    const streamer: Streamer = {
      id: `${plataforma}:${resuelto.channel}`,
      platform: plataforma,
      channel: resuelto.channel,
      displayName: String(payload.nombre ?? resuelto.displayName).slice(0, 100),
      discordUserId: null,
      mentionRoleId: null,
      liveRoleId: null,
      offlineRoleId: null,
      notifyChannelId: null,
      color: null,
      message: null,
      enabled: true,
    };

    store.addStreamer(guildId, streamer);
    return confirmar(
      "completada",
      `Ahora vigilo a ${streamer.displayName} (${plataforma}). Estado inicial consultado en el próximo ciclo.`,
    );
  }

  if (tarea === "dejar_vigilar") {
    const streamerId = payload.streamer_id != null ? String(payload.streamer_id) : null;
    if (streamerId) {
      const ok = store.removeStreamer(guildId, streamerId);
      return ok
        ? confirmar("completada", `Streamer ${streamerId} eliminado de la vigilancia.`)
        : confirmar("error", `No encontré el streamer '${streamerId}' en este servidor.`);
    }
    // Alternativa: plataforma + canal
    const plataforma = String(payload.plataforma ?? "").toLowerCase() as Platform;
    const canal = String(payload.canal ?? "").trim().toLowerCase();
    if (PLATAFORMAS.includes(plataforma) && canal) {
      const id = `${plataforma}:${canal}`;
      const ok = store.removeStreamer(guildId, id);
      return ok
        ? confirmar("completada", `Streamer ${id} eliminado de la vigilancia.`)
        : confirmar("error", `No encontré '${id}'.`);
    }
    return confirmar("error", "Necesito 'streamer_id' o 'plataforma'+'canal' en el payload.");
  }

  if (tarea === "lista_vigilados") {
    const cfg = store.getGuild(guildId);
    if (cfg.streamers.length === 0) {
      return confirmar("completada", "No hay streamers vigilados todavía.");
    }
    const lineas = cfg.streamers.map((s) => {
      const st = store.getState(s.id);
      return `${st.isLive ? "🔴 EN VIVO" : "⚫ offline"} — ${s.displayName} (${s.platform}) [${s.id}]`;
    });
    return confirmar("completada", `Vigilando ${cfg.streamers.length}: ${lineas.join(" | ").slice(0, 350)}`);
  }

  return confirmar("error", `Tarea desconocida para Notificaciones: ${tarea}`);
}
