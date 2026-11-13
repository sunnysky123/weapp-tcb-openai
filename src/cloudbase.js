'use strict';

const { config } = require('./config');
const {
  fromOpenAITools,
  extractFromRawResponses,
  normalizeUsage,
  buildToolSystemPrompt,
  buildChunk,
  sseWrite,
  genId,
  parseToolCallsFromText,
  dsmlHoldLen,
  fenceHoldLen,
  resolveFinishReason,
  openaiError,
} = require('./convert');

// ---------------------------------------------------------------- SDK 初始化（惰性）

let _app = null;
let _model = null;

function getApp() {
  if (_app) return _app;
  if (!config.envId) {
    throw openaiError(
      'TCB_ENV_ID is not configured. Copy .env.example to .env and fill in your CloudBase environment ID and API keys.',
      'configuration_error',
      'missing_env_id',
      500
    );
  }
  let tcb;
  try {
    tcb = require('@cloudbase/node-sdk');
  } catch (e) {
    throw openaiError(
      `failed to load @cloudbase/node-sdk: ${e.message}. Run "npm install" first.`,
      'configuration_error',
      'sdk_missing',
      500
    );
  }
  const initOptions = {
    env: config.envId,
    timeout: config.tcbTimeout,
  };
  if (config.secretId && config.secretKey) {
    initOptions.secretId = config.secretId;
    initOptions.secretKey = config.secretKey;
  }
  _app = tcb.init(initOptions);
  return _app;
}

function getModel() {
  if (_model) return _model;
  const ai = getApp().ai();
  _model = ai.createModel('cloudbase');
  return _model;
}

// ---------------------------------------------------------------- 工具模式状态

// auto 模式下原生路径失败后的降级开关：带 TTL，到期自动恢复原生模式重试，
// 避免一次偶发网络抖动导致整个进程永久降级到 prompt 模式（工具质量静默下降且无恢复路径）
const NATIVE_RETRY_DELAY_MS = 60 * 1000;
let nativeDisabledUntil = 0;

// 只有“原生能力不可用”才值得全局降级。请求本身有问题（400/404/413 等 4xx）
// 时降级毫无意义：prompt 模式同样会失败，还会让后续正常请求被拖去低质量的
// prompt 路径（模型自由生成 JSON，容易漏参数）。这类错误必须只影响当前请求。
const DEGRADABLE_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504, undefined]);

function isDegradableError(e) {
  const status = Number(e && (e.status || e.statusCode || e.code));
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return DEGRADABLE_STATUS.has(status);
  }
  return true; // 网络错误 / 无状态码：可能是原生通道不可用，允许降级
}

// 请求级错误：原样透出 4xx，不要被包成 502/500
function isClientError(e) {
  const status = Number(e && (e.status || e.statusCode || e.code));
  return Number.isFinite(status) && status >= 400 && status < 500;
}

// ---------------------------------------------------------------- 非流式 chat

/**
 * 处理非流式请求，返回 buildCompletionResponse 所需的 raw 形状。
 * tools 为已转换的 CloudBase 工具数组（可能为空）。
 */
async function chatCompletion(cloudbaseParams, openaiTools, requestedModel, signal) {
  const hasTools = openaiTools && openaiTools.length > 0;
  const useNativeTools = hasTools && modeUsesNative();

  if (!hasTools || useNativeTools) {
    const params = { ...cloudbaseParams };
    if (useNativeTools) {
      params.tools = openaiTools;
      params.maxSteps = 1; // 只让模型走一步：产出 tool_calls 即停，不在服务端执行
    }
    if (signal) params.signal = signal; // 客户端断开时取消上游生成
    try {
      const result = await getModel().generateText(params);
      return buildTextResponse(result, requestedModel, useNativeTools);
    } catch (e) {
          // 请求级 4xx 不降级：降级只会把同样的错误再犯一次，还会把后续请求
          // 拖进低质量的 prompt 路径（模型自由生成 JSON → 参数缺失/漏调）
          if (useNativeTools && config.toolsMode === 'auto' && isDegradableError(e)) {
        nativeDisabledUntil = Date.now() + NATIVE_RETRY_DELAY_MS;
        log(`native tool path failed (${e.message}); falling back to prompt mode`);
        return promptModeCompletion(cloudbaseParams, openaiTools, requestedModel, signal);
      }
      throw toOpenAIError(e);
    }
  }

  // prompt 模式
  return promptModeCompletion(cloudbaseParams, openaiTools, requestedModel, signal);
}

function modeUsesNative() {
  if (config.toolsMode === 'native') return true;
  if (config.toolsMode === 'prompt') return false;
  return Date.now() >= nativeDisabledUntil; // auto：降级 TTL 过期后自动重试原生
}

// 把 generateText 的结果转成 OpenAI 响应
function buildTextResponse(result, requestedModel, cameFromNativeTools) {
  const extracted = extractFromRawResponses(result && result.rawResponses);

  // rawResponses 拿不到 tool_calls 时，退而从 result.messages 的最后一条找
  // （只有最后一条才是本次新生成的 assistant 消息；历史消息里可能带着上一轮的 tool_calls）
  let toolCallsMessage = extracted.message;
  if (!toolCallsMessage && cameFromNativeTools && Array.isArray(result.messages) && result.messages.length > 0) {
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.tool_calls) && lastMsg.tool_calls.length > 0) {
      toolCallsMessage = {
        role: 'assistant',
        content: typeof lastMsg.content === 'string' ? lastMsg.content : null,
        tool_calls: lastMsg.tool_calls,
      };
    }
  }

  const message = toolCallsMessage || {
    role: 'assistant',
    content: (result && result.text) || '',
  };
  if (!toolCallsMessage && extracted.reasoningContent) {
    message.reasoning_content = extracted.reasoningContent;
  }

  let finishReason = extracted.finishReason;

  // 模型把工具调用当普通文本输出（如 <｜｜DSML｜｜> 内部标记泄漏）时，
  // 解析回结构化 tool_calls，避免原始标记泄漏给 agent
  if (
    !toolCallsMessage &&
    cameFromNativeTools &&
    typeof message.content === 'string' &&
    message.content
  ) {
    const parsed = parseToolCallsFromText(message.content);
    if (parsed && parsed.toolCalls.length > 0) {
      message.content = parsed.content;
      message.tool_calls = parsed.toolCalls;
      finishReason = 'tool_calls';
      log('converted leaked tool-call markup from text into structured tool_calls');
    }
  }

  const usage = extracted.usage || normalizeUsage(result && result.usage);

  return {
    model: requestedModel,
    message,
    finishReason,
    usage,
  };
}

// 注入工具协议 system 提示词：客户端自带 system 时合并进第一条，
// 避免出现两条 system（部分模型只认第一条，注入的工具协议会被忽略）
function injectToolProtocol(messages, toolPrompt) {
  const msgs = [...(messages || [])];
  const first = msgs[0];
  if (first && first.role === 'system') {
    if (typeof first.content === 'string') {
      msgs[0] = { ...first, content: `${toolPrompt}\n\n${first.content}` };
    } else if (Array.isArray(first.content)) {
      msgs[0] = { ...first, content: [{ type: 'text', text: toolPrompt }, ...first.content] };
    } else {
      msgs[0] = { ...first, content: toolPrompt };
    }
  } else {
    msgs.unshift({ role: 'system', content: toolPrompt });
  }
  return msgs;
}

// 降级：提示词注入模式。返回 buildCompletionResponse 所需的 raw 形状
async function promptModeCompletion(cloudbaseParams, openaiTools, requestedModel, signal) {
  const messages = injectToolProtocol(cloudbaseParams.messages, buildToolSystemPrompt(openaiTools));

  // 工具协议走提示词注入，SDK 层的工具参数不传
  const { tools: _t, toolChoice: _tc, ...restParams } = cloudbaseParams;
  if (signal) restParams.signal = signal;

  let result;
  try {
    result = await getModel().generateText({
      ...restParams,
      messages,
    });
  } catch (e) {
    // 降级路径的异常同样需要包装：否则会以裸 Error 冒泡，
    // 被 server 兜成 500 "internal error"，丢掉上游状态码与原因
    throw toOpenAIError(e);
  }
  const text = (result && result.text) || '';

  const parsed = parseToolCallsFromText(text);
  if (parsed && parsed.toolCalls.length > 0) {
    return {
      model: requestedModel,
      message: {
        role: 'assistant',
        content: parsed.content,
        tool_calls: parsed.toolCalls,
      },
      finishReason: 'tool_calls',
      usage: normalizeUsage(result && result.usage),
    };
  }
  return {
    model: requestedModel,
    message: { role: 'assistant', content: text },
    finishReason: 'stop',
    usage: normalizeUsage(result && result.usage),
  };
}

// ---------------------------------------------------------------- 流式 chat

/**
 * 处理流式请求。通过 sink 输出（Chat Completions chunk 或 Responses 事件）。
 * sink 接口见 createChatSink / createResponsesSink。
 */
async function chatCompletionStream(cloudbaseParams, openaiTools, requestedModel, sink, signal) {
  const hasTools = openaiTools && openaiTools.length > 0;
  const useNativeTools = hasTools && modeUsesNative();

  // prompt 模式：全量缓冲后解析合成 chunk（工具 JSON 块不能直接流给客户端）
  if (hasTools && !useNativeTools) {
    return promptModeStream(cloudbaseParams, openaiTools, requestedModel, sink, signal);
  }

  const params = { ...cloudbaseParams };
  if (useNativeTools) {
    params.tools = openaiTools;
    params.maxSteps = 1;
  }
  if (signal) params.signal = signal;

  try {
    const streamRes = await getModel().streamText(params);
    await pumpNativeStream(streamRes, requestedModel, sink, hasTools);
  } catch (e) {
    // 只有还没向客户端写过任何字节（headers 未发出）时才能安全降级，
    // 否则 fallback 重跑整次请求会导致重复输出
        if (
          useNativeTools &&
          config.toolsMode === 'auto' &&
          !sink.res.headersSent &&
          isDegradableError(e)
        ) {
      nativeDisabledUntil = Date.now() + NATIVE_RETRY_DELAY_MS;
      log(`native tool path failed (${e.message}); falling back to prompt mode`);
      return promptModeStream(cloudbaseParams, openaiTools, requestedModel, sink, signal);
    }
    throw toOpenAIError(e);
  }
}

// ---------------------------------------------------------------- 输出 sink

// Chat Completions：data: {...} 帧 + 末尾 data: [DONE]
function createChatSink(res, requestedModel) {
  const meta = { id: genId('chatcmpl'), model: requestedModel };
  return {
    res,
    begin() {
      beginSse(res); // 首个 chunk 前才发响应头：上游早期报错仍能以正确状态码返回
      sseWrite(res, buildChunk({ ...meta, delta: { role: 'assistant', content: '' } }));
    },
    content(text) {
      if (text) sseWrite(res, buildChunk({ ...meta, delta: { content: text } }));
    },
    reasoning(text) {
      if (text) sseWrite(res, buildChunk({ ...meta, delta: { reasoning_content: text } }));
    },
    toolCalls(list) {
      if (Array.isArray(list) && list.length > 0) {
        sseWrite(res, buildChunk({ ...meta, delta: { tool_calls: list } }));
      }
    },
    streamError(e) {
      sseWriteError(res, e);
    },
    end({ finishReason, usage } = {}) {
      sseWrite(res, buildChunk({ ...meta, delta: {}, finishReason, usage }));
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

// SSE 响应头必须等到确定开始流式输出时（拿到上游数据、写首个 chunk 前）再发：
// 提前发 200 会把上游早期错误（如 429）变成 "HTTP 200 + SSE 里的裸 JSON"，
// 骗过客户端的状态码重试逻辑
function beginSse(res) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }
  res._sse = true; // 供 sendError 判断：头已发出且是 SSE 流 → 以 error 帧收尾
}

// 流中途出错时以独立 error 帧告知客户端（不混入 content），随后正常收尾
function sseWriteError(res, e) {
  if (res.writableEnded || res.destroyed) return;
  const payload =
    (e && e.openai) || {
      error: {
        message: `stream error: ${(e && e.message) || 'unknown'}`,
        type: 'api_error',
        code: null,
      },
    };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function pumpNativeStream(streamRes, requestedModel, sink, hasTools) {
  sink.begin(); // 首个 chunk 前才发响应头：上游早期报错仍能以正确状态码返回

  let pending = ''; // 未下发的文本（含 DSML/fence 前缀观察窗口 / 缓冲区）
  let bufferedMode = false; // 检测到泄漏的工具调用标记后，转为全量缓冲
  let fenceHold = false; // 已见 ``` 开标签但还未判定是否 fenced 工具块 → 全部扣留观察
  let fullText = ''; // 全量原始文本（结束时解析用）
  let sawToolCalls = false; // SDK 已给出结构化 tool_calls
  let finishReason = null;
  let chunkUsage = undefined;
  let streamError = null; // 流中途错误（收尾时以 error 帧告知，不混入正文）

  const emitContent = (t) => {
    if (t) sink.content(t);
  };

  // 内容增量路由：正常文本直接下发；疑似 DSML/JSON 工具块则扣留缓冲
  const feedContent = (t) => {
    fullText += t;
    pending += t;
    if (bufferedMode) return;
    if (!hasTools) {
      emitContent(pending);
      pending = '';
      return;
    }

    const dsmlIdx = pending.search(/<\/?[｜|]{0,2}\s*DSML/);

    // fence 观察态：``` 后还没等到判定 → 等 '"tool_calls"'（工具块证据）或闭合 fence（普通代码示例）
    if (fenceHold) {
      if (pending.includes('"tool_calls"') || dsmlIdx !== -1) {
        // 确认是工具块（或 DSML 混入 fence 区）→ 转全量缓冲，结束时统一解析
        bufferedMode = true;
        fenceHold = false;
        pending = '';
        return;
      }
      if (pending.indexOf('```', 3) !== -1) {
        // fence 已闭合且始终未见工具块 → 只是普通代码示例，整体放行
        emitContent(pending);
        pending = '';
        fenceHold = false;
        return;
      }
      return; // 未判定，继续全部扣留
    }

    // DSML 开标签出现 → 之前的内容照发，之后转缓冲
    if (dsmlIdx !== -1) {
      const safe = pending.slice(0, dsmlIdx);
      emitContent(safe);
      bufferedMode = true;
      pending = '';
      return;
    }

    // fenced 工具块：以 ``` 为观察起点。开标签与 '"tool_calls"' 可能被拆散到
    // 多个 chunk（先到 "```"，此时 '"tool_calls"' 还不存在），不能等两者齐了才判定，
    // 否则 fence 开标签会先泄漏给客户端；同时要放行普通代码示例 → 进入观察态等证据
    const fenceIdx = pending.indexOf('```');
    if (fenceIdx !== -1) {
      if (pending.includes('"tool_calls"')) {
        const safe = pending.slice(0, fenceIdx);
        emitContent(safe);
        bufferedMode = true;
        pending = '';
        return;
      }
      const safe = pending.slice(0, fenceIdx);
      emitContent(safe);
      pending = pending.slice(fenceIdx);
      fenceHold = true;
      return;
    }

    // 扣留可能是 "<｜｜DSML..." 或 "``" / "```j" 等开标签前缀的尾巴，避免标记被拆包泄漏
    const hold = Math.max(dsmlHoldLen(pending), fenceHoldLen(pending));
    if (hold < pending.length) {
      const safe = pending.slice(0, pending.length - hold);
      emitContent(safe);
      pending = pending.slice(pending.length - hold);
    }
  };

  try {
    for await (const data of streamRes.dataStream) {
      const mapped = mapStreamChunk(data);
      if (!mapped) continue;
      if (mapped.usage) chunkUsage = mapped.usage;
      const d = mapped.delta || {};
      if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
        sawToolCalls = true;
        sink.toolCalls(d.tool_calls);
      }
      if (mapped.finishReason) finishReason = mapped.finishReason;
      if (typeof d.content === 'string' && d.content) feedContent(d.content);
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        sink.reasoning(d.reasoning_content);
      }
    }
  } catch (e) {
    // 流中途出错：不把错误文本混进正文（避免污染回答、被解析逻辑二次消费），
    // 记录后在收尾阶段以独立 error 帧告知客户端
    streamError = e;
    log(`stream error: ${e.message}`);
  }

  // usage 优先取 CloudBase 汇总
  let usage = chunkUsage;
  try {
    const finalUsage = await streamRes.usage;
    const normalized = normalizeUsage(finalUsage);
    if (normalized) usage = normalized;
  } catch {
    // 拿不到就保持 chunkUsage
  }

  let finalFinish = resolveFinishReason(finishReason, sawToolCalls);

  if (bufferedMode && !sawToolCalls) {
    // 全量缓冲的文本里解析工具调用（DSML 或 fenced JSON）
    const parsed = parseToolCallsFromText(fullText);
    if (parsed && parsed.toolCalls.length > 0) {
      for (const [i, tc] of parsed.toolCalls.entries()) {
        sink.toolCalls([
          {
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          },
        ]);
      }
      finalFinish = 'tool_calls';
      log('converted leaked tool-call markup from stream into structured tool_calls');
    } else {
      // 解析失败：丢弃缓冲的标记乱码（其前的正常内容已下发），保持输出干净
      log(`buffered markup parse failed, dropped ${pending.length} chars`);
    }
  } else if (!bufferedMode && pending) {
    // 冲回扣留的观察窗口尾巴（含未判定的 fence 观察区：不是工具块就当普通文本放行）
    emitContent(pending);
    pending = '';
    fenceHold = false;
  }

  // 流中途出错 → 独立 error 帧（客户端据此感知截断，而不是当成回答的一部分）
  if (streamError) sink.streamError(streamError);

  sink.end({ finishReason: finalFinish, usage });
}

// dataStream 单个数据块 → OpenAI delta。兼容 OpenAI 形状与 AI SDK 形状
function mapStreamChunk(data) {
  if (!data || typeof data !== 'object') return null;

  // OpenAI 形状: { choices: [{ delta, finish_reason }], usage? }
  if (Array.isArray(data.choices) && data.choices.length > 0) {
    const c = data.choices[0];
    const delta = {};
    const src = c.delta || {};
    if (typeof src.content === 'string') delta.content = src.content;
    if (typeof src.reasoning_content === 'string') delta.reasoning_content = src.reasoning_content;
    else if (typeof src.reasoning === 'string') delta.reasoning_content = src.reasoning;
    if (Array.isArray(src.tool_calls)) delta.tool_calls = src.tool_calls;
    return { delta, finishReason: c.finish_reason || null, usage: normalizeUsage(data.usage) };
  }

  // AI SDK 形状: { type: 'text-delta', textDelta } / { type: 'reasoning', ... }
  if (data.type === 'text-delta' && typeof data.textDelta === 'string') {
    return { delta: { content: data.textDelta }, finishReason: null };
  }
  if (data.type === 'reasoning' && typeof data.reasoning === 'string') {
    return { delta: { reasoning_content: data.reasoning }, finishReason: null };
  }
  return null;
}

// 降级流式：非流式请求 + 手动合成事件
async function promptModeStream(cloudbaseParams, openaiTools, requestedModel, sink, signal) {
  const raw = await promptModeCompletion(cloudbaseParams, openaiTools, requestedModel, signal);
  const message = raw.message;

  sink.begin(); // 上游完成后再发响应头：降级请求失败也能以正确状态码返回

  if (message.reasoning_content) sink.reasoning(message.reasoning_content);
  if (message.content) sink.content(message.content);
  if (Array.isArray(message.tool_calls)) {
    for (const [i, tc] of message.tool_calls.entries()) {
      sink.toolCalls([
        {
          index: i,
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        },
      ]);
    }
  }

  sink.end({ finishReason: raw.finishReason, usage: raw.usage });
}

// ---------------------------------------------------------------- 工具函数

function toOpenAIError(e) {
  if (e && e.openai) return e;
  const message = (e && e.message) || 'internal error';

  // 上游 4xx 是请求本身的问题（消息格式/参数不合法）：保留状态码，
  // 让客户端看到可诊断的错误，而不是被包成 502 "internal error"
  if (isClientError(e)) {
    const status = Number(e.status || e.statusCode || e.code);
    const detail = e.requestId ? ` (requestId: ${e.requestId})` : '';
    return openaiError(
      `CloudBase rejected the request: ${message}${detail}`,
      'invalid_request_error',
      'upstream_bad_request',
      status
    );
  }

  const err = openaiError(`CloudBase SDK error: ${message}`, 'api_error', 'upstream_error', 502);
  return err;
}

function log(msg) {
  if (config.debug) console.log(`[cloudbase] ${msg}`);
}

module.exports = {
  getApp,
  getModel,
  chatCompletion,
  chatCompletionStream,
  createChatSink,
  toOpenAIError,
  isDegradableError,
  isClientError,
};
