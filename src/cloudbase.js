'use strict';

const { config } = require('./config');
const {
  fromOpenAITools,
  extractFromRawResponses,
  normalizeUsage,
  buildToolSystemPrompt,
  parseToolCallsFromText,
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

// auto 模式下若原生路径失败，进程内记住并降级，避免每次都白试一次
let nativeDisabled = false;

// ---------------------------------------------------------------- 非流式 chat

/**
 * 处理非流式请求，返回 OpenAI chat.completion 响应对象。
 * tools 为已转换的 CloudBase 工具数组（可能为空）。
 */
async function chatCompletion(cloudbaseParams, openaiTools, requestedModel) {
  const hasTools = openaiTools && openaiTools.length > 0;
  const useNativeTools = hasTools && modeUsesNative();

  if (!hasTools || useNativeTools) {
    const params = { ...cloudbaseParams };
    if (useNativeTools) {
      params.tools = openaiTools;
      params.maxSteps = 1; // 只让模型走一步：产出 tool_calls 即停，不在服务端执行
    }
    try {
      const result = await getModel().generateText(params);
      return buildTextResponse(result, requestedModel, useNativeTools);
    } catch (e) {
      if (useNativeTools && config.toolsMode === 'auto') {
        nativeDisabled = true;
        log(`native tool path failed (${e.message}); falling back to prompt mode`);
        return promptModeCompletion(cloudbaseParams, openaiTools, requestedModel);
      }
      throw toOpenAIError(e);
    }
  }

  // prompt 模式
  return promptModeCompletion(cloudbaseParams, openaiTools, requestedModel);
}

function modeUsesNative() {
  if (config.toolsMode === 'native') return true;
  if (config.toolsMode === 'prompt') return false;
  return !nativeDisabled; // auto
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
    id: undefined, // 由调用方 buildCompletionResponse 生成
    raw: {
      model: requestedModel,
      message,
      finishReason,
      usage,
    },
  };
}

// 降级：提示词注入模式
async function promptModeCompletion(cloudbaseParams, openaiTools, requestedModel) {
  const messages = [...(cloudbaseParams.messages || [])];
  messages.unshift({ role: 'system', content: buildToolSystemPrompt(openaiTools) });

  // 工具协议走提示词注入，SDK 层的工具参数不传
  const { tools: _t, toolChoice: _tc, ...restParams } = cloudbaseParams;

  const result = await getModel().generateText({
    ...restParams,
    messages,
  });
  const text = (result && result.text) || '';

  const parsed = parseToolCallsFromText(text);
  if (parsed && parsed.toolCalls.length > 0) {
    return {
      raw: {
        model: requestedModel,
        message: {
          role: 'assistant',
          content: parsed.content,
          tool_calls: parsed.toolCalls,
        },
        finishReason: 'tool_calls',
        usage: normalizeUsage(result && result.usage),
      },
    };
  }
  return {
    raw: {
      model: requestedModel,
      message: { role: 'assistant', content: text },
      finishReason: 'stop',
      usage: normalizeUsage(result && result.usage),
    },
  };
}

// ---------------------------------------------------------------- 流式 chat

/**
 * 处理流式请求。直接向 res 写 OpenAI SSE 格式数据（含 data: [DONE]）。
 */
async function chatCompletionStream(cloudbaseParams, openaiTools, requestedModel, res, signal) {
  const hasTools = openaiTools && openaiTools.length > 0;
  const useNativeTools = hasTools && modeUsesNative();

  // prompt 模式：全量缓冲后解析合成 chunk（工具 JSON 块不能直接流给客户端）
  if (hasTools && !useNativeTools) {
    return promptModeStream(cloudbaseParams, openaiTools, requestedModel, res);
  }

  const params = { ...cloudbaseParams };
  if (useNativeTools) {
    params.tools = openaiTools;
    params.maxSteps = 1;
  }
  if (signal) params.signal = signal;

  try {
    const streamRes = await getModel().streamText(params);
    await pumpNativeStream(streamRes, requestedModel, res, hasTools);
  } catch (e) {
    if (useNativeTools && config.toolsMode === 'auto') {
      nativeDisabled = true;
      log(`native tool path failed (${e.message}); falling back to prompt mode`);
      return promptModeStream(cloudbaseParams, openaiTools, requestedModel, res);
    }
    throw toOpenAIError(e);
  }
}

async function pumpNativeStream(streamRes, requestedModel, res, hasTools) {
  const { buildChunk, sseWrite, genId, parseToolCallsFromText, dsmlHoldLen } = require('./convert');
  const meta = { id: genId('chatcmpl'), model: requestedModel };

  // 首个 chunk：role
  sseWrite(res, buildChunk({ ...meta, delta: { role: 'assistant', content: '' } }));

  let pending = ''; // 未下发的文本（含 DSML 前缀观察窗口 / 缓冲区）
  let bufferedMode = false; // 检测到泄漏的工具调用标记后，转为全量缓冲
  let fullText = ''; // 全量原始文本（结束时解析用）
  let sawToolCalls = false; // SDK 已给出结构化 tool_calls
  let finishReason = null;
  let chunkUsage = undefined;

  const emitContent = (t) => {
    if (t) sseWrite(res, buildChunk({ ...meta, delta: { content: t } }));
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
    // DSML 开标签（或 JSON 工具块）出现 → 之前的内容照发，之后转缓冲
    const dsmlIdx = pending.search(/<\/?[｜|]{0,2}\s*DSML/);
    const jsonIdx =
      pending.includes('```json') && pending.includes('"tool_calls"')
        ? pending.indexOf('```')
        : -1;
    const hit = dsmlIdx !== -1 && (jsonIdx === -1 || dsmlIdx < jsonIdx) ? dsmlIdx : jsonIdx;
    if (hit !== -1) {
      const safe = pending.slice(0, hit);
      emitContent(safe);
      bufferedMode = true;
      pending = '';
      return;
    }
    // 扣留可能是 "<｜｜DSML..." 前缀的尾巴，避免标记被拆包泄漏
    const hold = dsmlHoldLen(pending);
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
        sseWrite(res, buildChunk({ ...meta, delta: { tool_calls: d.tool_calls } }));
      }
      if (mapped.finishReason) finishReason = mapped.finishReason;
      if (typeof d.content === 'string' && d.content) feedContent(d.content);
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        sseWrite(res, buildChunk({ ...meta, delta: { reasoning_content: d.reasoning_content } }));
      }
    }
  } catch (e) {
    // 流中途出错：已写出的内容无法撤回，追加一段错误提示后正常收尾
    log(`stream error: ${e.message}`);
    feedContent(`\n\n[stream error: ${e.message}]`);
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

  let finalFinish = finishReason || (sawToolCalls ? 'tool_calls' : 'stop');

  if (bufferedMode && !sawToolCalls) {
    // 全量缓冲的文本里解析工具调用（DSML 或 fenced JSON）
    const parsed = parseToolCallsFromText(fullText);
    if (parsed && parsed.toolCalls.length > 0) {
      for (const [i, tc] of parsed.toolCalls.entries()) {
        sseWrite(
          res,
          buildChunk({
            ...meta,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                },
              ],
            },
          })
        );
      }
      finalFinish = 'tool_calls';
      log('converted leaked tool-call markup from stream into structured tool_calls');
    } else {
      // 解析失败：丢弃缓冲的标记乱码（其前的正常内容已下发），保持输出干净
      log(`buffered markup parse failed, dropped ${pending.length} chars`);
    }
  } else if (!bufferedMode && pending) {
    // 冲回扣留的观察窗口尾巴
    emitContent(pending);
    pending = '';
  }

  // 收尾 chunk：finish_reason + usage
  const last = buildChunk({ ...meta, delta: {}, finishReason: finalFinish, usage });
  sseWrite(res, last);
  res.write('data: [DONE]\n\n');
  res.end();
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

// 降级流式：非流式请求 + 手动合成 chunk
async function promptModeStream(cloudbaseParams, openaiTools, requestedModel, res) {
  const { buildChunk, sseWrite, genId } = require('./convert');
  const meta = { id: genId('chatcmpl'), model: requestedModel };

  const { raw } = await promptModeCompletion(cloudbaseParams, openaiTools, requestedModel);
  const message = raw.message;

  sseWrite(res, buildChunk({ ...meta, delta: { role: 'assistant', content: '' } }));

  if (message.content) {
    sseWrite(res, buildChunk({ ...meta, delta: { content: message.content } }));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [i, tc] of message.tool_calls.entries()) {
      sseWrite(
        res,
        buildChunk({
          ...meta,
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
              },
            ],
          },
        })
      );
    }
  }

  sseWrite(
    res,
    buildChunk({ ...meta, delta: {}, finishReason: raw.finishReason, usage: raw.usage })
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------------------------------------------------------------- 工具函数

function toOpenAIError(e) {
  if (e && e.openai) return e;
  const message = (e && e.message) || 'internal error';
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
  toOpenAIError,
};
