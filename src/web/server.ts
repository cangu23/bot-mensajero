import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { env } from "../env.js";
import { log } from "../logger.js";
import type { Monitor } from "../monitor.js";
import type { Store } from "../store.js";
import { handleApi } from "./api.js";

const STATIC_DIR = join(fileURLToPath(new URL("../../web", import.meta.url)));
const STATIC_FILES = new Set(["index.html", "style.css", "app.js", "favicon.svg"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = "gremio_panel";
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 60_000;

// ── Rate limiter (ventana deslizante por IP) ───────────────────────────────

/** Número máximo de peticiones por ventana (1 minuto) según estado de autenticación */
const RATE_LIMIT_AUTHED = 120;
const RATE_LIMIT_ANON = 30;
const RATE_WINDOW_MS = 60_000;

class RateLimiter {
  /** IP → timestamps de las peticiones en la ventana actual */
  private readonly windows = new Map<string, number[]>();

  /**
   * @returns true si la petición está permitida, false si supera el límite.
   */
  allow(ip: string, limit: number): boolean {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    let timestamps = this.windows.get(ip) ?? [];
    // Podar timestamps fuera de la ventana
    timestamps = timestamps.filter((t) => t > cutoff);
    if (timestamps.length >= limit) {
      this.windows.set(ip, timestamps);
      return false;
    }
    timestamps.push(now);
    this.windows.set(ip, timestamps);
    return true;
  }

  /** Limpia IPs con ventana vacía (previene memory leak en bots que escanean). */
  prune(): void {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [ip, ts] of this.windows) {
      if (ts.every((t) => t <= cutoff)) this.windows.delete(ip);
    }
  }
}

let server: ReturnType<typeof createServer> | null = null;
const rateLimiter = new RateLimiter();
// Limpieza periódica para no acumular IPs inactivas
setInterval(() => rateLimiter.prune(), 5 * 60_000).unref();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function makeToken(key: Buffer): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(key: Buffer, token: string | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", key).update(payload).digest();
  let ok = false;
  try {
    const given = Buffer.from(sig, "base64url");
    ok = given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    ok = false;
  }
  if (!ok) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Cuerpo demasiado grande");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function serveStatic(res: ServerResponse, pathname: string): void {
  let name = pathname === "/" ? "index.html" : pathname.slice(1);
  try {
    name = decodeURIComponent(name);
  } catch {
    sendJson(res, 400, { error: "URL inválida" });
    return;
  }
  if (!STATIC_FILES.has(name)) {
    sendJson(res, 404, { error: "No encontrado" });
    return;
  }
  try {
    const file = readFileSync(join(STATIC_DIR, name));
    const ext = name.slice(name.lastIndexOf(".")) || ".html";
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "No encontrado" });
  }
}

export function startWebServer(client: Client, store: Store, monitor: Monitor): void {
  if (!env.WEB_PANEL_PASSWORD) {
    log("ℹ️ Panel web desactivado: define WEB_PANEL_PASSWORD en .env para activarlo");
    return;
  }
  const key = createHmac("sha256", "gremio-estelar-panel-salt").update(env.WEB_PANEL_PASSWORD).digest();
  const expectedPw = createHmac("sha256", "gremio-estelar-pw-check").update(env.WEB_PANEL_PASSWORD).digest();
  const loginFails = new Map<string, { count: number; until: number }>();

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = (req.method ?? "GET").toUpperCase();
    const cookies = parseCookies(req);
    const authed = verifyToken(key, cookies[COOKIE_NAME]);

    // ── Autenticación ───────────────────────────────────────
    if (url.pathname === "/api/auth/status" && method === "GET") {
      sendJson(res, 200, { authenticated: authed });
      return;
    }
    if (url.pathname === "/api/login" && method === "POST") {
      const ip = req.socket.remoteAddress ?? "?";
      const fails = loginFails.get(ip);
      if (fails && fails.until > Date.now()) {
        sendJson(res, 429, { error: "Demasiados intentos. Espera un minuto." });
        return;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "Cuerpo inválido" });
        return;
      }
      const password = (body as { password?: unknown })?.password;
      const given = createHmac("sha256", "gremio-estelar-pw-check").update(String(password ?? "")).digest();
      if (given.length === expectedPw.length && timingSafeEqual(given, expectedPw)) {
        loginFails.delete(ip);
        const token = makeToken(key);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const entry = loginFails.get(ip) ?? { count: 0, until: 0 };
      entry.count++;
      if (entry.count >= LOGIN_MAX_FAILS) {
        entry.until = Date.now() + LOGIN_LOCK_MS;
        entry.count = 0;
        log(`⚠️ Panel: ${LOGIN_MAX_FAILS} intentos fallidos desde ${ip}, bloqueo ${LOGIN_LOCK_MS / 1000}s`);
      }
      loginFails.set(ip, entry);
      sendJson(res, 401, { error: "Contraseña incorrecta" });
      return;
    }
    if (url.pathname === "/api/logout" && method === "POST") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── API (requiere sesión) ───────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      if (!authed) {
        // Rate limiting para peticiones anónimas (protege contra escaneos)
        const ip = req.socket.remoteAddress ?? "?";
        if (!rateLimiter.allow(ip, RATE_LIMIT_ANON)) {
          sendJson(res, 429, { error: "Demasiadas peticiones. Espera un momento." });
          return;
        }
        sendJson(res, 401, { error: "No autenticado" });
        return;
      }
      // Rate limiting para usuarios autenticados (excluye login que tiene su propio límite)
      if (url.pathname !== "/api/login") {
        const ip = req.socket.remoteAddress ?? "?";
        if (!rateLimiter.allow(ip, RATE_LIMIT_AUTHED)) {
          sendJson(res, 429, { error: "Demasiadas peticiones. Espera un momento." });
          return;
        }
      }
      let body: unknown = null;
      if (method === "POST" || method === "PUT" || method === "DELETE") {
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : null;
        } catch {
          sendJson(res, 400, { error: "Cuerpo inválido" });
          return;
        }
      }
      await handleApi({
        url,
        method,
        body,
        client,
        store,
        monitor,
        sendJson: (status, data) => sendJson(res, status, data),
      });
      return;
    }

    // ── Estáticos ───────────────────────────────────────────
    if (method === "GET") {
      serveStatic(res, url.pathname);
      return;
    }
    sendJson(res, 405, { error: "Método no permitido" });
  });

  server.on("error", (e) => log("⚠️ Panel web:", e.message));
  server.listen(env.WEB_PANEL_PORT, env.WEB_PANEL_HOST, () => {
    log(`🌐 Panel web en http://${env.WEB_PANEL_HOST}:${env.WEB_PANEL_PORT} (usa WEB_PANEL_PASSWORD para entrar)`);
    if (env.WEB_PANEL_URL) log(`🔗 El botón de /ms apuntará a: ${env.WEB_PANEL_URL}`);
    else log(`ℹ️ Define WEB_PANEL_URL en .env para que /ms apunte a tu dirección pública (ahora usa localhost)`);
  });
}

export function stopWebServer(): void {
  if (server) {
    server.closeAllConnections?.(); // evita sockets keep-alive colgados en el cierre
    server.close();
    server = null;
  }
}