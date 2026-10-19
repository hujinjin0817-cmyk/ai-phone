// AI Phone · ChatGPT account gateway
// Deploy with JWT verification disabled. Every request is still authenticated by
// the owner's existing personal Supabase service_role key. ChatGPT credentials
// never leave Supabase Vault and are never written to logs.

type Credential = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  scope?: string;
  token_type?: string;
};

const OPENAI_API = "https://api.openai.com/v1";
const OPENAI_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const REFRESH_EARLY_SECONDS = 5 * 60;
const VERIFIED_KEY_TTL_MS = 5 * 60 * 1000;
const verifiedKeyFingerprints = new Map<string, number>();
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-ai-phone-service-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0);
  return difference === 0;
}

async function keyFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Supabase secret keys (sb_secret_...) replace legacy service_role JWTs but do
 * not equal the Edge runtime's SUPABASE_SERVICE_ROLE_KEY string. Validate a
 * supplied backend key against this project's Admin API instead of rejecting
 * valid new-format keys. Only the irreversible fingerprint is cached.
 */
async function hasProjectAdminAccess(projectUrl: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const fingerprint = await keyFingerprint(candidate);
  const cachedUntil = verifiedKeyFingerprints.get(fingerprint) || 0;
  if (cachedUntil > Date.now()) return true;

  const response = await fetch(`${projectUrl}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: { apikey: candidate, Authorization: `Bearer ${candidate}` },
  }).catch(() => null);
  const allowed = response?.ok === true;
  await response?.body?.cancel().catch(() => undefined);
  if (allowed) verifiedKeyFingerprints.set(fingerprint, Date.now() + VERIFIED_KEY_TTL_MS);
  return allowed;
}

function serviceHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}

async function rpc<T>(name: string, body: Record<string, unknown>, projectUrl: string, serviceKey: string): Promise<T> {
  const response = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceHeaders(serviceKey),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Supabase credential store failed (${response.status})`);
  return await response.json() as T;
}

function validCredential(value: unknown): value is Credential {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return typeof item.access_token === "string"
    && typeof item.refresh_token === "string"
    && typeof item.client_id === "string"
    && typeof item.expires_at === "number";
}

async function readCredential(projectUrl: string, serviceKey: string): Promise<Credential> {
  const value = await rpc<unknown>("ai_phone_get_chatgpt_credential", {}, projectUrl, serviceKey);
  if (!validCredential(value)) throw new Error("ChatGPT account is not connected");
  return value;
}

async function refreshCredential(current: Credential, projectUrl: string, serviceKey: string): Promise<Credential> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: current.client_id,
      refresh_token: current.refresh_token,
      resource: "https://api.openai.com/v1",
    }),
  });
  if (!response.ok) {
    // Rotating refresh tokens are single-use. A concurrent invocation may have
    // refreshed first; briefly wait for its optimistic Vault write and adopt it.
    for (const delay of [100, 250, 500]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      const winner = await readCredential(projectUrl, serviceKey);
      if (winner.refresh_token !== current.refresh_token) return winner;
    }
    throw new Error(`ChatGPT session refresh failed (${response.status})`);
  }
  const token = await response.json() as Record<string, unknown>;
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
    throw new Error("ChatGPT refresh response is incomplete");
  }
  const replacement: Credential = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(60, Number(token.expires_in) || 3600),
    client_id: current.client_id,
    scope: typeof token.scope === "string" ? token.scope : current.scope,
    token_type: typeof token.token_type === "string" ? token.token_type : current.token_type,
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !["access_token", "refresh_token", "expires_at", "scope", "token_type"].includes(key))),
  };
  const saved = await rpc<boolean>("ai_phone_set_chatgpt_credential", {
    p_credential: replacement,
    p_expected_refresh_token: current.refresh_token,
  }, projectUrl, serviceKey);
  // Another invocation may have won the rotating-token race. Always use its
  // freshly stored value instead of retrying the already consumed token.
  return saved ? replacement : await readCredential(projectUrl, serviceKey);
}

async function usableCredential(projectUrl: string, serviceKey: string): Promise<Credential> {
  const current = await readCredential(projectUrl, serviceKey);
  if (current.expires_at > Math.floor(Date.now() / 1000) + REFRESH_EARLY_SECONDS) return current;
  return await refreshCredential(current, projectUrl, serviceKey);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value.map(part => {
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function buildResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions: string[] = [];
  const input: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const raw of messages) {
    const message = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const text = contentText(message.content);
    if (!text) continue;
    if (message.role === "system" || message.role === "developer") instructions.push(text);
    else input.push({ role: message.role === "assistant" ? "assistant" : "user", content: text });
  }
  if (input.length === 0) throw new Error("At least one user message is required");
  return {
    model: String(body.model || ""),
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    ...(Number.isFinite(Number(body.max_tokens)) ? { max_output_tokens: Number(body.max_tokens) } : {}),
    store: false,
    stream: true,
  };
}

function chatChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

function transformResponsesStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const dataLine = event.split("\n").find(line => line.startsWith("data:"));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
            controller.enqueue(encoder.encode(chatChunk(data.delta)));
          } else if (data.type === "response.completed") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
          } else if (data.type === "error" || data.type === "response.failed") {
            controller.error(new Error("OpenAI response stream failed"));
          }
        } catch {
          // Ignore non-JSON keepalive events.
        }
      }
    },
    flush(controller) {
      if (buffer.includes("response.completed")) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  }));
}

async function collectResponseText(upstream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find(item => item.startsWith("data:"));
      if (!line) continue;
      try {
        const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (data.type === "response.output_text.delta" && typeof data.delta === "string") output += data.delta;
      } catch { /* keepalive */ }
    }
  }
  return output;
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const projectUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const suppliedKey = request.headers.get("x-ai-phone-service-key") || "";
  const authorized = Boolean(serviceKey && projectUrl && suppliedKey)
    && (safeEqual(serviceKey, suppliedKey) || await hasProjectAdminAccess(projectUrl, suppliedKey));
  if (!authorized) return json({ error: "Unauthorized" }, 401);

  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/refresh-test")) {
      const refreshed = await refreshCredential(await readCredential(projectUrl, serviceKey), projectUrl, serviceKey);
      return json({ ok: true, expires_at: refreshed.expires_at });
    }
    const credential = await usableCredential(projectUrl, serviceKey);
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      const upstream = await fetch(`${OPENAI_API}/models`, {
        headers: { Authorization: `Bearer ${credential.access_token}` },
      });
      if (!upstream.ok) return json({ error: `OpenAI model list failed (${upstream.status})` }, upstream.status);
      const data = await upstream.json() as { models?: unknown[] };
      return json({ models: Array.isArray(data.models) ? data.models : [] });
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return json({ error: "Not found" }, 404);
    const body = await request.json() as Record<string, unknown>;
    const stream = body.stream === true;
    const upstream = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildResponsesBody(body)),
    });
    if (!upstream.ok || !upstream.body) return json({ error: `OpenAI response failed (${upstream.status})` }, upstream.status || 502);
    if (!stream) {
      const content = await collectResponseText(upstream.body);
      return json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    }
    return new Response(transformResponsesStream(upstream.body), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ChatGPT account request failed";
    return json({ error: message }, message.includes("not connected") ? 409 : 502);
  }
});
