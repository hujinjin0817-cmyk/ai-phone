import type { ApiConfig } from "./settings-types";
import { loadCloudBackupConfig, normalizeBackupUrl } from "./cloud-backup/config";

export const CHATGPT_ACCOUNT_PROVIDER = "ChatGPTAccount";
export const CHATGPT_PLAN_FUNCTION = "chatgpt-plan";

export function isChatGPTAccountConfig(config: Pick<ApiConfig, "provider">): boolean {
  return config.provider === CHATGPT_ACCOUNT_PROVIDER;
}

export function getChatGPTPlanTarget(path = "responses"): { url: string; headers: Record<string, string> } {
  if (typeof window === "undefined") {
    throw new Error("ChatGPT 账号渠道只能通过已配置的个人 Supabase 调用。");
  }
  const cloud = loadCloudBackupConfig();
  const url = normalizeBackupUrl(cloud.url || "");
  const serviceKey = String(cloud.key || "").trim();
  if (!url || !serviceKey) {
    throw new Error("请先在数据管理中配置个人 Supabase 地址和 service_role key。");
  }
  return {
    url: `${url}/functions/v1/${CHATGPT_PLAN_FUNCTION}/${path.replace(/^\/+/, "")}`,
    headers: {
      "Content-Type": "application/json",
      "x-ai-phone-service-key": serviceKey,
    },
  };
}
