# ChatGPT 账号渠道（订阅额度）

本渠道使用 OpenAI 官方开源应用的 **Sign in with ChatGPT** 预览流程，不是 OpenAI API Key，
也不会把 API 账单伪装成 ChatGPT 订阅额度。它通过 OAuth 获得
`chatgpt.tokens.use.direct` 权限，并只调用官方 `GET /v1/models` 与
`POST /v1/responses`。

> 这是 OpenAI 的预览能力。官方当前说明：付费或远程托管应用需另行申请；本实现面向
> 个人、自托管的开源 AI Phone。上游预览规则变化时，登录或刷新可能暂时不可用。

## 安全边界

- ChatGPT access/refresh/id token 不进入网页、IndexedDB、Local Storage、GitHub、Netlify 或日志。
- 本地登录脚本只在内存中持有 Token，并通过 HTTPS 直接写入个人 Supabase Vault。
- Edge Function 用 Vault 内的轮换 refresh token 刷新会话；并发刷新使用乐观锁，失败方重新读取胜出方的新 Token。
- 上游请求固定到 `https://api.openai.com/v1`，响应使用 `store:false`。

## 首次启用

1. 在小手机 **设置 → 数据管理**确认当前个人 Supabase 地址与 `service_role` key 已配置。
2. 在本项目目录运行 `npm run chatgpt:login`，按提示输入同一个 Supabase URL、
   `service_role` key 和 Supabase Access Token。两个密钥均不回显、不保存；向导会在
   同一个项目中增加 `chatgpt-plan` Edge Function 和 Vault RPC，不会清空原有配置、
   备份或聊天数据，随后打开 OpenAI 官方授权页。也可以先在 **设置 → 云服务部署**
   对同一个个人云执行一次重新部署，再运行向导（重复执行安全）。
3. 授权成功后，在 **设置 → API 设置**新增配置，服务商选择
   **ChatGPT 账号（订阅额度）**，点击“拉取模型列表”，选择模型并测试连接。

## 验证

本地无凭证测试：

```bash
npm run test:chatgpt-plan
```

它覆盖模型列表、Responses 流转换、强制 Token 轮换、离线回复重放与错误密钥拒绝。
部署后可对 `GET /functions/v1/chatgpt-plan/refresh-test` 发起带
`x-ai-phone-service-key` 的请求做一次真实轮换验证；接口只返回成功状态和过期时间，
不返回任何 Token。

## 当前预览限制

OpenAI 官方流程要求每次发送完整对话历史，不支持 `previous_response_id`。系统提示被转换为
Responses 的 `instructions`；当前渠道不启用图像识别和原生工具调用，以避免发送官方预览
尚未支持的输入或工具。小手机原有 API 渠道完全保留。
