'use strict';

// OpenAI Responses API（POST /v1/responses）兼容层。
// 请求体 → Chat Completions 风格参数；内部结果 → Responses 响应对象 / SSE 事件。
// 上游调用仍然走 CloudBase SDK，与 /v1/chat/completions 共用同一套桥接逻辑。

const {
  genId,
  nowSec,
  mapModel,
  normalizeUsage,
  sanitizeMessages,
  openaiError,
} = require('./convert');

// ---------------------------------------------------------------- 输入转换

// function_call_output.output 可能是字符串、内容数组或任意 JSON
function stringifyOutput(output) {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  if (Array.isArray(output)) {
    return output
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.output === 'string') return p.output;
          if (typeof p.content === 'string') return p.content;
        }
        return JSON.stringify(p);
      })
      .join('');
  }
  return JSON.stringify(output);
}

// Responses 内容 parts → Chat Completions 内容 parts
function partToChatPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return null;
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return { type: 'text', text: typeof part.text === 'string' ? part.text : '' };
    case 'input_image': {
      const url =
        typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url && part.image_url.url;
      if (!url) return null;
      const imageUrl = { url };
      if (part.detail) imageUrl.detail = part.detail;
      return { type: 'image_url', image_url: imageUrl };
    }
    default:
      // input_file / refusal 等暂不支持
      return null;
  }
}

function contentToChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = content.map(partToChatPart).filter(Boolean);
  // 纯文本折叠成字符串：部分上游只接受 string 形式的 content
  if (parts.length === 0) return '';
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('');
  return parts;
}

function toFunctionCallItem(item) {
  const args =
    typeof item.arguments === 'string'
      ? item.arguments
      : JSON.stringify(item.arguments === undefined ? {} : item.arguments);
  return {
    id: item.call_id || item.id || genId('call'),
    type: 'function',
    function: { name: item.name || '', arguments: args },
  };
}

// Responses 的 input → Chat Completions messages（不含 instructions）。
// 相邻的 function_call 合并到同一条 assistant.tool_calls 里（Chat 协议要求）。
function inputToMessages(body) {
  const messages = [];

  const appendCall = (call) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant') {
      if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
      last.tool_calls.push(call);
      if (last.content === undefined) last.content = null;
      return;
    }
    messages.push({ role: 'assistant', content: null, tool_calls: [call] });
  };

  const pushMessage = (item) => {
    const role = item.role === 'developer' ? 'system' : item.role || 'user';
    messages.push({ role, content: contentToChatContent(item.content) });
  };

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        throw openaiError(
          'each item in "input" must be an object',
          'invalid_request_error',
          'invalid_input',
          400
        );
      }
      const type = item.type || (item.role ? 'message' : null);
      if (type === 'function_call') {
        appendCall(toFunctionCallItem(item));
        continue;
      }
      if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: stringifyOutput(item.output),
        });
        continue;
      }
      if (type === 'message') {
        pushMessage(item);
        continue;
      }
      // reasoning / web_search_call 等内置项没有 Chat 等价物，忽略
    }
  } else {
    throw openaiError(
      '"input" is required and must be a string or an array of input items',
      'invalid_request_error',
      'missing_input',
      400
    );
  }

  if (messages.length === 0) {
    throw openaiError(
      '"input" must contain at least one message',
      'invalid_request_error',
      'missing_input',
      400
    );
  }

  return sanitizeMessages(messages);
}

// 把 instructions 插到消息最前面。带 previous_response_id 时历史里已含上次的
// instructions（system），此刻若内容相同就不再重复注入，避免出现两条相同 system。
function withInstructions(messages, instructions) {
  if (typeof instructions !== 'string' || !instructions.trim()) return messages;
  const first = messages[0];
  if (first && first.role === 'system' && first.content === instructions) return messages;
  return sanitizeMessages([{ role: 'system', content: instructions }, ...messages]);
}

// ---------------------------------------------------------------- 多轮上下文存储
//
// Responses API 用 previous_response_id 串联对话（客户端只发增量 input）。
// 这里在进程内保存「上一次请求的完整 messages」，带上 TTL 与条数上限，
// 避免长时间运行导致内存无限增长。store:false 的请求不入库。

const PREVIOUS_TTL_MS = 30 * 60 * 1000;
const PREVIOUS_MAX = 100;
const previousResponses = new Map(); // responseId → { messages, response, expiresAt }

function prunePrevious(now = Date.now()) {
  for (const [id, entry] of previousResponses) {
    if (entry.expiresAt <= now) previousResponses.delete(id);
  }
  // Map 保持插入顺序：超上限时从最旧的开始淘汰
  while (previousResponses.size > PREVIOUS_MAX) {
    const oldest = previousResponses.keys().next().value;
    previousResponses.delete(oldest);
  }
}

function loadPrevious(responseId) {
  if (!responseId) return [];
  prunePrevious();
  const entry = previousResponses.get(responseId);
  if (!entry) {
    throw openaiError(
      `previous response not found: ${responseId}`,
      'invalid_request_error',
      'previous_response_not_found',
      404
    );
  }
  return entry.messages;
}

function savePrevious(responseId, messages, response) {
  if (!responseId) return;
  prunePrevious();
  // 重新 set 让该条目排到队尾（LRU 语义）
  previousResponses.delete(responseId);
  previousResponses.set(responseId, {
    messages,
    response: response || null,
    expiresAt: Date.now() + PREVIOUS_TTL_MS,
  });
  prunePrevious();
}

// GET /v1/responses/{id} 用：取回已存响应对象
function getStoredResponse(responseId) {
  prunePrevious();
  const entry = previousResponses.get(responseId);
  if (!entry || !entry.response) {
    throw openaiError(
      `response not found: ${responseId}`,
      'invalid_request_error',
      'response_not_found',
      404
    );
  }
  return entry.response;
}

function deleteStoredResponse(responseId) {
  prunePrevious();
  if (!previousResponses.delete(responseId)) {
    throw openaiError(
      `response not found: ${responseId}`,
      'invalid_request_error',
      'response_not_found',
      404
    );
  }
}

// 把本轮模型输出转成 chat 形状的 assistant 消息，供下一轮复用
function assistantMessageFromRaw(raw) {
  const message = { role: 'assistant', content: raw.message.content ?? '' };
  if (Array.isArray(raw.message.tool_calls) && raw.message.tool_calls.length > 0) {
    message.tool_calls = raw.message.tool_calls;
    if (message.content === '') message.content = null;
  }
  return message;
}

// ---------------------------------------------------------------- 工具转换

// Responses 的工具是扁平结构 { type:'function', name, description, parameters, strict }
// → Chat Completions 的 { type:'function', function:{...} }。
// web_search / file_search 等内置工具上游不支持，直接丢弃。
function fromResponsesTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const isFunction = t.type === 'function' || (!t.type && typeof t.name === 'string');
    if (!isFunction || typeof t.name !== 'string' || !t.name) continue;
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

function toChatToolChoice(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function' && typeof toolChoice.name === 'string') {
      return { type: 'function', function: { name: toolChoice.name } };
    }
    if (toolChoice.function && toolChoice.function.name) return toolChoice;
  }
  return undefined;
}

function toChatResponseFormat(format) {
  if (!format || typeof format !== 'object') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    const jsonSchema = {
      name: format.name || 'response',
      schema: format.schema || { type: 'object', properties: {} },
    };
    if (format.description) jsonSchema.description = format.description;
    if (format.strict !== undefined) jsonSchema.strict = format.strict;
    return { type: 'json_schema', json_schema: jsonSchema };
  }
  return undefined; // { type: 'text' } → 不传
}

// ---------------------------------------------------------------- 请求转换

// priorMessages：由 previous_response_id 取回的历史（可为空）
function toCloudbaseParamsFromResponses(body, config, priorMessages = []) {
  const current = inputToMessages(body);
  const messages = withInstructions([...priorMessages, ...current], body.instructions);

  const params = {
    model: mapModel(body.model, config),
    messages,
  };

  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.top_p !== undefined) params.top_p = body.top_p;
  if (body.user !== undefined) params.user = body.user;
  if (body.max_output_tokens !== undefined) params.max_tokens = body.max_output_tokens;

  if (
    body.reasoning &&
    typeof body.reasoning === 'object' &&
    typeof body.reasoning.effort === 'string'
  ) {
    params.reasoning_effort = body.reasoning.effort;
  }

  const responseFormat = toChatResponseFormat(body.text && body.text.format);
  if (responseFormat) params.response_format = responseFormat;

  const toolChoice = toChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) params.toolChoice = toolChoice;

  return params;
}

// ---------------------------------------------------------------- 响应构建

function buildUsage(usage) {
  const u = normalizeUsage(usage) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  return {
    input_tokens: u.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.total_tokens,
  };
}

function buildOutputItems(message) {
  const output = [];
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: genId('rs'),
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    });
  }
  if (typeof message.content === 'string' && message.content !== '') {
    output.push({
      type: 'message',
      id: genId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [], logprobs: [] }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc.function || {};
      output.push({
        type: 'function_call',
        id: genId('fc'),
        call_id: tc.id || genId('call'),
        name: fn.name || '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        status: 'completed',
      });
    }
  }
  return output;
}

function incompleteDetails(finishReason) {
  if (finishReason === 'length') return { reason: 'max_output_tokens' };
  if (finishReason === 'content_filter') return { reason: 'content_filter' };
  return null;
}

function buildResponseObject(raw, meta = {}) {
  const details = incompleteDetails(raw.finishReason);
  return {
    id: meta.id || genId('resp'),
    object: 'response',
    created_at: nowSec(),
    status: details ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: details,
    instructions: meta.instructions ?? null,
    max_output_tokens: meta.max_output_tokens ?? null,
    model: raw.model,
    output: buildOutputItems(raw.message),
    parallel_tool_calls: meta.parallel_tool_calls !== false,
    previous_response_id: meta.previous_response_id ?? null,
    reasoning: meta.reasoning || null,
    store: false,
    temperature: meta.temperature ?? null,
    text: meta.text || { format: { type: 'text' } },
    tool_choice: meta.tool_choice ?? 'auto',
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    top_p: meta.top_p ?? null,
    truncation: 'disabled',
    usage: buildUsage(raw.usage),
    user: meta.user ?? null,
    metadata: meta.metadata || {},
  };
}

// ---------------------------------------------------------------- 流式 SSE sink
//
// 事件顺序遵循 Responses API 规范：
//   response.created / response.in_progress
//   response.output_item.added + response.content_part.added
//   response.output_text.delta …
//   response.output_text.done / content_part.done / output_item.done
//   response.completed（或 response.incomplete / response.failed）
// 与 Chat Completions 不同，Responses 流末尾没有 data: [DONE] 哨兵。

function createResponsesSink(res, meta = {}) {
  const state = {
    responseId: meta.id || genId('resp'),
    createdAt: nowSec(),
    items: [], // 已开始输出的条目（按输出顺序）
    byIndex: new Map(), // tool_calls 增量 index → 条目
    message: null,
    reasoning: null,
    usage: null,
    error: null,
  };
  let seq = 0;

  function emit(type, payload) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
  }

  function snapshot(status, details) {
    return {
      id: state.responseId,
      object: 'response',
      created_at: state.createdAt,
      status,
      error: state.error
        ? { code: state.error.code || 'server_error', message: state.error.message }
        : null,
      incomplete_details: details || null,
      instructions: meta.instructions ?? null,
      max_output_tokens: meta.max_output_tokens ?? null,
      model: meta.model,
      output: state.items.filter((e) => e.done).map((e) => e.item),
      parallel_tool_calls: meta.parallel_tool_calls !== false,
      previous_response_id: meta.previous_response_id ?? null,
      reasoning: meta.reasoning || null,
      store: false,
      temperature: meta.temperature ?? null,
      text: meta.text || { format: { type: 'text' } },
      tool_choice: meta.tool_choice ?? 'auto',
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      top_p: meta.top_p ?? null,
      truncation: 'disabled',
      usage: state.usage || null,
      user: meta.user ?? null,
      metadata: meta.metadata || {},
    };
  }
  function addEntry(item) {
    const entry = { item, outputIndex: state.items.length, text: '', done: false };
    state.items.push(entry);
    return entry;
  }

  function ensureMessage() {
    if (state.message) return state.message;
    const entry = addEntry({
      type: 'message',
      id: genId('msg'),
      status: 'in_progress',
      role: 'assistant',
      content: [],
    });
    state.message = entry;
    emit('response.output_item.added', { output_index: entry.outputIndex, item: entry.item });
    emit('response.content_part.added', {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    });
    return entry;
  }

  function ensureReasoning() {
    if (state.reasoning) return state.reasoning;
    const entry = addEntry({ type: 'reasoning', id: genId('rs'), summary: [] });
    state.reasoning = entry;
    emit('response.output_item.added', { output_index: entry.outputIndex, item: entry.item });
    emit('response.reasoning_summary_part.added', {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    return entry;
  }

  function addCallEntry(entry) {
    if (entry.added) return;
    entry.added = true;
      // 必须把 byIndex 里的这个 entry 本身登记进 state.items：
      // 若改用 addEntry(item) 新建包装对象，arguments 会累积在原 entry.text 上，
      // 而 finishEntry 遍历的是新对象（text 恒为 ''），最终 completed.output
      // 里的 function_call.arguments 就是空串，客户端会报"参数缺失"。
      entry.outputIndex = state.items.length;
      state.items.push(entry);
    emit('response.output_item.added', { output_index: entry.outputIndex, item: entry.item });
  }

  function finishEntry(entry) {
    if (entry.done) return;
    entry.done = true;
    const item = entry.item;
    if (item.type === 'message') {
      item.status = 'completed';
      item.content = [{ type: 'output_text', text: entry.text, annotations: [], logprobs: [] }];
      emit('response.output_text.done', {
        item_id: item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        text: entry.text,
        logprobs: [],
      });
      emit('response.content_part.done', {
        item_id: item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        part: item.content[0],
      });
      emit('response.output_item.done', { output_index: entry.outputIndex, item });
      return;
    }
    if (item.type === 'reasoning') {
      const part = { type: 'summary_text', text: entry.text };
      item.summary = [part];
      emit('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: entry.outputIndex,
        summary_index: 0,
        text: entry.text,
      });
      emit('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: entry.outputIndex,
        summary_index: 0,
        part,
      });
      emit('response.output_item.done', { output_index: entry.outputIndex, item });
      return;
    }
    // function_call
    item.arguments = entry.text;
    item.status = 'completed';
    emit('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: entry.outputIndex,
      arguments: entry.text,
    });
    emit('response.output_item.done', { output_index: entry.outputIndex, item });
  }

  return {
    res,
    get responseId() {
      return state.responseId;
    },
    begin() {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      }
      res._sse = true;
      res._responsesSse = true;
      emit('response.created', { response: snapshot('in_progress', null) });
      emit('response.in_progress', { response: snapshot('in_progress', null) });
    },

    content(text) {
      if (!text) return;
      const entry = ensureMessage();
      entry.text += text;
      emit('response.output_text.delta', {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        delta: text,
        logprobs: [],
      });
    },

    reasoning(text) {
      if (!text) return;
      const entry = ensureReasoning();
      entry.text += text;
      emit('response.reasoning_summary_text.delta', {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        summary_index: 0,
        delta: text,
      });
    },

    // 与 Chat Completions 的 delta.tool_calls 同形状：{ index, id?, type?, function:{name?, arguments?} }
    toolCalls(list) {
      if (!Array.isArray(list)) return;
      for (const tc of list) {
        if (!tc) continue;
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const fn = tc.function || {};
        let entry = state.byIndex.get(index);
        if (!entry) {
          entry = {
            item: {
              type: 'function_call',
              id: genId('fc'),
              call_id: tc.id || genId('call'),
              name: fn.name || '',
              arguments: '',
              status: 'in_progress',
            },
            outputIndex: -1,
            text: '',
            added: false,
            done: false,
          };
          state.byIndex.set(index, entry);
        } else if (!entry.item.name && fn.name) {
          entry.item.name = fn.name;
        }
        if (!entry.added && entry.item.name) addCallEntry(entry);
        if (typeof fn.arguments === 'string' && fn.arguments) {
          if (!entry.added) addCallEntry(entry);
          entry.text += fn.arguments;
          emit('response.function_call_arguments.delta', {
            item_id: entry.item.id,
            output_index: entry.outputIndex,
            delta: fn.arguments,
          });
        }
      }
    },

    streamError(e) {
      const message = (e && e.message) || 'stream error';
      state.error = { message, code: (e && e.code) || 'server_error' };
      emit('error', { code: state.error.code, message, param: null });
    },

    end(payload = {}) {
      const details = incompleteDetails(payload.finishReason);
      for (const entry of state.items) finishEntry(entry);
      state.usage = buildUsage(payload.usage);
      const status = state.error ? 'failed' : details ? 'incomplete' : 'completed';
      const final = snapshot(status, details);
      state.final = final;
      if (state.error) emit('response.failed', { response: final });
      else if (details) emit('response.incomplete', { response: final });
      else emit('response.completed', { response: final });
      if (!res.writableEnded && !res.destroyed) res.end();
    },

    // 本轮最终响应对象（供 GET /v1/responses/{id} 检索）
    finalResponse() {
      return state.final || null;
    },

    // 本轮最终输出（chat 形状），供 previous_response_id 累积历史
    finalMessage() {
      if (state.error) return null;
      let content = '';
      const toolCalls = [];
      for (const entry of state.items) {
        if (entry.item.type === 'message') content += entry.text;
        if (entry.item.type === 'function_call') {
          toolCalls.push({
            id: entry.item.call_id,
            type: 'function',
            function: { name: entry.item.name, arguments: entry.text },
          });
        }
      }
      const message = { role: 'assistant', content: toolCalls.length > 0 ? content || null : content };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      return message;
    },
  };
}

// 累积 messages（历史 + 本轮输入 + 模型输出）供 previous_response_id 复用
function paramsWithAssistant(params, message) {
  return [...params.messages, message];
}

module.exports = {
  inputToMessages,
  withInstructions,
  loadPrevious,
  savePrevious,
  getStoredResponse,
  deleteStoredResponse,
  assistantMessageFromRaw,
  paramsWithAssistant,
  fromResponsesTools,
  toChatToolChoice,
  toChatResponseFormat,
  toCloudbaseParamsFromResponses,
  buildResponseObject,
  buildUsage,
  createResponsesSink,
};
