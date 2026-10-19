# ChatGPT 官方账号登录与订阅额度

截至 2026-10-19，OpenAI 已提供 **Sign in with ChatGPT**，并允许符合资格的 ChatGPT Plus / Pro 用户授权第三方应用调用 Responses API，使用其 ChatGPT 计划额度或可用 credits。它与按量计费的 OpenAI API Key 是两条独立计费路径，不能混用或冒充。

本项目当前部署在 Netlify，属于远程托管的 Web 应用。OpenAI 公布的开源动态注册流程面向本地或自托管客户端，并要求 OAuth 回调使用 `http://127.0.0.1:<port>/auth/callback`。官方文档同时要求远程托管或商业应用先提交合作申请并获得批准。因此，在获得 OpenAI 为本域名签发的客户端配置前，不能把该渠道作为可用功能上线。

申请与实现前置条件：

1. 通过 OpenAI 的 Sign in with ChatGPT 远程应用/合作方申请取得正式客户端资格。
2. 为 `https://mianyan.netlify.app`（及实际生产自定义域名，如有）登记准确的回调地址。
3. 仅请求官方允许的身份与计划额度 scopes，并确认包含 `chatgpt.tokens.use.direct`。
4. 推理必须调用 `POST https://api.openai.com/v1/responses`，设置 `store: false`、`stream: true`，且只使用账号模型列表返回的模型。
5. Token 必须保存在服务端安全会话中；不得写入 localStorage、公开环境变量或日志。
6. 未获授权、额度耗尽或不可用时，必须明确提示，不得静默切换到 API Key 计费。

官方资料：

- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
