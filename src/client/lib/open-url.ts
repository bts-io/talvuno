/** The in-app path a worker "open-url" message asks for. Same-origin only, anything else is ignored. */
export function openUrlFromMessage(data: unknown, origin: string): string | null {
  if (!data || typeof data !== "object") return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== "open-url" || typeof url !== "string") return null;
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null;
  } catch {
    return null;
  }
}
