'use strict';

const crypto = require('crypto');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- 模型映射

function mapModel(requestedModel, config) {
  if (!requestedModel || requestedModel === 'default') return config.defaultModel;
  return config.modelMap[requestedModel] || requestedModel;
}

// ---------------------------------------------------------------- 工具转换
// OpenAI:  { type: "function", function: { name, description, parameters } }
// CloudBase: { name, description, parameters, fn }

function fromOpenAITools(openaiTools) {
  if (!Array.isArray(openaiTools)) return [];
  return openaiTools
    .filter((t) => t && (t.type === 'function' || t.function))
    .map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
        // 原生模式下 SDK 可能会执行 fn；本地 agent 场景下绝不应发生，
        // 兜底返回占位符，避免真实执行任何东西
        fn: async () =>
          `[tool-call bridged to client: ${fn.name}]`,
      };
    })
    .filter((t) => typeof t.name === 'string' && t.name);
}

// tool_calls[].function.arguments 必须是 JSON 字符串：
// - 上游给对象 → 序列化
// - 上游给空串/null/undefined → '{}'（空串会让客户端按“参数为空”处理）
// - 已是字符串 → 原样保留（可能是分片累积中的半截 JSON）
// 用显式类型判断而非 ||，避免合法值 '' / 0 被误判为缺失。
function normalizeToolArguments(value) {
  if (typeof value === 'string') return value === '' ? '{}' : value;
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

// 规范化 tool_calls 数组：客户端可能把 arguments 回传成对象
// （SDK 期望 JSON 字符串，否则上游直接 400）
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    if (!tc.type) tc.type = 'function';
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : (tc.function = {});
    fn.arguments = normalizeToolArguments(fn.arguments);
  }
  return toolCalls;
}

// 从 SDK rawResponses 里防御式提取 tool_calls / reasoning_content / finish_reason
function extractFromRawResponses(rawResponses) {
  const out = {
    message: null, // OpenAI 形状的 assistant message
    finishReason: null,
    usage: null,
    reasoningContent: null,
  };
  if (!Array.isArray(rawResponses) || rawResponses.length === 0) return out;
  const raw = rawResponses[rawResponses.length - 1];
  const choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
  if (!choice) return out;

  const msg = choice.message || {};
  out.finishReason = choice.finish_reason || choice.finishReason || null;

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    out.message = {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
      tool_calls: msg.tool_calls.map((tc, i) => ({
        id: tc.id || genId('call'),
        type: 'function',
        function: {
          name: (tc.function && tc.function.name) || tc.name || `tool_${i}`,
                  arguments: normalizeToolArguments(
                    tc.function && tc.function.arguments !== undefined
                      ? tc.function.arguments
                      : tc.arguments
                  ),
        },
      })),
    };
  }

  if (typeof msg.reasoning_content === 'string') {
    out.reasoningContent = msg.reasoning_content;
  } else if (typeof msg.reasoning === 'string') {
    out.reasoningContent = msg.reasoning;
  }

  if (raw.usage && typeof raw.usage === 'object') {
    out.usage = normalizeUsage(raw.usage);
  }
  return out;
}

// ---------------------------------------------------------------- usage 归一化

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens;
  const completion =
    usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens;
  if (prompt === undefined && completion === undefined) return undefined;
  return {
    prompt_tokens: Number(prompt) || 0,
    completion_tokens: Number(completion) || 0,
    total_tokens:
      Number(usage.total_tokens) ||
      (Number(prompt) || 0) + (Number(completion) || 0),
  };
}

// ---------------------------------------------------------------- tool_choice 映射

function mapToolChoice(tc) {
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  if (tc && typeof tc === 'object' && tc.function && tc.function.name) {
    return { type: 'function', function: { name: tc.function.name } };
  }
  return undefined;
}

// ---------------------------------------------------------------- 请求转换
// OpenAI chat.completions 请求体 → CloudBase generateText/streamText 参数

function toCloudbaseParams(openaiBody, config) {
  const params = {
    model: mapModel(openaiBody.model, config),
    messages: sanitizeMessages(openaiBody.messages),
  };

  // 常见采样参数直接透传（CloudBase 底层即 OpenAI 风格，不认识的多余字段会被忽略）
  for (const key of [
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'presence_penalty',
    'frequency_penalty',
    'stop',
    'seed',
    'reasoning_effort',
    'user',
  ]) {
    if (openaiBody[key] !== undefined) {
      params[key === 'max_completion_tokens' ? 'max_tokens' : key] =
        openaiBody[key];
    }
  }

  if (typeof openaiBody.response_format === 'object' && openaiBody.response_format) {
    params.response_format = openaiBody.response_format;
  }

  if (openaiBody.tool_choice !== undefined) {
    const toolChoice = mapToolChoice(openaiBody.tool_choice);
    if (toolChoice !== undefined) params.toolChoice = toolChoice;
  }

  // OpenAI 新 SDK 可能传 n=1；只支持单路输出
  if (openaiBody.n && Number(openaiBody.n) > 1) {
    throw openaiError(
      'only n=1 is supported by this adapter',
      'invalid_request_error',
      'unsupported_n',
      400
    );
  }

  return params;
}

// 清理消息：剥离 CloudBase 不识别的字段，保留 role/content（含多模态 parts）
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) {
    throw openaiError(
      'messages must be an array',
      'invalid_request_error',
      'invalid_messages',
      400
    );
  }
  return messages.map((m) => {
    if (!m || typeof m !== 'object') {
      throw openaiError(
        'each message must be an object',
        'invalid_request_error',
        'invalid_messages',
        400
      );
    }
    // 带 tool_calls 的 assistant 消息保留 content: null（部分上游要求 null 而非空串）
    const cleaned = { role: m.role, content: m.content ?? (Array.isArray(m.tool_calls) ? null : '') };
        // assistant 的 tool_calls 原样带回（多轮工具对话必需），arguments 统一为 JSON 字符串
            if (Array.isArray(m.tool_calls)) cleaned.tool_calls = normalizeToolCalls(m.tool_calls);
    // tool 角色的 tool_call_id 保留
    if (m.tool_call_id !== undefined) cleaned.tool_call_id = m.tool_call_id;
    return cleaned;
  });
}

// ---------------------------------------------------------------- 响应构建（非流式）

// 结构化 tool_calls 存在时 finish_reason 必须是 'tool_calls'：
// 上游可能同时给 tool_calls 和 finish_reason: 'stop'，若保留 'stop'，
// 只看 finish_reason 的 agent 会静默跳过工具执行。length/content_filter 等原因仍保留。
function resolveFinishReason(finishReason, hasToolCalls) {
  if (hasToolCalls && (finishReason == null || finishReason === 'stop')) {
    return 'tool_calls';
  }
  return finishReason || 'stop';
}

function buildCompletionResponse({ model, message, finishReason, usage }) {
  return {
    id: genId('chatcmpl'),
    object: 'chat.completion',
    created: nowSec(),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: resolveFinishReason(
          finishReason,
          Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ),
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------- SSE chunk 构建

function buildChunk({ id, model, delta, finishReason = null, usage = undefined }) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage !== undefined) chunk.usage = usage;
  return chunk;
}

function sseWrite(res, obj) {
  if (res.writableEnded || res.destroyed) return; // 客户端已断开/已收尾时丢弃写入
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------------------------------------------------------------- DSML 标记解析
// 部分模型（hy3 等）在工具调用未走结构化通道时，会把内部函数调用语法
// （<｜｜DSML｜｜ ...> 特殊标记）当普通文本输出。这里解析回 OpenAI tool_calls。

// ｜ 为全角竖线 U+FF5C，同时容忍半角 | 混用
const DSML_TOKEN = '[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}';
const RE_DSML_INVOKE = new RegExp(`<${DSML_TOKEN}\\s*invoke\\s+name\\s*=\\s*"([^"]*)"`, 'g');
const RE_DSML_PARAM = new RegExp(
  `<${DSML_TOKEN}\\s*parameter\\s+name\\s*=\\s*"([^"]*)"[^>]*>([\\s\\S]*?)</${DSML_TOKEN}\\s*parameter\\s*>`,
  'g'
);
const RE_DSML_PARAM_OPEN = new RegExp(`<${DSML_TOKEN}\\s*parameter\\s+name\\s*=\\s*"([^"]*)"[^>]*>`, 'g');
const RE_DSML_ANY_TAG = new RegExp(`</?${DSML_TOKEN}`);

function parseDsmlParamValue(raw) {
  const v = String(raw).replace(/^\r?\n/, '').replace(/\r?\n[\s]*$/, '').trim();
  try {
    return JSON.parse(v);
  } catch {
    return v; // 保留原始字符串（如 Windows 路径、代码）
  }
}

// 提取一个 invoke 区域内的全部参数；兼容未闭合的 parameter 标签
function extractDsmlParams(region) {
  const args = {};
  let matched = false;
  RE_DSML_PARAM.lastIndex = 0;
  let m;
  while ((m = RE_DSML_PARAM.exec(region)) !== null) {
    matched = true;
    args[m[1]] = parseDsmlParamValue(m[2]);
  }
  if (!matched) {
    RE_DSML_PARAM_OPEN.lastIndex = 0;
    while ((m = RE_DSML_PARAM_OPEN.exec(region)) !== null) {
      const start = m.index + m[0].length;
      const rest = region.slice(start);
      const nextTag = rest.search(RE_DSML_ANY_TAG);
      const value = nextTag === -1 ? rest : rest.slice(0, nextTag);
      args[m[1]] = parseDsmlParamValue(value);
    }
  }
  return args;
}

// 从含 DSML 标记的文本中解析工具调用。返回 { toolCalls, content } 或 null
function parseDsmlToolCalls(text) {
  if (!text || typeof text !== 'string' || !text.includes('DSML')) return null;
  const firstTag = text.search(RE_DSML_ANY_TAG);
  if (firstTag === -1) return null;

  const invokes = [];
  RE_DSML_INVOKE.lastIndex = 0;
  let m;
  while ((m = RE_DSML_INVOKE.exec(text)) !== null) {
    invokes.push({ name: m[1], start: m.index, argsStart: m.index + m[0].length });
  }
  if (invokes.length === 0) return null;

  const toolCalls = invokes.map((inv, i) => {
    // 参数区域：到下一个 invoke 开标签或文本末尾
    const regionEnd = i + 1 < invokes.length ? invokes[i + 1].start : text.length;
    const args = extractDsmlParams(text.slice(inv.argsStart, regionEnd));
    return {
      id: genId('call'),
      type: 'function',
      function: { name: inv.name, arguments: JSON.stringify(args) },
    };
  });

  return { toolCalls, content: text.slice(0, firstTag).trim() || null };
}

// 流式用：pending 尾部有多长的内容可能是 "<｜｜DSML..." 开标签的前缀（需扣留观察）
function dsmlHoldLen(s) {
  const openers = ['<｜｜DSML', '<|DSML', '<｜DSML', '<||DSML'];
  for (const op of openers) {
    for (let len = Math.min(s.length, op.length - 1); len > 0; len--) {
      if (s.endsWith(op.slice(0, len))) return len;
    }
  }
  return 0;
}

// 流式用：pending 尾部有多长的内容可能是 "```json" fence 开标签的前缀（需扣留观察）
function fenceHoldLen(s) {
  const opener = '```json';
  for (let len = Math.min(s.length, opener.length); len > 0; len--) {
    if (s.endsWith(opener.slice(0, len))) return len;
  }
  return 0;
}

// ---------------------------------------------------------------- 提示词注入模式（工具降级）

function buildToolSystemPrompt(tools) {
  const specs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return [
    '# Tool Calling Protocol',
    '',
    'You can invoke tools. When you decide to call one or more tools, respond with ONLY a fenced JSON block and nothing else, in this exact format:',
    '',
    '```json',
    '{"tool_calls": [{"name": "<tool name>", "arguments": {<json arguments>}}]}',
    '```',
    '',
    'Rules:',
    '- "arguments" must be a JSON object matching the tool\'s parameters schema.',
    '- To call multiple tools, put multiple objects in the "tool_calls" array.',
    '- If you do not need any tool, answer in plain text WITHOUT the JSON block.',
    '- Never invent tool names; only use the tools listed below.',
    '- IMPORTANT: Never emit internal markup such as <｜｜DSML｜｜> special tokens — they are NOT valid tool-call output here. Only the fenced JSON block above counts.',
    '',
    'Available tools:',
    JSON.stringify(specs, null, 2),
  ].join('\n');
}

// 从模型输出解析工具调用。返回 { toolCalls, content } 或 null
function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  let lastParsed = null;

  while ((match = fenceRe.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const calls = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.tool_calls)
          ? parsed.tool_calls
          : parsed.name
            ? [parsed]
            : null;
      if (!calls) continue;
      const toolCalls = calls
        .filter((c) => c && typeof c.name === 'string')
        .map((c) => ({
          id: c.id || genId('call'),
          type: 'function',
          function: {
            name: c.name,
            arguments:
              typeof c.arguments === 'string'
                ? c.arguments
                : JSON.stringify(c.arguments ?? c.parameters ?? {}),
          },
        }));
      // 记录命中工具块的 fence 起点：首个 fence 可能只是代码示例，
      // content 不能按首个 fence 切（否则中间的说明文字会被吃掉）
      if (toolCalls.length > 0) lastParsed = { toolCalls, start: match.index };
    } catch {
      // 不是合法 JSON 的代码块，忽略
    }
  }

  if (lastParsed) {
    // 以命中工具块的 fence 为界，之前的文本视作普通 content
    const content = text.slice(0, lastParsed.start).trim();
    return { toolCalls: lastParsed.toolCalls, content: content || null };
  }

  // fenced JSON 未命中时，尝试解析模型泄漏的 DSML 内部标记
  return parseDsmlToolCalls(text);
}

// ---------------------------------------------------------------- 错误对象

function openaiError(message, type, code, status) {
  const err = new Error(message);
  err.openai = {
    error: {
      message,
      type: type || 'api_error',
      code: code === undefined ? null : code,
    },
  };
  err.status = status || 500;
  return err;
}

module.exports = {
  genId,
  nowSec,
  mapModel,
  fromOpenAITools,
  extractFromRawResponses,
  normalizeUsage,
  toCloudbaseParams,
  sanitizeMessages,
  buildCompletionResponse,
  resolveFinishReason,
  buildChunk,
  sseWrite,
    normalizeToolArguments,
      normalizeToolCalls,
  buildToolSystemPrompt,
  parseToolCallsFromText,
  parseDsmlToolCalls,
  dsmlHoldLen,
  fenceHoldLen,
  mapToolChoice,
  openaiError,
};
