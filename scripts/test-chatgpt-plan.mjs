#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../supabase/functions/chatgpt-plan/index.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

let handler;
let refreshCalls = 0;
let vaultWrites = 0;
let credential = {
  access_token: "access-before",
  refresh_token: "refresh-before",
  client_id: "oaiapp_test",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: "offline_access resource.invoke chatgpt.tokens.use.direct",
};

const responseEvents = [
  { type: "response.output_text.delta", delta: "你" },
  { type: "response.output_text.delta", delta: "好" },
  { type: "response.completed" },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");

async function mockFetch(url, init = {}) {
  const target = String(url);
  if (target.endsWith("/auth/v1/admin/users?page=1&per_page=1")) {
    const candidate = init.headers?.apikey;
    return candidate === "sb_secret_test" ? Response.json({ users: [] }) : Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  if (target.endsWith("/rest/v1/rpc/ai_phone_get_chatgpt_credential")) return Response.json(credential);
  if (target.endsWith("/rest/v1/rpc/ai_phone_set_chatgpt_credential")) {
    const body = JSON.parse(String(init.body));
    assert.equal(body.p_expected_refresh_token, credential.refresh_token);
    credential = body.p_credential;
    vaultWrites += 1;
    return Response.json(true);
  }
  if (target === "https://auth.openai.com/api/accounts/oauth/token") {
    refreshCalls += 1;
    return Response.json({ access_token: "access-after", refresh_token: "refresh-after", expires_in: 3600, token_type: "Bearer" });
  }
  if (target === "https://api.openai.com/v1/models") {
    assert.equal(init.headers.Authorization, `Bearer ${credential.access_token}`);
    return Response.json({ models: [{ slug: "gpt-test", display_name: "GPT Test" }] });
  }
  if (target === "https://api.openai.com/v1/responses") {
    assert.equal(init.headers.Authorization, `Bearer ${credential.access_token}`);
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, "你是测试助手");
    assert.deepEqual(body.input, [{ role: "user", content: "问候" }]);
    return new Response(responseEvents, { headers: { "Content-Type": "text/event-stream" } });
  }
  throw new Error(`Unexpected fetch: ${target}`);
}

const context = vm.createContext({
  Deno: {
    env: { get: key => key === "SUPABASE_URL" ? "https://example.supabase.co" : key === "SUPABASE_SERVICE_ROLE_KEY" ? "service-test" : undefined },
    serve: callback => { handler = callback; },
  },
  fetch: mockFetch,
  Request,
  Response,
  Headers,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  ReadableStream,
  TransformStream,
  console,
  crypto,
  JSON,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  Set,
  Error,
});
new vm.Script(javascript, { filename: "chatgpt-plan/index.ts" }).runInContext(context);
assert.equal(typeof handler, "function");

const headers = { "x-ai-phone-service-key": "service-test", "Content-Type": "application/json" };
const modelResponse = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/models", { headers }));
assert.equal(modelResponse.status, 200);
assert.equal((await modelResponse.json()).models[0].slug, "gpt-test");

const secretKeyResponse = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/models", {
  headers: { "x-ai-phone-service-key": "sb_secret_test" },
}));
assert.equal(secretKeyResponse.status, 200);

const requestBody = { model: "gpt-test", messages: [{ role: "system", content: "你是测试助手" }, { role: "user", content: "问候" }] };
const streamResponse = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/responses", {
  method: "POST", headers, body: JSON.stringify({ ...requestBody, stream: true }),
}));
const streamText = await streamResponse.text();
assert.match(streamText, /你/);
assert.match(streamText, /好/);
assert.match(streamText, /\[DONE\]/);

// Offline replay uses the same saved endpoint/body but requests a non-streaming
// OpenAI-compatible envelope so push-generate can parse it unchanged.
const offlineResponse = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/responses", {
  method: "POST", headers, body: JSON.stringify({ ...requestBody, stream: false }),
}));
assert.equal((await offlineResponse.json()).choices[0].message.content, "你好");

const refreshResponse = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/refresh-test", { headers }));
assert.equal(refreshResponse.status, 200);
assert.equal(refreshCalls, 1);
assert.equal(vaultWrites, 1);
assert.equal(credential.refresh_token, "refresh-after");

const unauthorized = await handler(new Request("https://example.supabase.co/functions/v1/chatgpt-plan/models", {
  headers: { "x-ai-phone-service-key": "wrong" },
}));
assert.equal(unauthorized.status, 401);

console.log("[chatgpt-plan] 模型列表、流式聊天、Token 轮换、离线回复与鉴权测试通过。");
