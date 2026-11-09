const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 100;
export const EVENT_ID = /^[0-9a-fA-F-]{36}$/;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

export function normalizeApiUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function createApiSource(baseUrl, { metricsUrl = "" } = {}) {
  async function get(path, params = {}, base = baseUrl) {
    const url = new URL(base + path, location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(response.status, body.error ?? response.statusText);
      return body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === "AbortError") throw new ApiError(0, `${path} timed out`);
      throw new ApiError(0, `cannot reach the API (${error?.message ?? "network error"})`);
    } finally {
      clearTimeout(timer);
    }
  }

  const warnings = [];

  async function pages(path, params, limit) {
    const items = [];
    let next = null;
    do {
      let body;
      try {
        body = await get(path, { ...params, limit: Math.min(PAGE_SIZE, limit - items.length), next });
      } catch (error) {
        if (!items.length) throw error;
        warnings.push(`${path}: showing the first ${items.length} items only (${error.message})`);
        return items;
      }
      items.push(...(body.items ?? []));
      next = body.next;
    } while (next && items.length < limit);
    return items;
  }

  return {
    mode: "live",
    label: new URL(baseUrl).host,

    async health() {
      const started = performance.now();
      try {
        await get("/health");
        return { ok: true, latencyMs: performance.now() - started };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },

    async recent(limit) {
      const today = await pages("/transactions/recent", { day: utcDay(0) }, limit);
      if (today.length >= limit) return today;
      return today.concat(await pages("/transactions/recent", { day: utcDay(-1) }, limit - today.length));
    },

    flagged: (limit) => pages("/transactions/flagged", {}, limit),

    async transaction(eventId) {
      if (!EVENT_ID.test(eventId)) return null;
      try {
        return await get(`/transactions/${eventId}`);
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    takeWarnings: () => warnings.splice(0),

    metrics: async (hours) => (metricsUrl ? get(metricsUrl, { hours }, "") : null),
  };
}
