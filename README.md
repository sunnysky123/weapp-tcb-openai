# cloudbase-openai-adapter

把腾讯云 [CloudBase Node SDK](https://docs.cloudbase.net/ai/model/nodejs-access) 的大模型调用封装成 **OpenAI 兼容接口**（Chat Completions + Responses），供本地 agent（ZCode / Cline / Codex / LangChain / OpenAI SDK 等）以 OpenAI 兼容模式直连使用。

```
本地 agent ──OpenAI 格式──▶ 本适配器(127.0.0.1:8090) ──@cloudbase/node-sdk──▶ CloudBase AI 大模型
```

## 能力

| 能力 | 说明 |
| --- | --- |
| 非流式对话 | `POST /v1/chat/completions`、`POST /v1/responses`（`stream: false`） |
| 流式对话 | SSE，逐 token 输出；Chat 以 `data: [DONE]` 收尾，Responses 以 `response.completed` 事件收尾 |
| Responses API | `input` / `instructions` / `function_call` / `previous_response_id` / 检索与删除 |
| 深度思考 | `reasoning_effort`（Chat）/ `reasoning.effort`（Responses）透传，思维链随流式事件返回 |
| 多模态 | `image_url`（Chat）/ `input_image`（Responses）类型的 content parts 直接透传 |
| 工具调用 | 两套协议的 `tools` / `tool_calls` 完整往返 |
| 模型列表 | `GET /v1/models`（默认模型 + MODEL_MAP 别名） |

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY
npm start              # 默认监听 http://127.0.0.1:8090（监听地址由 .env 的 HOST 决定）
```

如需让局域网内其它设备访问，把 `.env` 的 `HOST` 改成 `0.0.0.0`（或本机网卡 IP）：

```bash
HOST=0.0.0.0
PORT=8090
```

此时请务必设置 `API_KEY`，否则同网段任何人都能调用本服务。启动日志会打印实际监听地址。

验证：

```bash
curl http://127.0.0.1:8090/health
npm run test:mock       # 离线端到端测试（mock SDK，无需凭证，跑原生+降级两种模式）
npm run test:nonstream  # 非流式（需真实凭证）
npm run test:stream     # 流式（需真实凭证）
npm run test:tools      # 工具调用两轮对话（需真实凭证）
npm run test:responses  # Responses API（非流式/流式/工具/previous_response_id）
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

### Responses API

`baseURL` 同上。支持 `input`、`instructions`、`tools`（扁平 function 定义）、
`previous_response_id`、`store`、`stream`：

```js
const client = new OpenAI({ apiKey: '你的API_KEY', baseURL: 'http://127.0.0.1:8090/v1' });

const first = await client.responses.create({
  model: 'hy3',
  instructions: '你是简洁的中文助手。',
  input: '北京今天天气怎么样？',
  tools: [
    {
      type: 'function',
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
});
const call = first.output.find((o) => o.type === 'function_call');

const second = await client.responses.create({
  model: 'hy3',
  previous_response_id: first.id, // 自动串接历史
  input: [{ type: 'function_call_output', call_id: call.call_id, output: '北京：26°C，晴' }],
});
console.log(second.output_text);
```

curl 也可直接流式调用：

```bash
curl -N http://127.0.0.1:8090/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"hy3","stream":true,"input":"写一首春天的五言绝句"}'
```

## 配置（环境变量 / .env）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TCB_ENV_ID` | 是 | 云开发环境 ID |
| `TCB_SECRET_ID` / `TCB_SECRET_KEY` | 本地运行需要 | 腾讯云 [API 密钥](https://console.cloud.tencent.com/cam/capi)；在云函数/云托管内可留空 |
| `PORT` | 否 | 监听端口，默认 `8090` |
| `HOST` | 否 | 监听地址（IP），默认 `127.0.0.1`（仅本机可访问）；填 `0.0.0.0` 监听所有网卡，或填本机某个网卡 IP（如 `192.168.1.10`） |
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

**降级边界**：只有「原生通道不可用」才触发全局降级（429、5xx、网络错误、401/403/408）。请求本身不合法（如 400/404/422）时不会降级——那类错误在 prompt 模式下同样会失败，却会让后续正常请求被拖进低质量路径（模型自由生成 JSON，容易漏参数），并把错误原因吞成 500。这类响应会以原状态码 + `upstream_bad_request` 返回，便于定位。

**arguments 归一化**：上游或客户端把 `tool_calls[].function.arguments` 传成对象、空串或 `null` 时，适配器统一转成 JSON 字符串（空值补成 `{}`）。SDK 与上游只接受字符串，否则会直接 400，客户端则表现为「调用工具但参数为空」。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 兼容（支持 `stream`、`tools`、`reasoning_effort`） |
| POST | `/v1/responses` | OpenAI Responses API 兼容（支持 `input`、`instructions`、`tools`、`previous_response_id`、`store`、`stream`） |
| GET | `/v1/responses/{id}` | 取回本进程内已生成的响应（`store: false` 时不保存） |
| DELETE | `/v1/responses/{id}` | 删除本进程内的响应副本 |
| GET | `/v1/models` | 模型列表 |
| GET | `/health` | 健康检查 |

错误统一为 OpenAI 风格：`{"error": {"message", "type", "code"}}`。

## Responses API 说明

请求/响应字段映射：

| Responses API | 本适配器处理 |
| --- | --- |
| `input`（string 或 item 数组） | `message` / `function_call` / `function_call_output` 转为 Chat `messages`；相邻 `function_call` 合并为同一条 `assistant.tool_calls`；`developer` 角色映射为 `system` |
| `instructions` | 作为最前面的 system 消息注入（与历史里已有内容相同时不重复注入） |
| `input_text` / `input_image` | 转为 `text` / `image_url` parts |
| `tools`（扁平 `{type:'function', name, ...}`） | 转为 Chat `tools`；`web_search` 等内置工具被忽略 |
| `tool_choice` | `auto`/`none`/`required` 直通，`{type:'function', name}` 转为 Chat 形状 |
| `max_output_tokens` | → `max_tokens` |
| `reasoning.effort` | → `reasoning_effort` |
| `text.format` | `json_object` / `json_schema` → `response_format` |
| `previous_response_id` | 从进程内历史（TTL 30 分钟、上限 100 条）补全上下文 |
| `store` | `false` 时不写入进程内存储（也不可检索/续接） |

输出侧：

- 非流式返回标准 `object: "response"` 对象，`output` 含 `reasoning`（若有思维链）、`message`（`output_text`）与 `function_call` 条目。
- 流式按规范顺序发送事件：`response.created` → `response.in_progress` → `response.output_item.added` / `content_part.added` → `response.output_text.delta`（或 `response.function_call_arguments.delta`）→ `*.done` → `response.completed`。没有 `data: [DONE]` 哨兵。
- 截断（上游 `finish_reason: length`）映射为 `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`；流中途出错则以 `error` 事件 + `response.failed` 收尾。
- `previous_response_id` 的历史保存在**进程内存**中，重启即失效；多实例部署时请让同一会话命中同一实例。

## 部署到云函数（可选）

把 `src/` 作为云函数部署后，同环境内无需密钥（自动使用云函数身份）。注意入口需包一层云函数事件协议，或改用云托管直接运行本服务（推荐，天然支持 SSE 流式）。

## 限制

- 仅支持 `n=1`（单路输出）
- 降级模式的流式输出为「先缓冲再合成」，工具场景下无逐字流式效果
- Responses 的 `previous_response_id` / 响应检索走进程内存，不做持久化
- Responses 内置工具（`web_search`、`file_search`、`code_interpreter`、`mcp` 等）未实现，会被忽略
- 图片生成（`generateImage`）未封装，需要时可按 CloudBase 文档扩展 `/v1/images/generations`
