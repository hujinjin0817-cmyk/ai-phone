#!/usr/bin/env node

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const resultFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".chatgpt-plan-verify-result.json");
const saveResult = value => writeFileSync(resultFile, `${JSON.stringify(value)}\n`);
let curlServiceKey = "";

function curlFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "60",
      "--variable", "%AI_PHONE_SERVICE_KEY",
      "--expand-header", "x-ai-phone-service-key: {{AI_PHONE_SERVICE_KEY}}",
      "--header", "Content-Type: application/json",
      "--request", String(init.method || "GET"),
      "--write-out", "\n__AI_PHONE_STATUS__:%{http_code}",
      url,
    ];
    if (typeof init.body === "string") args.splice(args.length - 1, 0, "--data-binary", "@-");
    const child = spawn("curl.exe", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AI_PHONE_SERVICE_KEY: curlServiceKey },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`curl transport failure (${code}): ${stderr.trim().slice(0, 120)}`));
      const marker = "\n__AI_PHONE_STATUS__:";
      const index = stdout.lastIndexOf(marker);
      if (index < 0) return reject(new Error(`curl transport failure: ${stderr.trim().slice(0, 120)}`));
      const body = stdout.slice(0, index);
      const status = Number(stdout.slice(index + marker.length).trim());
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return reject(new Error("curl returned an invalid HTTP status"));
      }
      resolve(new Response(body, { status }));
    });
    child.stdin.end(typeof init.body === "string" ? init.body : undefined);
  });
}

function prompt(label, hidden = false) {
  if (hidden && process.platform === "win32") {
    const script = [
      `$value = Read-Host '${label.replaceAll("'", "''")}' -AsSecureString`,
      "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)",
      "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
      windowsHide: false,
    });
    if (result.status !== 0) throw new Error("Secure credential input was cancelled");
    return Promise.resolve(result.stdout.trim());
  }
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

async function checkedFetch(url, init, stage) {
  let lastError;
  for (const delay of [0, 500, 1500]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return await curlFetch(url, init);
  } catch (error) {
    lastError = error;
  }
  const cause = lastError?.cause;
  const details = `${cause && typeof cause === "object" && "code" in cause ? String(cause.code) : ""} ${lastError?.message || ""}`.toLowerCase();
  const code = details.includes("resolve host") || details.includes("enotfound") ? "DNS"
    : details.includes("timed out") || details.includes("timeout") || details.includes("abort") ? "TIMEOUT"
      : details.includes("certificate") || details.includes("ssl") || details.includes("tls") ? "TLS"
        : details.includes("reset") ? "CONNECTION_RESET"
          : "NETWORK_ERROR";
  throw new Error(`${stage} network failure (${code})`);
}

function failAndExit(error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  try { saveResult({ status: "failed", error: message }); } catch {}
  console.error(`验证失败：${message}`);
  process.exitCode = 1;
}

process.on("uncaughtException", failAndExit);
process.on("unhandledRejection", failAndExit);

async function checkedJson(url, init, stage) {
  const response = await checkedFetch(url, init, stage);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url.split("/").at(-1)} failed (${response.status}): ${String(data.error || "unknown error").slice(0, 160)}`);
  return data;
}

async function main() {
  saveResult({ status: "running" });
  const projectUrl = (process.env.AI_PHONE_SUPABASE_URL || await prompt("Supabase Project URL: ")).replace(/\/$/, "");
  const serviceKey = process.env.AI_PHONE_SUPABASE_SERVICE_ROLE_KEY || await prompt("Supabase service_role key（输入不显示）: ", true);
  if (!/^https:\/\/.+\.supabase\.co$/i.test(projectUrl) || !serviceKey) throw new Error("Supabase URL or service_role key is missing");
  curlServiceKey = serviceKey;
  const base = `${projectUrl}/functions/v1/chatgpt-plan`;
  const headers = { "x-ai-phone-service-key": serviceKey, "Content-Type": "application/json" };

  const modelData = await checkedJson(`${base}/models`, { headers, cache: "no-store" }, "models");
  const models = Array.isArray(modelData.models) ? modelData.models : [];
  const model = String(models[0]?.slug || "");
  if (!model) throw new Error("No ChatGPT plan model is available");
  console.log(`模型列表通过（${models.length} 个模型）。`);

  const requestBody = { model, messages: [{ role: "user", content: "Reply with exactly AI_PHONE_OK" }] };
  const streamResponse = await checkedFetch(`${base}/responses`, { method: "POST", headers, body: JSON.stringify({ ...requestBody, stream: true }) }, "stream-chat");
  const streamText = await streamResponse.text();
  if (!streamResponse.ok || !streamText.includes("data: [DONE]")) throw new Error(`Streaming chat failed (${streamResponse.status})`);
  console.log("流式聊天通过。");

  await checkedJson(`${base}/refresh-test`, { headers, cache: "no-store" }, "refresh");
  console.log("Token 强制刷新通过。");

  const offline = await checkedJson(`${base}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...requestBody, stream: false }),
  }, "offline-replay");
  if (typeof offline.choices?.[0]?.message?.content !== "string" || !offline.choices[0].message.content) {
    throw new Error("Offline-compatible response was empty");
  }
  console.log("刷新后的离线回复重放通过。");
  saveResult({ status: "passed", modelCount: models.length, tests: ["models", "stream-chat", "refresh", "offline-replay"] });
  console.log("全部真实验证通过；结果文件不含凭证或回复正文。");
}

main().catch(failAndExit);

