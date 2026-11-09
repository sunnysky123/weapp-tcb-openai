# cloudbase-openai-adapter

把腾讯云 [CloudBase Node SDK](https://docs.cloudbase.net/ai/model/nodejs-access) 的大模型调用封装成 **OpenAI Chat Completions 兼容接口**，供本地 agent（ZCode / Cline / LangChain / OpenAI SDK 等）以 OpenAI 兼容模式直连使用。

```
本地 agent ──OpenAI 格式──▶ 本适配器(127.0.0.1:8090) ──@cloudbase/node-sdk──▶ CloudBase AI 大模型
```

## 能力

| 能力 | 说明 |
| --- | --- |
| 非流式对话 | `POST /v1/chat/completions`（`stream: false`） |
| 流式对话 | SSE，逐 token 输出，末尾 `data: [DONE]` |
| 深度思考 | `reasoning_effort` 透传，`reasoning_content` 随 delta 返回 |
| 多模态 | `image_url` 类型的 content parts 直接透传 |
| 工具调用 | OpenAI `tools` / `tool_calls` / `role:"tool"` 完整往返 |
| 模型列表 | `GET /v1/models`（默认模型 + MODEL_MAP 别名） |

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
npm start              # 默认监听 http://127.0.0.1:8090
```

验证：

```bash
curl http://127.0.0.1:8090/health
npm run test:mock       # 离线端到端测试（mock SDK，无需凭证，跑原生+降级两种模式）
npm run test:nonstream  # 非流式（需真实凭证）
npm run test:stream     # 流式（需真实凭证）
npm run test:tools      # 工具调用两轮对话（需真实凭证）
```

## 接入本地 agent

以 OpenAI 兼容模式配置：

- **Base URL**：`http://127.0.0.1:8090/v1`
- **API Key**：`.env` 里 `API_KEY` 的值（未设置则任意值均可）
- **Model**：CloudBase 模型名（如 `hy3`、`deepseek-v3.2`），或经 `MODEL_MAP` 映射的别名

OpenAI SDK 示例：

```js
const OpenAI = require('openai');
const client = new OpenAI({
  apiKey: '你的API_KEY',
  baseURL: 'http://127.0.0.1:8090/v1',
});
const res = await client.chat.completions.create({
  model: 'hy3',
  messages: [{ role: 'user', content: '介绍一下李白' }],
});
console.log(res.choices[0].message.content);
```

## 配置（环境变量 / .env）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV_ID` | 是 | 云开发环境 ID |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 本地运行需要 | 腾讯云 [API 密钥](https://console.cloud.tencent.com/cam/capi)；在云函数/云托管内可留空 |
| `PORT` | 否 | 监听端口，默认 `8090` |
| `API_KEY` | 否 | Bearer Token；设置后所有接口要求鉴权 |
| `DEFAULT_MODEL` | 否 | 客户端未指定模型时使用，默认 `hy3` |
| `MODEL_MAP` | 否 | JSON 别名表，如 `{"gpt-4o":"hy3"}` |
| `TCB_TIMEOUT` | 否 | SDK 超时（毫秒），默认 `300000` |
| `TOOLS_MODE` | 否 | `auto`（默认）/ `native` / `prompt` |
| `DEBUG` | 否 | `1` 输出调试日志 |

## 工具调用说明

本地 agent 依赖 OpenAI 语义的 `tool_calls`（模型只决定调用什么，由**客户端**执行工具后回传结果）。CloudBase SDK 的工具是「服务端执行 `fn`」模式，适配器做了桥接：

- **原生模式**：把工具以 `maxSteps: 1` 传给 SDK（模型走一步即停，不在服务端执行），从 SDK 原始响应提取 `tool_calls` 转成 OpenAI 格式返回；`role:"tool"` 消息原样透传；`tool_choice` 映射为 SDK 的 `toolChoice`。
- **降级（prompt）模式**：原生路径不可用时自动切换——把工具协议注入 system 提示词，模型按约定输出 ```json ``` 块，适配器解析后合成标准 `tool_calls` 响应（流式时全量缓冲后合成 chunk）。
- **标记泄漏兜底**：部分模型会把内部函数调用标记（如 `<｜｜DSML｜｜ invoke ...>`）当普通文本输出。适配器会自动识别并把这类文本解析回结构化 `tool_calls`（流式下先扣留疑似标记的分片、确认后转缓冲解析），保证 agent 拿到的永远是干净的 OpenAI 格式。

`TOOLS_MODE=auto` 默认先原生、失败自动降级并在进程内记住；`native` / `prompt` 可强制指定。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 兼容（支持 `stream`、`tools`、`reasoning_effort`） |
| GET | `/v1/models` | 模型列表 |
| GET | `/health` | 健康检查 |

错误统一为 OpenAI 风格：`{"error": {"message", "type", "code"}}`。

## 部署到云函数（可选）

把 `src/` 作为云函数部署后，同环境内无需密钥（自动使用云函数身份）。注意入口需包一层云函数事件协议，或改用云托管直接运行本服务（推荐，天然支持 SSE 流式）。

## 限制

- 仅支持 `n=1`（单路输出）
- 降级模式的流式输出为「先缓冲再合成」，工具场景下无逐字流式效果
- 图片生成（`generateImage`）未封装，需要时可按 CloudBase 文档扩展 `/v1/images/generations`
