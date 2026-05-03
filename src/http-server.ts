// ── HTTP server for orchestrator (food analysis, programmatic access) ──

import { SessionManager } from "./session";
import { Logger } from "./utils";
import type { ContentBlock } from "./types";

const PORT = parseInt(process.env.ORCHESTRATOR_HTTP_PORT ?? "7800", 10);
const AUTH_TOKEN = process.env.ORCHESTRATOR_HTTP_TOKEN ?? "";
const FOOD_SESSION_KEY = "food-analysis";
const MAX_PHOTOS = 5;
const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10MB

// Tina's PCOS-aware food prompt (mirrors the analyze-food edge function)
const TINA_FOOD_PROMPT = `You are a nutrition analyst for Tina, a Korean female in her mid-30s with PCOS (high androgen type).

Daily targets: 1,400-1,600 calories, 80-100g protein.

Analyze the food photo(s) and any user description provided. Pay close attention to:
- Real-world serving sizes (Korean & Japanese cuisines especially)
- User context like "I only had 3 pieces" or "shared with husband"
- Insulin impact, inflammation, hormonal effects relevant to PCOS

Be conservative when uncertain about portions. Lower your confidence score rather than guessing.

Return ONLY a JSON object (no markdown, no commentary), with this exact shape:
{
  "calories": <number>,
  "protein": <number, grams>,
  "carbs": <number, grams>,
  "fat": <number, grams>,
  "fiber": <number, grams>,
  "confidence": <0-1>,
  "pcos_notes": "<short 1-2 sentence note on PCOS impact>"
}`;

function checkAuth(req: Request): boolean {
  if (!AUTH_TOKEN) return true; // No token configured = open (dev mode)
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return match[1] === AUTH_TOKEN;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-user-jwt",
  };
}

async function fileToContentBlock(file: File): Promise<ContentBlock> {
  if (file.size > MAX_PHOTO_SIZE) {
    throw new Error(`Photo too large (${file.size} bytes, max ${MAX_PHOTO_SIZE})`);
  }
  const buf = await file.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  const mimeType = file.type || "image/jpeg";
  return {
    type: "image",
    source: { type: "base64", media_type: mimeType, data: base64 },
  };
}

function extractJson(text: string): unknown {
  // Try parsing directly first
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON from markdown code fences
    const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence) {
      try { return JSON.parse(fence[1]); } catch { /* fall through */ }
    }
    // Try finding first { ... last }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)); } catch { /* fall through */ }
    }
  }
  return null;
}

export function startHttpServer(sessionManager: SessionManager, logger: Logger): { stop: () => void } {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Health check (no auth)
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(
          { status: "ok", timestamp: new Date().toISOString() },
          { headers: corsHeaders() }
        );
      }

      // Auth required for everything else
      if (!checkAuth(req)) {
        logger.warn(`[http] Unauthorized request to ${url.pathname}`);
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders() },
        });
      }

      // Food analysis endpoint
      if (url.pathname === "/analyze-food" && req.method === "POST") {
        try {
          const formData = await req.formData();
          const photos: File[] = [];
          const description = (formData.get("description") as string | null) ?? "";

          // Collect all photo files (input name "photos" or "photos[]")
          for (const [key, value] of formData.entries()) {
            if ((key === "photos" || key === "photos[]") && value instanceof File) {
              photos.push(value);
            }
          }

          if (photos.length === 0) {
            return new Response(JSON.stringify({ error: "no photos provided" }), {
              status: 400,
              headers: { "content-type": "application/json", ...corsHeaders() },
            });
          }
          if (photos.length > MAX_PHOTOS) {
            return new Response(JSON.stringify({ error: `too many photos (max ${MAX_PHOTOS})` }), {
              status: 400,
              headers: { "content-type": "application/json", ...corsHeaders() },
            });
          }

          logger.info(`[http] /analyze-food: ${photos.length} photos, description=${description.slice(0, 60)}`);

          // Build content blocks
          const content: ContentBlock[] = [];
          for (const photo of photos) {
            content.push(await fileToContentBlock(photo));
          }
          const userText = description.trim()
            ? `${TINA_FOOD_PROMPT}\n\nUser description: ${description.trim()}`
            : TINA_FOOD_PROMPT;
          content.push({ type: "text", text: userText });

          // Run via dedicated food-analysis session
          const startedAt = Date.now();
          const responseText = await sessionManager.sendMessage(FOOD_SESSION_KEY, content);
          const durationMs = Date.now() - startedAt;

          logger.info(`[http] /analyze-food: response in ${durationMs}ms (${responseText.length} chars)`);

          const parsed = extractJson(responseText);
          if (!parsed) {
            logger.warn(`[http] /analyze-food: failed to parse JSON from response`);
            return new Response(
              JSON.stringify({ error: "failed to parse JSON from model response", raw: responseText }),
              { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } }
            );
          }

          return Response.json(
            { ...parsed as object, _provider: "orchestrator", _duration_ms: durationMs },
            { headers: corsHeaders() }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`[http] /analyze-food error: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "content-type": "application/json", ...corsHeaders() },
          });
        }
      }

      // 404
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", ...corsHeaders() },
      });
    },
  });

  logger.info(`[http] HTTP server listening on http://localhost:${PORT} (auth=${AUTH_TOKEN ? "enabled" : "disabled"})`);

  return {
    stop: () => {
      server.stop();
      logger.info(`[http] HTTP server stopped`);
    },
  };
}
