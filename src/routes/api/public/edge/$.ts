/** @doc Same-origin proxy for Supabase edge functions.
 *
 *  The deployed functions only send `Access-Control-Allow-Origin` for a small
 *  allowlist of origins (localhost and *.lovable.app). Any other host — the
 *  Vercel deployment, megsyai.com — got a preflight without that header, so the
 *  browser blocked the request and every feature failed with "Failed to fetch".
 *
 *  Forwarding through our own origin removes CORS from the picture entirely:
 *  the browser talks to the same host that served the page, and this handler
 *  makes the cross-host call server-side (where CORS does not apply).
 *  Streaming responses (chat) pass straight through.
 */
import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_BASE = "https://qdnqxjzjecaieuavagvq.supabase.co";

/** Only Supabase function hosts may be targeted, never an arbitrary URL. */
function resolveBase(request: Request): string {
  const requested = request.headers.get("x-edge-base");
  if (requested) {
    try {
      const url = new URL(requested);
      if (url.protocol === "https:" && url.hostname.endsWith(".supabase.co")) {
        return url.origin;
      }
    } catch {
      /* fall through to the default project */
    }
  }
  return DEFAULT_BASE;
}

const FORWARD_HEADERS = [
  "authorization",
  "apikey",
  "content-type",
  "accept",
  "x-client-info",
];

async function proxy(request: Request, splat: string | undefined): Promise<Response> {
  const fn = (splat ?? "").replace(/^\/+/, "");
  if (!fn) return new Response("Missing function name", { status: 400 });

  const incoming = new URL(request.url);
  const target = `${resolveBase(request)}/functions/v1/${fn}${incoming.search}`;

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, body });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `Upstream request failed: ${(error as Error).message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const outHeaders = new Headers();
  for (const name of ["content-type", "cache-control", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  outHeaders.set("x-edge-proxy", "1");

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export const Route = createFileRoute("/api/public/edge/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => proxy(request, (params as { _splat?: string })._splat),
      POST: async ({ request, params }) => proxy(request, (params as { _splat?: string })._splat),
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});
