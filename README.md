# 🌟 Gremio Estelar · Bot de directos

Bot de notificaciones de directos para Discord: vigila canales de **Twitch**, **YouTube** y **Kick** y avisa al instante en tu servidor, con embeds personalizables, pings por rol y roles automáticos de "en directo".

Hecho a medida para el Gremio Estelar, con cariño. 🎬

## ✨ Qué lo hace "superior" a Streamcord

- **3 plataformas** (Streamcord solo cubre Twitch/YouTube): incluye **Kick**, sin API oficial, vía endpoint público comunitario.
- **Roles automáticos live/offline**: asigna un rol mientras el streamer está en directo y lo quita al terminar (con overrides por streamer).
- **Embeds personalizados por streamer**: color, mensaje personalizado, miniatura y avatar de la plataforma.
- **Pings por rol configurable** por streamer (o sin ping si prefieres silencio).
- **Panel de configuración 100% por comandos slash**: sin editar archivos.
- **Aviso marcado como "finalizado"** al terminar el directo (el mensaje queda de archivo).
- **Panel web de gestión** con historial de directos (duración y pico de espectadores), sin tocar Discord ni archivos.
- **Sin dependencias nativas**: corre en Windows, VPS o Raspberry Pi, con un único archivo JSON como base de datos.
- **Sin API key para YouTube** (usa el feed RSS oficial) y **sin API key para Kick**.

## 🧩 Cómo funciona

Un monitor comprueba cada `POLL_INTERVAL_SECONDS` (60 s por defecto) el estado de cada streamer:

| Plataforma | Método | API key |
|---|---|---|
| Twitch | API Helix oficial (client credentials) | Sí, gratis |
| YouTube | Feed RSS oficial + página del vídeo para el estado live | No |
| Kick | Endpoint público `kick.com/api/v2/channels/{slug}` | No |

Detecta la transición **apagado → en directo** (envía el aviso + asigna rol) y **en directo → apagado** (quita el rol y marca el mensaje como finalizado). Para evitar falsos "se acabó" por fallos de API, exige **2 comprobaciones consecutivas** sin directo. Si el bot estaba apagado cuando empezó un directo, avisa en cuanto arranca. Los datos (streamers, estado) se guardan en `data/store.json` y sobreviven a reinicios.

## 📋 Requisitos

- **Node.js 18.17+** (o Docker)
- Una **aplicación de Discord** con el token del bot
- Opcional (solo para Twitch): una **app de Twitch** con Client ID y Secret

## 🚀 Puesta en marcha

### 1. Crear el bot de Discord

1. Ve a [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → ponle nombre (ej. "Gremio Estelar") → **Create**.
2. Pestaña **Bot** → **Reset Token** → copia el token.
3. En la misma pestaña, activa el intent privilegiado **SERVER MEMBERS INTENT** (necesario para asignar/quitar roles).
4. Instala las dependencias y arranca una vez para obtener el enlace de invitación (o calcúlalo tú):
   ```bash
   npm install
   cp .env.example .env   # pega tu DISCORD_TOKEN aquí
   npm run dev
   ```
   El log te mostrará el enlace de invitación con los permisos correctos (ver canal, enviar mensajes, gestionar mensajes, embeds, historial, **gestionar roles**, **mencionar roles**). Ábrelo e invita al bot a tu servidor.

> 💡 Los **pings por rol** requieren que el bot tenga el permiso *Mention Everyone* (ya incluido en el enlace) **o** que el rol tenga activado "Permitir a cualquiera mencionar este rol".

### 2. Configurar Twitch (solo si vas a vigilar canales de Twitch)

1. Ve a [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application** (tipo "Other").
2. Copia el **Client ID** y genera un **Client Secret** → pégalos en `.env`:
   ```
   TWITCH_CLIENT_ID=tu_client_id
   TWITCH_CLIENT_SECRET=tu_client_secret
   ```

### 3. Primeros pasos en Discord

| Comando | Qué hace |
|---|---|
| `/config canal #canal` | Elige dónde se publican los avisos |
| `/config rol-live @Rol` | Rol que se asigna al estar en directo |
| `/config rol-offline @Rol` | Rol que se asigna al terminar (opcional) |
| `/anadir canal:https://twitch.tv/midirecto anuncios:#canal-propio usuario:@yo rol:@fans` | Vigila un streamer con embed a medida (la plataforma se detecta sola con la URL; `anuncios` fija un canal propio para ese streamer) |
| `/lista` | Streamers vigilados y quién está en directo |
| `/quitar` | Deja de vigilar: escribe el comando y **elige el streamer de la lista** |
| `/comprobar` | Fuerza una comprobación inmediata |
| `/estado` | Salud del bot y de las plataformas |
| `/ms` (o `/panel`) | **Abre el panel de gestión**: desde ahí se hace todo (streamers, canales de aviso, roles, historial) |
| `/ayuda` | Guía rápida |

> 🛠 **Filosofía de uso**: la configuración diaria se hace **desde el panel web** (botón de `/ms`), no con comandos. Los comandos quedan como atajo/fallback.

Ejemplos de `/anadir`:

```
/anadir canal:https://twitch.tv/shroud
/anadir canal:https://www.youtube.com/@elrubius
/anadir canal:https://kick.com/xqc rol:@Streamers usuario:@xqc-fan
/anadir canal:shroud plataforma:twitch   # sin URL, indicas la plataforma
```

Solo quienes tengan **Gestionar servidor** o **Administrador** pueden configurar.

## 🌐 Panel web de gestión

Además de los comandos de Discord, el bot incluye un **panel web** para gestionar streamers, ver quién está en directo y consultar el **historial de directos** (fechas, duración y pico de espectadores).

### Activar

1. Pon una contraseña en `.env` y reinicia el bot:

   ```
   WEB_PANEL_PASSWORD=una_contrasena_segura
   WEB_PANEL_PORT=3000          # puerto donde escucha
   WEB_PANEL_HOST=127.0.0.1     # 0.0.0.0 para acceder desde fuera (VPS)
   WEB_PANEL_URL=http://192.168.1.10:3000   # dirección pública que abre el botón de /ms
   ```

2. Abre `http://127.0.0.1:3000` en el navegador (o la IP del VPS) e inicia sesión con esa contraseña.

### Qué puedes hacer

- **Streamers**: añadir/editar/eliminar desde el navegador, con **"Añadir varios"** (pega una lista de URLs, una por línea) y estado en vivo en tiempo real.
- **Historial**: cada directo queda registrado con inicio, fin, duración y pico de espectadores (últimos 1000 directos).
- **Ajustes**: canal de avisos global y roles sin escribir comandos. Cada streamer puede tener su **propio canal de anuncios** (se elige al añadirlo o editarlo).

> 🔒 El panel usa una cookie firmada y solo se activa si defines `WEB_PANEL_PASSWORD`. Si lo expones a Internet, actívalo detrás de un proxy con HTTPS o úsalo solo en tu red local.

## 🏃 Ejecutar 24/7

**En local / VPS (Node):**

```bash
npm run build
npm start
```

**Con PM2** (gestión de procesos, reinicio automático):

```bash
npm i -g pm2
pm2 start dist/index.js --name gremio-bot
pm2 save && pm2 startup
```

**Con Docker** (funciona igual en VPS, NAS o Raspberry Pi):

```bash
npm run build   # solo la primera vez
docker compose up -d --build
```

Los datos viven en `./data/store.json` (volumen en Docker): haz copias de seguridad de ese archivo y lo tienes todo.

**Con systemd** (VPS Linux):

```ini
# /etc/systemd/system/gremio-bot.service
[Unit]
Description=Gremio Estelar bot
After=network.target

[Service]
WorkingDirectory=/ruta/al/proyecto
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/ruta/al/proyecto/.env

[Install]
WantedBy=multi-user.target
```

## 🛠 Solución de problemas

- **No asigna/quita roles** → el intent *SERVER MEMBERS INTENT* debe estar activado, el bot necesita *Gestionar roles*, y su rol debe estar **por encima** del rol que asigna en la jerarquía del servidor.
- **Los pings no avisan** → permiso *Mention Everyone* en el bot o rol marcado como mencionable.
- **Kick da "sin respuesta"** → el endpoint público no está documentado; si Kick lo bloquea, el bot simplemente se salta esa comprobación sin romperse. Puedes bajar la frecuencia con `POLL_INTERVAL_SECONDS`.
- **YouTube: no detecta un estreno programado con más de 6 h de antelación** → por diseño evitamos martillear las páginas de vídeo; los directos normales (que es lo habitual) se detectan al instante.
- **Rate limit de Discord** → el bot ya respeta los límites; los avisos son poco frecuentes, no debería pasarte.
- **Errores en logs con `⚠️`** → suelen ser fallos puntuales de API; el monitor lo reintenta en la siguiente comprobación.

## 🗂 Estructura

```
src/
├── index.ts              # arranque: cliente, registro de comandos, monitor
├── commands.ts           # comandos slash y su lógica
├── monitor.ts            # bucle de comprobación y máquina de estados
├── notifications.ts      # embeds y envío/edición de avisos
├── roles.ts              # gestión de roles live/offline
├── store.ts              # persistencia JSON atómica (+ historial)
├── web/
│   ├── server.ts          # panel web: HTTP + auth por contraseña
│   ├── api.ts             # API REST del panel
│   └── index.html, style.css, app.js  # interfaz del panel
├── platforms/
│   ├── twitch.ts         # API Helix con token de cliente
│   ├── youtube.ts        # RSS + estado live del vídeo
│   └── kick.ts           # endpoint público de Kick
└── selftest.ts           # npm run selftest: valida las plataformas sin el bot
```

---

Hecho con 💜 para el Gremio Estelar.