#!/usr/bin/env node

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const resultFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".chatgpt-plan-verify-result.json");
const saveResult = value => writeFileSync(resultFile, `${JSON.stringify(value)}\n`);

function prompt(label, hidden = false) {
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

async function checkedJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url.split("/").at(-1)} failed (${response.status}): ${String(data.error || "unknown error").slice(0, 160)}`);
  return data;
}

async function main() {
  saveResult({ status: "running" });
  const projectUrl = (process.env.AI_PHONE_SUPABASE_URL || await prompt("Supabase Project URL: ")).replace(/\/$/, "");
  const serviceKey = process.env.AI_PHONE_SUPABASE_SERVICE_ROLE_KEY || await prompt("Supabase service_role key（输入不显示）: ", true);
  if (!/^https:\/\/.+\.supabase\.co$/i.test(projectUrl) || !serviceKey) throw new Error("Supabase URL or service_role key is missing");
  const base = `${projectUrl}/functions/v1/chatgpt-plan`;
  const headers = { "x-ai-phone-service-key": serviceKey, "Content-Type": "application/json" };

  const modelData = await checkedJson(`${base}/models`, { headers, cache: "no-store" });
  const models = Array.isArray(modelData.models) ? modelData.models : [];
  const model = String(models[0]?.slug || "");
  if (!model) throw new Error("No ChatGPT plan model is available");
  console.log(`模型列表通过（${models.length} 个模型）。`);

  const requestBody = { model, messages: [{ role: "user", content: "Reply with exactly AI_PHONE_OK" }] };
  const streamResponse = await fetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify({ ...requestBody, stream: true }) });
  const streamText = await streamResponse.text();
  if (!streamResponse.ok || !streamText.includes("data: [DONE]")) throw new Error(`Streaming chat failed (${streamResponse.status})`);
  console.log("流式聊天通过。");

  await checkedJson(`${base}/refresh-test`, { headers, cache: "no-store" });
  console.log("Token 强制刷新通过。");

  const offline = await checkedJson(`${base}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...requestBody, stream: false }),
  });
  if (typeof offline.choices?.[0]?.message?.content !== "string" || !offline.choices[0].message.content) {
    throw new Error("Offline-compatible response was empty");
  }
  console.log("刷新后的离线回复重放通过。");
  saveResult({ status: "passed", modelCount: models.length, tests: ["models", "stream-chat", "refresh", "offline-replay"] });
  console.log("全部真实验证通过；结果文件不含凭证或回复正文。");
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "Unknown error";
  saveResult({ status: "failed", error: message });
  console.error(`验证失败：${message}`);
  process.exitCode = 1;
});

