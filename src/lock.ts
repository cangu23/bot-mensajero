/**
 * Lock de proceso para detectar instancias duplicadas del bot.
 * Escribe un archivo con el PID actual; al arrancar comprueba si hay
 * otro proceso vivo con el PID guardado y emite un warning si es así.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

export class ProcessLock {
  private readonly path: string;
  private acquired = false;

  constructor(dataDir: string) {
    this.path = `${dataDir.replace(/[/\\]?[^/\\]+$/, "")}/data/bot.lock`;
    // Si dataDir es un archivo (store.db), tomamos su directorio
    if (dataDir.includes(".")) {
      this.path = `${dirname(dataDir)}/bot.lock`;
    } else {
      this.path = `${dataDir}/bot.lock`;
    }
  }

  /**
   * Intenta adquirir el lock.
   * @returns `true` si no había otro proceso vivo, `false` si había uno (warning emitido).
   */
  acquire(): boolean {
    let clean = true;

    if (existsSync(this.path)) {
      try {
        const raw = readFileSync(this.path, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          // Comprobamos si el proceso con ese PID sigue vivo
          let alive = false;
          try {
            process.kill(pid, 0); // señal 0 = solo comprobar existencia
            alive = true;
          } catch {
            alive = false;
          }
          if (alive) {
            log(`⚠️ Lock: otro proceso del bot está vivo (PID ${pid}). Puede haber notificaciones duplicadas.`);
            clean = false;
          } else {
            log(`ℹ️ Lock: proceso anterior (PID ${pid}) ya terminó. Limpiando lock.`);
          }
        }
      } catch {
        // Archivo corrupto → ignoramos
      }
    }

    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, String(process.pid), "utf8");
      this.acquired = true;
    } catch (e) {
      log(`⚠️ Lock: no pude escribir el lock file: ${e instanceof Error ? e.message : String(e)}`);
    }

    return clean;
  }

  /** Libera el lock al apagar. */
  release(): void {
    if (!this.acquired) return;
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, "utf8").trim();
        // Solo borramos si el PID es el nuestro (no el de un proceso sucesor)
        if (raw === String(process.pid)) {
          unlinkSync(this.path);
        }
      }
    } catch {
      // Ignoramos errores al liberar
    }
  }
}
