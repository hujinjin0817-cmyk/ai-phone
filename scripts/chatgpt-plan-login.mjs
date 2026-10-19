#!/usr/bin/env node

// Official Sign in with ChatGPT loopback OAuth flow for AI Phone.
// The resulting credential is sent directly to the owner's Supabase Vault RPC.
// No token is printed or written to disk.

import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { randomBytes, createHash, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AUTH_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE = "https://api.openai.com/v1";
const INITIAL_CLIENT_ID = "dynamic_agent_client";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

const b64url = bytes => Buffer.from(bytes).toString("base64url");
const randomUrlSafe = size => b64url(randomBytes(size));
const sha256 = value => createHash("sha256").update(value).digest();

function stableHostId() {
  const file = join(homedir(), ".ai-phone", "chatgpt-host.json");
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved.ext_agent_host_id === "string" && saved.ext_agent_host_id.startsWith("urn:uuid:")) return saved.ext_agent_host_id;
  } catch { /* first run */ }
  const value = `urn:uuid:${webcrypto.randomUUID()}`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ ext_agent_host_id: value })}\n`, { mode: 0o600 });
  return value;
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function prompt(label, { hidden = false } = {}) {
  if (!hidden || !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(label, answer => { rl.close(); resolve(answer.trim()); }));
  }
  return new Promise(resolve => {
    process.stdout.write(label);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = chunk => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") process.exit(130);
        if (character === "\b" || character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function parseJwtPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function validateIdToken(idToken, clientId, nonce) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  const jwksResponse = await fetch(JWKS_URL);
  if (!jwksResponse.ok) throw new Error("Unable to load OpenAI signing keys");
  const jwks = await jwksResponse.json();
  const jwk = Array.isArray(jwks.keys) ? jwks.keys.find(key => key.kid === header.kid) : null;
  if (!jwk || header.alg !== "RS256") throw new Error("Unknown ID token signing key");
  const key = await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const validSignature = await webcrypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(parts[2], "base64url"),
    Buffer.from(`${parts[0]}.${parts[1]}`),
  );
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!validSignature || payload.iss !== "https://auth.openai.com" || !audiences.includes(clientId)
      || payload.nonce !== nonce || Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
    throw new Error("ID token validation failed");
  }
  return payload;
}

function waitForCallback(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out"));
    }, 10 * 60 * 1000);
    server.on("request", (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const clientId = url.searchParams.get("client_id") || INITIAL_CLIENT_ID;
      if (error || !code || state !== expectedState || !clientId.startsWith("oaiapp_")) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("登录失败，可以关闭此页面。 ");
        clearTimeout(timeout);
        server.close();
        reject(new Error(error || "OAuth callback validation failed"));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=utf-8><title>AI Phone</title><h2>ChatGPT 登录成功</h2><p>凭证正在安全写入 Supabase，可以关闭此页面。</p>");
      clearTimeout(timeout);
      server.close();
      resolve({ code, clientId });
    });
  });
}

async function main() {
  const supabaseUrl = (process.env.AI_PHONE_SUPABASE_URL || await prompt("Supabase Project URL: ")).replace(/\/$/, "");
  const serviceKey = process.env.AI_PHONE_SUPABASE_SERVICE_ROLE_KEY || await prompt("Supabase service_role key（输入不显示）: ", { hidden: true });
  if (!/^https:\/\/.+\.supabase\.co$/i.test(supabaseUrl) || !serviceKey) throw new Error("Supabase URL or service_role key is missing");

  const verifier = randomUrlSafe(64);
  const state = randomUrlSafe(32);
  const nonce = randomUrlSafe(32);
  const extAgentHostId = stableHostId();
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start loopback callback server");
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  const auth = new URL(AUTH_URL);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: INITIAL_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    code_challenge: b64url(sha256(verifier)),
    code_challenge_method: "S256",
    state,
    nonce,
    agent_name_hint: "AI Phone",
    ext_agent_host_id: extAgentHostId,
  }).toString();
  console.log("即将打开 ChatGPT 官方登录页；登录完成前请保持本窗口开启。");
  openBrowser(auth.toString());
  const callback = await waitForCallback(server, state);
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed (${tokenResponse.status})`);
  const token = await tokenResponse.json();
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" || typeof token.id_token !== "string") {
    throw new Error("Token response is incomplete");
  }
  const identity = await validateIdToken(token.id_token, callback.clientId, nonce);
  const granted = new Set(String(token.scope || "").split(/\s+/).filter(Boolean));
  for (const required of ["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]) {
    if (!granted.has(required)) throw new Error(`Required scope was not granted: ${required}`);
  }
  const credential = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(60, Number(token.expires_in) || 3600),
    client_id: callback.clientId,
    ext_agent_host_id: extAgentHostId,
    id_token: token.id_token,
    subject: identity.sub,
    email: typeof identity.email === "string" ? identity.email : undefined,
    scope: token.scope,
    token_type: token.token_type || "Bearer",
  };
  const upload = await fetch(`${supabaseUrl}/rest/v1/rpc/ai_phone_set_chatgpt_credential`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_credential: credential, p_expected_refresh_token: null }),
  });
  if (!upload.ok) throw new Error(`Secure Supabase upload failed (${upload.status}); run docs/chatgpt-plan-supabase.sql first`);
  console.log("完成：ChatGPT OAuth 凭证已直接写入 Supabase Vault，本地未保存 Token。");
}

main().catch(error => {
  console.error(`失败：${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
