import type { ApiConfig } from "./settings-types";

export const CHATGPT_ACCOUNT_PROVIDER = "ChatGPTAccount";
export const CHATGPT_PLAN_FUNCTION = "chatgpt-plan";

export function isChatGPTAccountConfig(config: Pick<ApiConfig, "provider">): boolean {
  return config.provider === CHATGPT_ACCOUNT_PROVIDER;
}

export function getChatGPTPlanTarget(path = "responses"): { url: string; headers: Record<string, string> } {
  return {
    url: `/api/chatgpt-plan/${path.replace(/^\/+/, "")}`,
    headers: {
      "Content-Type": "application/json",
    },
  };
}

