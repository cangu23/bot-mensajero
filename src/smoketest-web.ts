/* Smoke test del panel web: arranca el servidor con un cliente Discord falso
 * y verifica auth, estáticos, API y persistencia. Uso: npm run smoketest-web */
import { Collection } from "discord.js";

process.env.WEB_PANEL_PASSWORD = "clave-de-prueba";
process.env.WEB_PANEL_PORT = "3999";
process.env.WEB_PANEL_HOST = "127.0.0.1";
process.env.DATA_FILE = `./data/smoketest-${Date.now()}.json`;

let failures = 0;

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✅ ${label}`);
  else {
    console.log(`  ❌ ${label} ${detail}`);
    failures++;
  }
}

async function main(): Promise<void> {
  // Cargamos el grafo de módulos DESPUÉS de fijar las variables (ESM cachea el módulo env)
  const { Store } = await import("./store.js");
  const { startWebServer, stopWebServer } = await import("./web/server.js");
  const { env } = await import("./env.js");

  function makeFakeGuild(id: string, name: string) {
    return {
      id,
      name,
      roles: { cache: new Collection(), fetch: async () => null },
      channels: { cache: new Collection(), fetch: async () => null },
      members: { cache: new Collection(), fetch: async () => new Collection() },
    };
  }

  const YT_ID_A = "UCAAAAAAAAAAAAAAAAAAAAAA"; // 24 chars: UC + 22
  const YT_ID_B = "UCBBBBBBBBBBBBBBBBBBBBBB";
  const YT_ID_C = "UCCCCCCCCCCCCCCCCCCCCCCC";

  const guild = makeFakeGuild("111", "Gremio de Prueba");
  const fakeClient = {
    guilds: {
      cache: new Collection([[guild.id, guild]]),
      first: () => guild,
    },
  };

  const store = new Store(env.DATA_FILE);
  store.addStreamer("111", {
    id: `youtube:${YT_ID_A}`,
    platform: "youtube",
    channel: YT_ID_A,
    displayName: "Canal de prueba",
    notifyChannelId: null,
    discordUserId: null,
    mentionRoleId: null,
    liveRoleId: null,
    offlineRoleId: null,
    color: 0x9146ff,
    message: null,
    enabled: true,
  });
  store.addHistory({
    id: "hist-1",
    guildId: "111",
    streamerId: `youtube:${YT_ID_A}`,
    platform: "youtube",
    channel: YT_ID_A,
    displayName: "Canal de prueba",
    title: "Directo de prueba",
    url: "https://youtube.com/watch?v=abc",
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: null,
    peakViewers: 42,
  });

  const fakeMonitor = {
    lastPollAt: new Date(),
    isBusy: () => false,
    pollOnce: async () => ({ total: 0, live: 0, offline: 0, skipped: 0, errors: 0, liveNames: [] }),
  };

  startWebServer(fakeClient as never, store, fakeMonitor as never);

  const BASE = "http://127.0.0.1:3999";
  async function req(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.cookie) headers.Cookie = opts.cookie;
    const res = await fetch(BASE + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    return { status: res.status, json, text, setCookie: res.headers.get("set-cookie") };
  }

  // Sin sesión
  let r = await req("/api/auth/status");
  check("auth/status sin sesión → no autenticado", r.status === 200 && r.json?.authenticated === false);

  r = await req("/api/login", { method: "POST", body: { password: "incorrecta" } });
  check("login con contraseña incorrecta → 401", r.status === 401);

  r = await req("/api/login", { method: "POST", body: { password: "clave-de-prueba" } });
  check("login correcto → 200 + cookie", r.status === 200 && Boolean(r.setCookie?.includes("gremio_panel=")));
  const cookie = r.setCookie?.split(";")[0] ?? "";

  r = await req("/api/guilds");
  check("API sin sesión → 401", r.status === 401);

  r = await req("/api/guilds", { cookie });
  check("guilds con sesión", r.status === 200 && Array.isArray(r.json?.guilds) && r.json.guilds.length === 1);

  r = await req("/api/config?guildId=111", { cookie });
  check("config con streamer", r.status === 200 && r.json?.streamers?.length === 1 && r.json.streamers[0].live === false);

  r = await req("/api/roles?guildId=111", { cookie });
  check("roles", r.status === 200 && Array.isArray(r.json?.roles));

  r = await req("/api/channels?guildId=111", { cookie });
  check("channels", r.status === 200 && Array.isArray(r.json?.channels));

  r = await req("/api/members?guildId=111", { cookie });
  check("members", r.status === 200 && Array.isArray(r.json?.members));

  r = await req("/api/history?guildId=111", { cookie });
  check("historial (1 entrada en curso)", r.status === 200 && r.json?.entries?.length === 1 && r.json.entries[0].endedAt === null);
  check("historial streamers para filtro", r.json?.streamers?.length === 1);

  r = await req("/api/config?guildId=111", { method: "POST", cookie, body: { notifyChannelId: "chan-1", liveRoleId: null } });
  check("actualizar config", r.status === 200 && r.json?.ok === true);
  r = await req("/api/config?guildId=111", { cookie });
  check("config persistida (canal chan-1)", r.json?.config?.notifyChannelId === "chan-1");

  r = await req("/api/streamers?guildId=111", { method: "POST", cookie, body: { platform: "steam", channel: "x" } });
  check("añadir con plataforma inválida → 400", r.status === 400);
  r = await req("/api/streamers?guildId=111", { method: "POST", cookie, body: { platform: "youtube", channel: "" } });
  check("añadir sin canal → 400", r.status === 400);

  r = await req(`/api/streamers/${encodeURIComponent(`youtube:${YT_ID_A}`)}?guildId=111`, {
    method: "PUT",
    cookie,
    body: { displayName: "Renombrado", enabled: false },
  });
  check("editar streamer", r.status === 200 && r.json?.ok === true);
  r = await req("/api/config?guildId=111", { cookie });
  check("edit persistido (enabled=false, Renombrado)", r.json?.streamers?.[0]?.enabled === false && r.json?.streamers?.[0]?.displayName === "Renombrado");

  r = await req(`/api/streamers/${encodeURIComponent(`youtube:${YT_ID_A}`)}?guildId=111`, {
    method: "PUT",
    cookie,
    body: { notifyChannelId: "chan-2" },
  });
  check("editar canal de anuncios por streamer", r.status === 200 && r.json?.ok === true);
  r = await req("/api/config?guildId=111", { cookie });
  check("canal de anuncios persistido (chan-2)", r.json?.streamers?.[0]?.notifyChannelId === "chan-2");

  r = await req("/api/check?guildId=111", { method: "POST", cookie });
  check("check manual", r.status === 200 && r.json?.summary);

  r = await req(`/api/streamers/${encodeURIComponent(`youtube:${YT_ID_A}`)}?guildId=111`, { method: "DELETE", cookie });
  check("eliminar streamer", r.status === 200 && r.json?.ok === true);
  r = await req("/api/config?guildId=111", { cookie });
  check("streamer eliminado", r.json?.streamers?.length === 0);

  // Plataforma detectada desde la URL (sin necesidad de indicarla)
  r = await req("/api/streamers?guildId=111", {
    method: "POST",
    cookie,
    body: { channel: `https://www.youtube.com/channel/${YT_ID_B}` },
  });
  check("añadir con URL (detección automática)", r.status === 201 && r.json?.streamer?.platform === "youtube" && r.json.streamer.channel === YT_ID_B);
  r = await req("/api/streamers?guildId=111", { method: "POST", cookie, body: { channel: "https://kick.com/xqc" } });
  check("añadir con URL de kick detecta kick (plataforma detectada, resolución dependerá de la red)", r.status === 404 || r.status === 400, `status=${r.status}`);

  // Bulk
  r = await req("/api/streamers/bulk?guildId=111", { method: "POST", cookie, body: { channels: [] } });
  check("bulk vacío → 400", r.status === 400);
  r = await req("/api/streamers/bulk?guildId=111", { method: "POST", cookie, body: { channels: ["nombre-sin-url"] } });
  check("bulk sin URL → error por elemento", r.status === 200 && r.json?.errors?.length === 1 && r.json.added.length === 0);
  r = await req("/api/streamers/bulk?guildId=111", {
    method: "POST",
    cookie,
    body: {
      channels: [
        `https://www.youtube.com/channel/${YT_ID_C}`,
        `https://www.youtube.com/channel/${YT_ID_B}`, // ya añadido antes
        "no-url",
      ],
    },
  });
  check("bulk mixto: 1 añadido, 1 duplicado, 1 error", r.status === 200 && r.json?.added?.length === 1 && r.json?.duplicates?.length === 1 && r.json?.errors?.length === 1);

  // Estáticos
  r = await req("/");
  check("servir index.html", r.status === 200 && r.text.includes("Gremio Estelar"));
  r = await req("/app.js");
  check("servir app.js", r.status === 200 && r.text.includes("api("));
  r = await req("/style.css");
  check("servir style.css", r.status === 200);
  r = await req("/favicon.svg");
  check("servir favicon", r.status === 200);
  r = await req("/../package.json");
  check("traversal bloqueado → 404", r.status === 404);

  stopWebServer();
  store.flushNow();
  try {
    const { rmSync } = await import("node:fs");
    rmSync(env.DATA_FILE, { force: true });
    rmSync(`${env.DATA_FILE}.tmp`, { force: true });
  } catch {
    /* limpieza opcional */
  }
  console.log(failures === 0 ? "\n🎉 Smoke test del panel: TODO OK" : `\n❌ ${failures} fallo(s)`);
  // Dejamos que el proceso termine solo (evita el assert de libuv en Windows)
  process.exitCode = failures ? 1 : 0;
}

void main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});