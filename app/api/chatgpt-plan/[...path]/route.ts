import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const COOKIE_NAME = "ai_phone_chatgpt_plan";
const ALLOWED_PATHS = new Set(["models", "responses", "refresh-test"]);
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const authAttempts = new Map<string, { count: number; resetAt: number }>();

function serverConfig() {
  const url = String(process.env.CHATGPT_PLAN_SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(process.env.CHATGPT_PLAN_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const gateSecret = String(process.env.CHATGPT_PLAN_GATE_SECRET || "").trim();
  return url && serviceKey && gateSecret ? { url, serviceKey, gateSecret } : null;
}

function cookieValue(secret: string): string {
  return createHmac("sha256", secret).update("ai-phone-chatgpt-plan:v1").digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthenticated(request: NextRequest, secret: string): boolean {
  return safeEqual(request.cookies.get(COOKIE_NAME)?.value || "", cookieValue(secret));
}

function routePath(request: NextRequest): string {
  return request.nextUrl.pathname.split("/api/chatgpt-plan/")[1]?.replace(/^\/+|\/+$/g, "") || "";
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-nf-client-connection-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function canAttemptAuth(request: NextRequest): boolean {
  const key = clientIp(request);
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= AUTH_MAX_ATTEMPTS;
}

function setAuthCookie(response: NextResponse, secret: string, maxAge: number) {
  response.cookies.set(COOKIE_NAME, maxAge > 0 ? cookieValue(secret) : "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/chatgpt-plan",
    maxAge,
  });
}

async function handleAuth(request: NextRequest): Promise<NextResponse> {
  const config = serverConfig();
  if (!config) {
    return NextResponse.json({ ok: false, configured: false, error: "ChatGPT 账号网关尚未配置。" }, { status: 503 });
  }
  if (request.method === "GET") {
    return NextResponse.json({ ok: true, configured: true, authenticated: isAuthenticated(request, config.gateSecret) });
  }
  if (request.method === "DELETE") {
    const response = NextResponse.json({ ok: true, authenticated: false });
    setAuthCookie(response, config.gateSecret, 0);
    return response;
  }
  if (!canAttemptAuth(request)) {
    return NextResponse.json({ ok: false, error: "尝试次数过多，请 15 分钟后再试。" }, { status: 429 });
  }
  const body = await request.json().catch(() => ({})) as { secret?: unknown };
  const supplied = typeof body.secret === "string" ? body.secret : "";
  if (!safeEqual(supplied, config.gateSecret)) {
    return NextResponse.json({ ok: false, error: "访问口令不正确。" }, { status: 401 });
  }
  authAttempts.delete(clientIp(request));
  const response = NextResponse.json({ ok: true, authenticated: true });
  setAuthCookie(response, config.gateSecret, 30 * 24 * 60 * 60);
  return response;
}

async function proxy(request: NextRequest): Promise<Response> {
  const path = routePath(request);
  if (path === "auth") return handleAuth(request);
  if (!ALLOWED_PATHS.has(path)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const config = serverConfig();
  if (!config) return NextResponse.json({ error: "ChatGPT 账号网关尚未配置。" }, { status: 503 });
  if (!isAuthenticated(request, config.gateSecret)) {
    return NextResponse.json({ error: "请先在 API 设置中输入访问口令解锁 ChatGPT 账号渠道。" }, { status: 401 });
  }

  try {
    const upstream = await fetch(`${config.url}/functions/v1/chatgpt-plan/${path}`, {
      method: request.method,
      headers: {
        "Content-Type": request.headers.get("content-type") || "application/json",
        "x-ai-phone-service-key": config.serviceKey,
      },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Netlify 无法连接 Supabase，请稍后重试。" }, { status: 502 });
  }
}

export async function GET(request: NextRequest) { return proxy(request); }
export async function POST(request: NextRequest) { return proxy(request); }
export async function DELETE(request: NextRequest) { return proxy(request); }

