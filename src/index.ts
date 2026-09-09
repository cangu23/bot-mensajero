import { Client, GatewayIntentBits } from "discord.js";
import { createHandler, registerCommands, registerCommandsForGuild } from "./commands.js";
import { env, validateEnv } from "./env.js";
import { ProcessLock } from "./lock.js";
import { log } from "./logger.js";
import { Monitor } from "./monitor.js";
import { Store } from "./store.js";
import { startWebServer, stopWebServer } from "./web/server.js";

const INVITE_PERMISSIONS = 268528648; // ver canal, mensajes, gestionar mensajes, embeds, historial, gestionar roles, mencionar roles

async function main(): Promise<void> {
  const missing = validateEnv();
  if (missing.length > 0) {
    console.error(`❌ Faltan variables de entorno obligatorias: ${missing.join(", ")}`);
    console.error("   Copia .env.example a .env y rellena los valores.");
    process.exit(1);
  }

  const lock = new ProcessLock(env.DATA_FILE);
  const cleanStart = lock.acquire();

  const store = new Store(env.DATA_FILE);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // necesario para asignar/quitar roles (intent privilegiado en el portal)
      GatewayIntentBits.GuildMessages,
    ],
    allowedMentions: { parse: ["roles", "everyone", "users"], repliedUser: false },
  });

  const monitor = new Monitor(client, store);
  const handler = createHandler(client, store, monitor);

  // Iniciar servidor web/keep-alive de inmediato para que Render detecte el puerto abierto al arrancar
  startWebServer(client, store, monitor);

  client.once("clientReady", async (c) => {
    log(`✅ Conectado como ${c.user.tag} en ${c.guilds.cache.size} servidor(es)`);
    if (env.GUILD_ID) {
      log(
        `🔗 Invita al bot (solo si no lo has hecho): https://discord.com/api/oauth2/authorize?client_id=${c.user.id}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`,
      );
    }
    await registerCommands(c);
    log("📋 Comandos slash registrados");
    monitor.start(env.POLL_INTERVAL_SECONDS, cleanStart);
  });

  client.on("interactionCreate", handler);
  // Al entrar en un servidor nuevo, registramos los comandos al momento (sin reiniciar)
  client.on("guildCreate", async (guild) => {
    try {
      await registerCommandsForGuild(guild);
      log(`✅ Comandos registrados en el servidor nuevo: ${guild.name}`);
    } catch (e) {
      log(`⚠️ No pude registrar comandos en ${guild.name}:`, e instanceof Error ? e.message : String(e));
    }
  });
  client.on("error", (e) => log("⚠️ Error del cliente Discord:", e.message));

  async function shutdown(): Promise<void> {
    log("👋 Apagando...");
    monitor.stop();
    stopWebServer();
    store.flushNow();
    lock.release();
    client.destroy();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("unhandledRejection", (reason) => log("⚠️ Promesa sin manejar:", reason));

  await client.login(env.DISCORD_TOKEN);
}

void main();