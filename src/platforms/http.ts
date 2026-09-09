const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
}

export async function httpGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 12_000,
): Promise<HttpResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": DEFAULT_UA, Accept: "*/*", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function jsonGet<T>(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const r = await httpGet(url, { Accept: "application/json", ...headers });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    try {
      return { ok: true, status: r.status, data: JSON.parse(r.body) as T };
    } catch {
      return { ok: false, status: r.status, data: null };
    }
  } catch {
    return { ok: false, status: 0, data: null };
  }
}