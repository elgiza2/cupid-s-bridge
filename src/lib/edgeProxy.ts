/** @doc Routes Supabase edge-function calls through our own origin on hosts the
 *  functions do not allow via CORS (Vercel, megsyai.com, any custom domain).
 *
 *  Why a fetch interceptor and not per-call URLs: edge functions are called from
 *  ~60 places, some through `supabase.functions.invoke()`, which builds its own
 *  URL. Patching `window.fetch` once fixes every caller — including streaming
 *  chat — without touching call sites.
 *
 *  Local dev and *.lovable.app keep talking to Supabase directly (allowlisted),
 *  so nothing changes in the environments that already worked. If the proxy is
 *  unavailable on a static host, the original request is retried directly.
 */

const FUNCTIONS_PATH = "/functions/v1/";
const PROXY_PREFIX = "/api/public/edge/";

/** True when the current page origin is accepted by the edge functions' CORS. */
function originIsAllowlisted(): boolean {
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".lovable.app") ||
    host.endsWith(".supabase.co")
  );
}

function parseFunctionUrl(rawUrl: string): { base: string; rest: string } | null {
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (!url.hostname.endsWith(".supabase.co")) return null;
    const index = url.pathname.indexOf(FUNCTIONS_PATH);
    if (index !== 0) return null;
    const fn = url.pathname.slice(FUNCTIONS_PATH.length);
    if (!fn) return null;
    return { base: url.origin, rest: `${fn}${url.search}` };
  } catch {
    return null;
  }
}

export function installEdgeFunctionProxy(): void {
  if (typeof window === "undefined") return;
  if ((window as { __edgeProxyInstalled?: boolean }).__edgeProxyInstalled) return;
  if (originIsAllowlisted()) return;
  (window as { __edgeProxyInstalled?: boolean }).__edgeProxyInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    const match = rawUrl ? parseFunctionUrl(rawUrl) : null;
    if (!match) return originalFetch(input as RequestInfo, init);

    const proxiedUrl = `${PROXY_PREFIX}${match.rest}`;

    try {
      const request =
        typeof input === "string" || input instanceof URL
          ? new Request(proxiedUrl, init)
          : new Request(proxiedUrl, input as Request);
      const headers = new Headers(request.headers);
      headers.set("x-edge-base", match.base);

      const response = await originalFetch(
        new Request(proxiedUrl, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          // Streaming a request body requires half duplex.
          ...({ duplex: "half" } as Record<string, unknown>),
        }),
      );

      // A static host without a server runtime answers with its HTML fallback;
      // in that case fall back to the direct call rather than failing.
      const isHtml = (response.headers.get("content-type") || "").includes("text/html");
      if (response.status === 404 || isHtml) {
        return originalFetch(input as RequestInfo, init);
      }
      return response;
    } catch {
      return originalFetch(input as RequestInfo, init);
    }
  };
}

export default installEdgeFunctionProxy;
