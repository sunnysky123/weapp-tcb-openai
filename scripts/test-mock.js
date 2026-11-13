'use strict';

// 离线端到端测试：用 mock 替换 @cloudbase/node-sdk，验证完整链路
// （HTTP 路由 → 鉴权 → 协议转换 → 工具桥接 → SSE 输出），无需真实凭证。
// 用法：node scripts/test-mock.js            → 原生模式（auto/native）
//       node scripts/test-mock.js --prompt   → 强制降级 prompt 模式
// （--prompt 参数写法跨平台，Windows cmd 不支持 "FOO=bar node ..." 前缀）

if (process.argv.includes('--prompt')) process.env.TOOLS_MODE = 'prompt';

process.env.TCB_ENV_ID = process.env.TCB_ENV_ID || 'mock-env';
process.env.PORT = process.env.PORT || '8092';
// 开启鉴权以覆盖鉴权路径（/health 豁免、未带 key 401 等）
const TEST_API_KEY = (process.env.API_KEY = process.env.API_KEY || 'mock-test-key');

// ---- 在加载任何业务代码前，hook require，替换 @cloudbase/node-sdk ----
const Module = require('module');
const origLoad = Module._load;
let nativeToolsRequests = 0; // 记录原生工具模式被使用的次数
let lastGenerateParams = null; // 记录最近一次 generateText 参数（system 合并断言用）
let lastStreamSignal = null; // 记录最近一次 streamText 收到的 abort signal（断开取消断言用）

const fakeModel = {
  // 模拟用户实际遇到的场景：模型把内部 DSML 函数调用标记当文本输出
  DSML_VIEW: String.raw`<｜｜DSML｜｜ functions>
<｜｜DSML｜｜ invoke name="view">
<｜｜DSML｜｜ parameter name="path" string="true">c:\Users\sunny\Downloads\Source\weapp-openai\package.json</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ functions>`,

  // fenced JSON 工具块按小分片吐出（开标签/字段名被拆散到多个 chunk）
  FENCED_JSON_PARTS: [
    '```',
    'json\n{"tool',
    '_calls":[{"name":"get_weather"',
    ',"arguments":{"city":"北京"}}]}',
    '\n```',
  ],

  // 识别适配器降级模式注入的工具协议 system 提示词
  isPromptMode(params) {
    return (params.messages || []).some(
      (m) => m && m.role === 'system' && String(m.content).includes('# Tool Calling Protocol')
    );
  },

  async generateText(params) {
    lastGenerateParams = params;
    if (this.isPromptMode(params)) {
      // 降级模式：按协议输出工具调用块（天气→JSON fence；分析→泄漏的 DSML 标记）
      const hasToolResult = params.messages.some((m) => m.role === 'tool');
      const userMsg = [...params.messages].reverse().find((m) => m.role === 'user');
      const wantsTool =
        userMsg &&
        (String(userMsg.content).includes('天气') || String(userMsg.content).includes('分析'));
      if (!hasToolResult && wantsTool) {
        const isView = userMsg && String(userMsg.content).includes('分析');
        return {
          text: isView
            ? this.DSML_VIEW
            : '```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}\n```',
          rawResponses: [],
          messages: params.messages,
          usage: { inputTokens: 12, outputTokens: 6 },
        };
      }
      const toolMsg = [...params.messages].reverse().find((m) => m.role === 'tool');
      const last = params.messages[params.messages.length - 1];
      return {
        text: toolMsg
          ? String(toolMsg.content).includes('26')
            ? '北京今天 26°C，晴，适合出行。'
            : 'mock: 分析完成，package.json 是 Node.js 项目的清单文件。'
          : `mock 回复: ${last && last.content}`,
        rawResponses: [],
        messages: params.messages,
        usage: { inputTokens: 12, outputTokens: 6 },
      };
    }

    if (Array.isArray(params.tools) && params.tools.length > 0) {
      nativeToolsRequests++;
      if (!params.maxSteps) throw new Error('mock: expected maxSteps=1 in native tool mode');
      const last = params.messages[params.messages.length - 1];
      const userMsg = [...params.messages].reverse().find((m) => m.role === 'user');
      // 第二轮：带 tool 结果回传 → 直接给最终回答
      if (last.role === 'tool') {
        return {
          text: String(last.content).includes('26')
            ? '北京今天 26°C，晴，适合出行。'
            : 'mock: 分析完成，package.json 是 Node.js 项目的清单文件。',
          rawResponses: [
            {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: String(last.content).includes('26')
                      ? '北京今天 26°C，晴，适合出行。'
                      : 'mock: 分析完成，package.json 是 Node.js 项目的清单文件。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            },
          ],
          messages: params.messages,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      }
      // 模拟 DSML 标记泄漏：模型把工具调用当文本输出
      if (userMsg && String(userMsg.content).includes('分析')) {
        return {
          text: this.DSML_VIEW,
          rawResponses: [
            {
              choices: [
                {
                  message: { role: 'assistant', content: this.DSML_VIEW },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
            },
          ],
          messages: params.messages,
          usage: { inputTokens: 30, outputTokens: 15 },
        };
      }
      // 第一轮：返回结构化 tool_calls，但 finish_reason 是 'stop'
      // （模拟实测：上游同时给 tool_calls + stop，适配器必须覆盖为 'tool_calls'）
      return {
        text: '',
        rawResponses: [
          {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_mock_1',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '{"city":"北京"}' },
                    },
                  ],
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ],
        messages: params.messages,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    // 普通对话
    const last = params.messages[params.messages.length - 1];
    return {
      text: `mock 回复: ${last && last.content}`,
      rawResponses: [
        {
          choices: [
            {
              message: { role: 'assistant', content: `mock 回复: ${last && last.content}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        },
      ],
      messages: params.messages,
      usage: { inputTokens: 3, outputTokens: 4 },
    };
  },

  async streamText(params) {
    const self = this;
    lastStreamSignal = params.signal || null;
    const userMsg = [...params.messages].reverse().find((m) => m.role === 'user');
    const wantsView = userMsg && String(userMsg.content).includes('分析');

    // 上游早期失败（如 429）：适配器应返回正确的 HTTP 状态码而非 200 + SSE
    if (userMsg && String(userMsg.content).includes('上游错误')) {
      throw new Error('mock upstream 429');
    }

    // 慢速输出（断开取消测试用）：客户端 abort 后停止生成
    if (userMsg && String(userMsg.content).includes('慢慢说')) {
      async function* slowStream() {
        for (const w of ['第一', '第二', '第三']) {
          if (params.signal && params.signal.aborted) throw new Error('mock aborted');
          yield { choices: [{ delta: { content: w } }] };
          await new Promise((r) => setTimeout(r, 120));
        }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      }
      return {
        dataStream: slowStream(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        messages: Promise.resolve(params.messages),
      };
    }

    // 流中途出错：已吐出一个 content chunk 后上游断掉
    if (userMsg && String(userMsg.content).includes('中途错误')) {
      async function* brokenStream() {
        yield { choices: [{ delta: { content: '答案' } }] };
        throw new Error('mock mid-stream boom');
      }
      return {
        dataStream: brokenStream(),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
        messages: Promise.resolve(params.messages),
      };
    }

    // 降级模式的流式：适配器会缓冲全文再合成 chunk
    const promptText = this.isPromptMode(params)
      ? wantsView
        ? this.DSML_VIEW
        : '```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}\n```'
      : null;

    async function* dataStream() {
      if (promptText) {
        yield { choices: [{ delta: { content: promptText } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        return;
      }
      if (Array.isArray(params.tools) && params.tools.length > 0) {
        nativeToolsRequests++;
        // 模拟 DSML 标记按小分片吐出（特殊标记被拆到多个 chunk 的拆包场景）
        if (wantsView) {
          const parts = self.DSML_VIEW.match(/[\s\S]{1,7}/g) || [];
          for (const p of parts) {
            yield { choices: [{ delta: { content: p } }] };
          }
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          return;
        }
        // 模拟 fenced JSON 工具块按小分片吐出（开标签被拆包的泄漏场景）
        if (userMsg && String(userMsg.content).includes('分片')) {
          for (const p of self.FENCED_JSON_PARTS) {
            yield { choices: [{ delta: { content: p } }] };
          }
          yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
          return;
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_mock_2', type: 'function', function: { name: 'get_weather', arguments: '' } },
                ],
              },
            },
          ],
        };
        yield {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"北京"}' } }] } }],
        };
        // 上游同时给 tool_calls + 'stop'：适配器必须覆盖为 'tool_calls'
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        return;
      }
      // 模拟 reasoning + content 分块输出
      yield { choices: [{ delta: { reasoning_content: '思考中…' } }] };
      yield { choices: [{ delta: { content: '你' } }] };
      yield { choices: [{ delta: { content: '好' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }

    const gen = dataStream();
    // 与真实 CloudBase SDK 一致：usage / messages 是 Promise
    return {
      dataStream: gen,
      usage: Promise.resolve({ inputTokens: 6, outputTokens: 2 }),
      messages: Promise.resolve(params.messages),
    };
  },
};

const fakeTcb = {
  init: () => ({
    ai: () => ({ createModel: () => fakeModel }),
  }),
};

Module._load = function (request, parent, isMain) {
  if (request === '@cloudbase/node-sdk') return fakeTcb;
  return origLoad.apply(this, arguments);
};

// ---- 启动真实 server 并测试 ----
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}`, ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

async function postResponses(body, headers = {}) {
  const res = await fetch(`${BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}`, ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

async function readSSE(res) {
  const text = await res.text();
  const frames = text
    .split('\n\n')
    .filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
    .map((f) => JSON.parse(f.slice(6)));
  // 标准 chunk 都带 choices；error 帧（流中途出错）没有，单独挑出来
  const chunks = frames.filter((o) => o.choices);
  const errorFrame = frames.find((o) => o.error) || null;
  return { chunks, gotDone: text.includes('data: [DONE]'), errorFrame, raw: text };
}

// Responses API 的 SSE：每帧形如 "event: <type>\ndata: <json>\n\n"
async function readResponsesSSE(res) {
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((f) => f.trim())
    .map((f) => {
      const line = f.split('\n').find((l) => l.startsWith('data: '));
      return line ? JSON.parse(line.slice(6)) : null;
    })
    .filter(Boolean);
  return { events, raw: text };
}

async function main() {
  await new Promise((r) => setTimeout(r, 300)); // 等 server 监听
  const assert = require('assert');
  const promptMode = process.env.TOOLS_MODE === 'prompt';
  let passed = 0;

  // 1. DSML 解析单元测试（用户实际遇到的泄漏样例）
  {
    const { parseToolCallsFromText } = require('../src/convert.js');
    const sample = `好的，我先读取文件。\n<｜｜DSML｜｜ functions>
<｜｜DSML｜｜ invoke name="view">
<｜｜DSML｜｜ parameter name="path" string="true">c:\\Users\\sunny\\Downloads\\Source\\weapp-openai\\package.json</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ functions>`;
    const p = parseToolCallsFromText(sample);
    assert.ok(p && p.toolCalls.length === 1, '应解析出 1 个工具调用');
    assert.strictEqual(p.toolCalls[0].function.name, 'view');
    assert.ok(p.toolCalls[0].function.arguments.includes('package.json'));
    assert.strictEqual(p.content, '好的，我先读取文件。');
    console.log('✅ 1. DSML 标记解析单元测试（含前导文本保留）');
    passed++;
  }

  // 2. 非流式普通对话
  {
    const res = await post({ model: 'hy3', messages: [{ role: 'user', content: '你好' }] });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.choices[0].message.content, 'mock 回复: 你好');
    assert.strictEqual(data.choices[0].finish_reason, 'stop');
    assert.strictEqual(data.usage.prompt_tokens, 3);
    assert.strictEqual(data.usage.total_tokens, 7);
    console.log('✅ 2. 非流式普通对话');
    passed++;
  }

  // 3. 流式普通对话（SSE + reasoning 透传 + usage 汇总）
  {
    const res = await post({ model: 'hy3', stream: true, messages: [{ role: 'user', content: '你好' }] });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));
    const { chunks, gotDone } = await readSSE(res);
    assert.ok(gotDone, '应收到 [DONE]');
    const contents = chunks.map((c) => c.choices[0].delta.content).filter(Boolean).join('');
    assert.strictEqual(contents, '你好');
    const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content).filter(Boolean).join('');
    assert.strictEqual(reasoning, '思考中…');
    const usageChunk = chunks.find((c) => c.usage);
    assert.ok(usageChunk && usageChunk.usage.prompt_tokens === 6, '应有 usage 汇总 chunk');
    const last = chunks[chunks.length - 1];
    assert.strictEqual(last.choices[0].finish_reason, 'stop');
    console.log('✅ 3. 流式对话（SSE/reasoning/usage/DONE）');
    passed++;
  }

  // 4. 工具调用两轮对话（非流式）：第一轮返回 tool_calls
  {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ];
    const res = await post({
      model: 'hy3',
      messages: [{ role: 'user', content: '北京天气？' }],
      tools,
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.choices[0].finish_reason, 'tool_calls');
    const tc = data.choices[0].message.tool_calls[0];
    assert.strictEqual(tc.function.name, 'get_weather');
    assert.deepStrictEqual(JSON.parse(tc.function.arguments), { city: '北京' });
    assert.ok(data.usage.prompt_tokens > 0);
    assert.ok(!JSON.stringify(data).includes('_index'), '非流式响应不应泄漏内部字段 _index');

    // 第二轮（与上一轮构成同一用例）：回传 tool 结果
    const messages = [
      { role: 'user', content: '北京天气？' },
      data.choices[0].message,
      { role: 'tool', tool_call_id: tc.id, content: '北京：26°C，晴' },
    ];
    const res2 = await post({ model: 'hy3', messages, tools });
    const data2 = await res2.json();
    if (process.env.DEBUG_MOCK) console.log('DEBUG round2:', JSON.stringify(data2, null, 2));
    assert.strictEqual(data2.choices[0].message.content.includes('26°C'), true);
    assert.strictEqual(data2.choices[0].finish_reason, 'stop');
    console.log('✅ 4. 工具调用两轮对话（tool_calls → tool 结果 → 最终回答）');
    passed++;
  }

  // 5. 流式工具调用：tool_calls 分片
  {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ];
    const res = await post({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '北京天气？' }],
      tools,
    });
    const { chunks, gotDone } = await readSSE(res);
    assert.ok(gotDone);
    const toolChunks = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
    assert.ok(toolChunks.length >= (promptMode ? 1 : 2), '应有 tool_calls delta');
    const args = toolChunks.map((t) => (t.function ? t.function.arguments : '')).join('');
    assert.deepStrictEqual(JSON.parse(args), { city: '北京' });
    const last = chunks[chunks.length - 1];
    assert.strictEqual(last.choices[0].finish_reason, 'tool_calls');
    console.log('✅ 5. 流式工具调用（tool_calls delta 分片 + finish_reason）');
    passed++;
  }

  // 6. 模式路径检查：原生模式确实被使用（mock 记录到 tools+maxSteps 请求）
  if (promptMode) {
    console.log('✅ 6. 降级 prompt 模式全程生效（未走原生路径）');
  } else {
    assert.ok(nativeToolsRequests >= 3, `原生工具路径应被使用，实际 ${nativeToolsRequests} 次`);
    console.log(`✅ 6. 原生工具路径生效（${nativeToolsRequests} 次请求携带 tools+maxSteps=1）`);
  }
  passed++;

  // 7. DSML 泄漏场景（非流式）：模型把工具调用当文本输出 → 适配器兜回 tool_calls
  {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'view',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ];
    const res = await post({
      model: 'hy3',
      messages: [{ role: 'user', content: '帮我分析下当前的项目是做什么的' }],
      tools,
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.choices[0].finish_reason, 'tool_calls');
    const tc = data.choices[0].message.tool_calls[0];
    assert.strictEqual(tc.function.name, 'view');
    const args = JSON.parse(tc.function.arguments);
    assert.ok(args.path.endsWith('package.json'), `path 应指向 package.json，实际 ${args.path}`);
    assert.ok(
      !JSON.stringify(data).includes('DSML'),
      '响应中不应残留 DSML 标记'
    );
    // 第二轮：回传读取到的文件内容
    const messages = [
      { role: 'user', content: '帮我分析下当前的项目是做什么的' },
      data.choices[0].message,
      { role: 'tool', tool_call_id: tc.id, content: '{"name":"cloudbase-openai-adapter"}' },
    ];
    const res2 = await post({ model: 'hy3', messages, tools });
    const data2 = await res2.json();
    assert.ok(data2.choices[0].message.content.includes('package.json'));
    console.log('✅ 7. DSML 泄漏兜回（非流式，文本 → 结构化 tool_calls → 二轮回答）');
    passed++;
  }

  // 8. DSML 泄漏场景（流式，标记被拆到多个 chunk）→ 扣留缓冲 + 兜回
  {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'view',
          description: '读取文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ];
    const res = await post({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '帮我分析下当前的项目是做什么的' }],
      tools,
    });
    const { chunks, gotDone } = await readSSE(res);
    assert.ok(gotDone);
    const contentAll = chunks.map((c) => c.choices[0].delta.content || '').join('');
    assert.ok(!contentAll.includes('DSML'), '流式 content 中不应出现 DSML 标记');
    const toolChunks = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
    assert.ok(toolChunks.length >= 1, '应有 tool_calls delta');
    const args = JSON.parse(toolChunks.map((t) => (t.function ? t.function.arguments : '')).join(''));
    assert.ok(args.path.endsWith('package.json'));
    const last = chunks[chunks.length - 1];
    assert.strictEqual(last.choices[0].finish_reason, 'tool_calls');
    console.log('✅ 8. DSML 泄漏兜回（流式拆包分片，无标记泄漏 + tool_calls 合成）');
    passed++;
  }

  const weatherTool = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };

  // 9. fenced JSON 工具块分片流式：开标签/字段名被拆到多个 chunk 也不得泄漏（P0-3）
  {
    const res = await post({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '北京天气？分片输出' }],
      tools: [weatherTool],
    });
    const { chunks, gotDone } = await readSSE(res);
    assert.ok(gotDone);
    const contentAll = chunks.map((c) => c.choices[0].delta.content || '').join('');
    assert.ok(!contentAll.includes('```'), 'fence 开标签不得泄漏给客户端');
    assert.ok(!contentAll.includes('tool_calls'), '工具块 JSON 不得混进 content');
    const toolChunks = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []);
    assert.ok(toolChunks.length >= 1, '应有 tool_calls delta');
    assert.deepStrictEqual(
      JSON.parse(toolChunks.map((t) => (t.function ? t.function.arguments : '')).join('')),
      { city: '北京' }
    );
    assert.strictEqual(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
    console.log('✅ 9. fenced JSON 分片流式不泄漏（开标签扣留 → tool_calls 合成）');
    passed++;
  }

  // 10. finish_reason 覆盖：tool_calls + 上游 'stop' → 必须修正为 'tool_calls'（P1-5）
  {
    const { resolveFinishReason } = require('../src/convert.js');
    assert.strictEqual(resolveFinishReason('stop', true), 'tool_calls');
    assert.strictEqual(resolveFinishReason(null, true), 'tool_calls');
    assert.strictEqual(resolveFinishReason('length', true), 'length'); // 截断原因保留
    assert.strictEqual(resolveFinishReason('stop', false), 'stop');
    // 端到端覆盖：用例 4/5 的 mock 上游即返回 finish_reason: 'stop' + 结构化 tool_calls
    console.log('✅ 10. finish_reason 覆盖（单元 + 用例4/5 端到端，length 等原因不被误改）');
    passed++;
  }

  // 11. 流式上游早期报错 → 正确状态码的 JSON 错误（而非 200 + SSE 裸 JSON）（P0-2）
  {
    const res = await post({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '上游错误' }],
    });
    assert.strictEqual(res.status, 502);
    assert.ok(
      (res.headers.get('content-type') || '').includes('application/json'),
      '早期报错应是 JSON 错误响应，而非 text/event-stream'
    );
    const data = await res.json();
    assert.strictEqual(data.error.code, 'upstream_error');
    console.log('✅ 11. 流式上游早期报错返回 502 JSON（writeHead 时机修正）');
    passed++;
  }

  // 12. 流中途出错：错误不得混入 content，以独立 error 帧收尾（P2/P0-2）
  {
    const res = await post({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'user', content: '中途错误' }],
    });
    assert.strictEqual(res.status, 200);
    const { chunks, gotDone, errorFrame } = await readSSE(res);
    assert.ok(gotDone);
    const contentAll = chunks.map((c) => c.choices[0].delta.content || '').join('');
    assert.strictEqual(contentAll, '答案');
    assert.ok(!contentAll.includes('[stream error'), '错误文本不得混入 content');
    assert.ok(errorFrame, '应以独立 error 帧告知客户端');
    console.log('✅ 12. 流中途错误以 error 帧收尾（不污染正文）');
    passed++;
  }

  // 13. 客户端断开 → 上游 abort 取消生成（P0-1）
  {
    const ac = new AbortController();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({
        model: 'hy3',
        stream: true,
        messages: [{ role: 'user', content: '慢慢说' }],
      }),
      signal: ac.signal,
    });
    assert.strictEqual(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // 收到首个 SSE chunk
    ac.abort(); // 模拟客户端断开
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(lastStreamSignal, 'abort signal 应已传入上游');
    assert.strictEqual(lastStreamSignal.aborted, true, '客户端断开后应 abort 上游生成');
    try {
      await reader.cancel();
    } catch {
      // 连接已断，忽略
    }
    console.log('✅ 13. 客户端断开 → 上游 abort 生效（res close 侧挂载）');
    passed++;
  }

  // 14. 超限请求体 → 413 JSON（而非 ECONNRESET）（P2）
  {
    const big = 'x'.repeat(21 * 1024 * 1024);
    const res = await post({ model: 'hy3', messages: [{ role: 'user', content: big }] });
    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error.code, 'body_too_large');
    console.log('✅ 14. 超限请求体返回 413 JSON（先回包后 drain）');
    passed++;
  }

  // 15. /health 豁免鉴权，其余路由未授权仍 401（P2）
  {
    const health = await fetch(`${BASE}/health`);
    assert.strictEqual(health.status, 200, '/health 不应要求鉴权');
    const models = await fetch(`${BASE}/v1/models`);
    assert.strictEqual(models.status, 401, '未带 key 访问 /v1/models 应 401');
    console.log('✅ 15. /health 豁免鉴权（探活可用），其余路由仍 401 保护');
    passed++;
  }

  // 16. CORS 预检：OPTIONS 不鉴权、返回 CORS 头（P2）
  {
    const opt = await fetch(`${BASE}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.strictEqual(opt.status, 204);
    assert.strictEqual(opt.headers.get('access-control-allow-origin'), '*');
    assert.ok((opt.headers.get('access-control-allow-headers') || '').includes('Authorization'));
    console.log('✅ 16. OPTIONS 预检放行并返回 CORS 头');
    passed++;
  }

  // 17. 降级模式 system 合并：客户端自带 system 时不产生两条 system（P2）
  {
    await post({
      model: 'hy3',
      messages: [
        { role: 'system', content: '你是测试助手' },
        { role: 'user', content: '北京天气？' },
      ],
      tools: [weatherTool],
    });
    const msgs = (lastGenerateParams && lastGenerateParams.messages) || [];
    const systems = msgs.filter((m) => m.role === 'system');
    assert.strictEqual(systems.length, 1, '应只有一条 system 消息（合并而非追加）');
    if (promptMode) {
      assert.ok(systems[0].content.includes('# Tool Calling Protocol'), '工具协议应注入');
      assert.ok(systems[0].content.includes('你是测试助手'), '客户端 system 应被合并保留');
    } else {
      assert.strictEqual(systems[0].content, '你是测试助手', '原生模式不应注入协议提示词');
    }
    console.log(`✅ 17. system 消息合并（${promptMode ? '协议 + 客户端内容合一' : '原生模式透传'}）`);
    passed++;
  }

  // 18. Responses API：非流式普通对话
  {
    const res = await postResponses({
      model: 'default',
      instructions: '你是测试助手',
      input: '你好',
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.object, 'response');
    assert.strictEqual(data.status, 'completed');
    assert.strictEqual(data.instructions, '你是测试助手');
    const msgItem = data.output.find((o) => o.type === 'message');
    assert.ok(msgItem, '应有 message 输出项');
    assert.strictEqual(msgItem.role, 'assistant');
    assert.strictEqual(msgItem.content[0].type, 'output_text');
    assert.strictEqual(msgItem.content[0].text, 'mock 回复: 你好');
    assert.strictEqual(data.usage.input_tokens, 3);
    assert.strictEqual(data.usage.output_tokens, 4);
    assert.strictEqual(data.usage.total_tokens, 7);
    console.log('✅ 18. Responses 非流式对话（instructions → system，output_text）');
    passed++;
  }

  // 19. Responses API：流式普通对话（事件顺序 + delta 累积）
  {
    const res = await postResponses({ model: 'default', stream: true, input: '你好' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));
    const { events } = await readResponsesSSE(res);
    const types = events.map((e) => e.type);
    assert.strictEqual(types[0], 'response.created');
    assert.ok(types.includes('response.in_progress'));
    assert.ok(types.includes('response.output_item.added'));
    assert.ok(types.includes('response.content_part.added'));
    assert.ok(types.includes('response.output_text.delta'));
    assert.ok(types.includes('response.output_text.done'));
    assert.ok(types.includes('response.content_part.done'));
    assert.ok(types.includes('response.output_item.done'));
    assert.strictEqual(types[types.length - 1], 'response.completed', '最后应是 completed');
    const text = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    assert.strictEqual(text, '你好');
    // reasoning 也应以 reasoning_summary 事件暴露
    const reasoning = events
      .filter((e) => e.type === 'response.reasoning_summary_text.delta')
      .map((e) => e.delta)
      .join('');
    assert.strictEqual(reasoning, '思考中…');
    // sequence_number 单调递增
    const seqs = events.map((e) => e.sequence_number);
    assert.deepStrictEqual(seqs, seqs.map((_, i) => i), 'sequence_number 应从 0 递增');
    const done = events[events.length - 1];
    assert.strictEqual(done.response.usage.input_tokens, 6);
    assert.strictEqual(done.response.usage.output_tokens, 2);
    assert.strictEqual(done.response.usage.total_tokens, 8);
    const doneMsg = done.response.output.find((o) => o.type === 'message');
    assert.strictEqual(doneMsg.content[0].text, '你好');
    assert.ok(!res.headers.get('content-type').includes('json'));
    console.log('✅ 19. Responses 流式对话（事件序列/sequence_number/usage/无 DONE 哨兵）');
    passed++;
  }

  // 20. Responses API：工具调用非流式（function_call 输出项）→ 第二轮回传 function_call_output
  {
    const tools = [
      {
        type: 'function',
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ];
    const res = await postResponses({
      model: 'default',
      input: '北京天气？',
      tools,
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    const call = data.output.find((o) => o.type === 'function_call');
    assert.ok(call, '应有 function_call 输出项');
    assert.strictEqual(call.name, 'get_weather');
    assert.strictEqual(call.status, 'completed');
    assert.deepStrictEqual(JSON.parse(call.arguments), { city: '北京' });
    assert.ok(call.call_id, '应有 call_id 供回传');

    // 第二轮：Responses 原生形状回传工具结果
    const res2 = await postResponses({
      model: 'default',
      tools,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京天气？' }] },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '北京：26°C，晴' },
      ],
    });
    const data2 = await res2.json();
    assert.strictEqual(res2.status, 200);
    const msgItem = data2.output.find((o) => o.type === 'message');
    assert.ok(msgItem.content[0].text.includes('26°C'), '第二轮应给出最终回答');
    console.log('✅ 20. Responses 工具调用两轮（function_call ↔ function_call_output）');
    passed++;
  }

  // 21. Responses API：流式工具调用（function_call_arguments delta + response.completed）
  {
    const tools = [
      {
        type: 'function',
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ];
    const res = await postResponses({
      model: 'default',
      stream: true,
      input: '北京天气？',
      tools,
    });
    const { events } = await readResponsesSSE(res);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('response.function_call_arguments.delta'), '应有参数增量事件');
    assert.ok(types.includes('response.function_call_arguments.done'));
    const argDeltas = events
      .filter((e) => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.delta)
      .join('');
    assert.deepStrictEqual(JSON.parse(argDeltas), { city: '北京' });
    assert.strictEqual(types[types.length - 1], 'response.completed');
    const call = events[events.length - 1].response.output.find((o) => o.type === 'function_call');
    assert.ok(call, 'completed 响应里应含 function_call');
    assert.strictEqual(call.name, 'get_weather');
    assert.strictEqual(call.status, 'completed');
    console.log('✅ 21. Responses 流式工具调用（arguments delta → function_call 条目）');
    passed++;
  }

  // 22. Responses API：请求体错误与内容转换
  {
    const { inputToMessages, withInstructions, fromResponsesTools } = require('../src/responses.js');
    const msgs = inputToMessages({
      input: [
        { role: 'developer', content: 'dev' },
        { role: 'user', content: [{ type: 'input_text', text: '看图' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
        { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
        { type: 'function_call', call_id: 'call_2', name: 'g', arguments: { b: 2 } },
        { type: 'function_call_output', call_id: 'call_1', output: { ok: true } },
        { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'output_text', text: 'done' }] },
      ],
    });
    assert.strictEqual(msgs[0].role, 'system', 'developer 应映射为 system');
    assert.ok(Array.isArray(msgs[1].content), '多模态内容应保留 parts');
    assert.strictEqual(msgs[1].content[1].type, 'image_url');
    // 相邻 function_call 合并进同一条 assistant
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.strictEqual(msgs[2].tool_calls.length, 2);
    assert.strictEqual(msgs[2].tool_calls[1].function.arguments, '{"b":2}');
    assert.strictEqual(msgs[3].role, 'tool');
    assert.strictEqual(msgs[3].content, '{"ok":true}');
    assert.strictEqual(msgs[4].content, 'done');

    // instructions 作为最前面的 system
    const withSys = withInstructions(msgs, 'sys');
    assert.strictEqual(withSys.length, msgs.length + 1);
    assert.strictEqual(withSys[0].role, 'system');
    assert.strictEqual(withSys[0].content, 'sys');

    // 内置工具（web_search）应被丢弃，只保留扁平 function 工具
    assert.strictEqual(fromResponsesTools([{ type: 'web_search' }, { type: 'function', name: 'f', parameters: {} }]).length, 1);

    const bad = await postResponses({ model: 'default' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).error.code, 'missing_input');
    console.log('✅ 22. Responses 请求转换（developer→system / 多模态 / call 合并 / 缺省 400）');
    passed++;
  }

  // 23. Responses API：previous_response_id 多轮上下文
  {
    const r1 = await postResponses({ model: 'default', input: '第一问' });
    const d1 = await r1.json();
    assert.ok(d1.id, '第一轮应有 response id');

    const r2 = await postResponses({
      model: 'default',
      input: '第二问',
      previous_response_id: d1.id,
    });
    const d2 = await r2.json();
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(d2.previous_response_id, d1.id);
    // 上游应收到合并后的历史：用户第一问 + assistant 第一答 + 用户第二问
    const msgs = lastGenerateParams.messages;
    assert.strictEqual(msgs.length, 3, `历史应合并为 3 条，实际 ${msgs.length}`);
    assert.strictEqual(msgs[0].content, '第一问');
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.strictEqual(msgs[1].content, 'mock 回复: 第一问');
    assert.strictEqual(msgs[2].content, '第二问');

    // 未知 id → 404
    const bad = await postResponses({ model: 'default', input: 'x', previous_response_id: 'resp_nope' });
    assert.strictEqual(bad.status, 404);
    assert.strictEqual((await bad.json()).error.code, 'previous_response_not_found');
    console.log('✅ 23. previous_response_id 多轮上下文（历史合并 / 未知 id 404）');
    passed++;
  }

  // 24. Responses API：流式 + 工具调用后 previous_response_id 也带上 tool_calls 历史
  {
    const tools = [
      { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    ];
    const r1 = await postResponses({ model: 'default', stream: true, input: '北京天气？', tools });
    const { events } = await readResponsesSSE(r1);
    const completed = events[events.length - 1].response;
    const call = completed.output.find((o) => o.type === 'function_call');
    assert.ok(call);

    await postResponses({
      model: 'default',
      input: [
        { type: 'function_call_output', call_id: call.call_id, output: '北京：26°C，晴' },
      ],
      previous_response_id: completed.id,
      tools,
    });
    const msgs = lastGenerateParams.messages;
    const assistantMsg = msgs.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, '历史里应有 assistant 消息');
    assert.strictEqual(assistantMsg.tool_calls[0].id, call.call_id, 'tool_calls 应保留 call_id');
    assert.strictEqual(msgs[msgs.length - 1].role, 'tool');
    console.log('✅ 24. 流式工具轮 + previous_response_id（assistant tool_calls 历史保留）');
    passed++;
  }

  // 25. Responses API：上游早期报错 → JSON 502（而非 200 + SSE）
  {
    const res = await postResponses({
      model: 'default',
      stream: true,
      input: '上游错误',
    });
    assert.strictEqual(res.status, 502);
    assert.ok((res.headers.get('content-type') || '').includes('application/json'));
    assert.strictEqual((await res.json()).error.code, 'upstream_error');
    console.log('✅ 25. Responses 流式早期报错返回 502 JSON');
    passed++;
  }

  // 26. Responses API：流中途出错 → error 事件 + response.failed 收尾
  {
    const res = await postResponses({
      model: 'default',
      stream: true,
      input: '中途错误',
    });
    assert.strictEqual(res.status, 200);
    const { events } = await readResponsesSSE(res);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('error'), '应有 error 事件');
    assert.strictEqual(types[types.length - 1], 'response.failed', '最后应是 failed');
    const failed = events[events.length - 1].response;
    assert.strictEqual(failed.status, 'failed');
    assert.ok(failed.error && failed.error.message, 'failed 响应应带 error');
    const text = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    assert.strictEqual(text, '答案', '错误信息不得混进正文');
    console.log('✅ 26. Responses 流中途错误 → error 事件 + response.failed');
    passed++;
  }

  // 27. finish_reason=length → response.incomplete + max_output_tokens
  {
    const { buildResponseObject } = require('../src/responses.js');
    const obj = buildResponseObject(
      { model: 'm', message: { role: 'assistant', content: '半句' }, finishReason: 'length' },
      { model: 'm' }
    );
    assert.strictEqual(obj.status, 'incomplete');
    assert.deepStrictEqual(obj.incomplete_details, { reason: 'max_output_tokens' });
    console.log('✅ 27. 截断响应映射为 response.incomplete');
    passed++;
  }

  // 28. Responses API：GET / DELETE /v1/responses/{id}
  {
    const r1 = await postResponses({ model: 'default', input: '可检索的一轮' });
    const d1 = await r1.json();

    const got = await fetch(`${BASE}/v1/responses/${d1.id}`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(got.status, 200);
    const stored = await got.json();
    assert.strictEqual(stored.id, d1.id);
    assert.strictEqual(stored.object, 'response');
    assert.strictEqual(stored.output[0].content[0].text, 'mock 回复: 可检索的一轮');

    const del = await fetch(`${BASE}/v1/responses/${d1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(await del.json(), {
      id: d1.id,
      object: 'response.deleted',
      deleted: true,
    });

    const gone = await fetch(`${BASE}/v1/responses/${d1.id}`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(gone.status, 404);
    assert.strictEqual((await gone.json()).error.code, 'response_not_found');
    console.log('✅ 28. GET/DELETE /v1/responses/:id（检索 / 删除 / 404）');
    passed++;
  }

  // 29. store:false 不写入检索存储
  {
    const r1 = await postResponses({ model: 'default', input: '不存', store: false });
    const d1 = await r1.json();
    const got = await fetch(`${BASE}/v1/responses/${d1.id}`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.strictEqual(got.status, 404);
    console.log('✅ 29. store:false 不进入进程内存储');
    passed++;
  }

  // 30. Responses 流中途出现未捕获异常 → error 事件收尾（不写 Chat 风格 [DONE]）
  {
    const hit = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
      body: JSON.stringify({ model: 'default', stream: true, input: '中途错误' }),
    });
    const raw = await hit.text();
    assert.ok(!raw.includes('[DONE]'), 'Responses 流不应出现 [DONE] 哨兵');
    assert.ok(raw.includes('event: error') || raw.includes('response.failed'));
    console.log('✅ 30. Responses 流错误收尾（无 [DONE]，走 error/response.failed）');
    passed++;
  }

  // 31. arguments 归一化：空串/null/对象 都不能变成"参数为空"
  {
    const { normalizeToolArguments, sanitizeMessages } = require('../src/convert.js');
    assert.strictEqual(normalizeToolArguments(''), '{}', '空串应补成 {}');
    assert.strictEqual(normalizeToolArguments(null), '{}');
    assert.strictEqual(normalizeToolArguments(undefined), '{}');
    assert.strictEqual(normalizeToolArguments({ title: '甲' }), '{"title":"甲"}');
    assert.strictEqual(normalizeToolArguments('{"a":1}'), '{"a":1}', '已是字符串应原样保留');

    // 客户端把 arguments 作为对象回传时，必须转成字符串再交给上游
    const msgs = sanitizeMessages([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    assert.strictEqual(typeof msgs[1].tool_calls[0].function.arguments, 'string');
    assert.strictEqual(msgs[1].tool_calls[0].function.arguments, '{"a":1}');
    console.log('✅ 31. arguments 归一化（空串/对象 → JSON 字符串，不再"参数为空"）');
    passed++;
  }

  // 32. 请求级 4xx 不得触发全局降级（否则后续请求被迫走 prompt 模式丢参数）
  {
    const { isDegradableError } = require('../src/cloudbase.js');
    const mk = (code) => ({ message: 'x', code: String(code) });
    assert.strictEqual(isDegradableError(mk(400)), false, '400 是请求错误，不应降级');
    assert.strictEqual(isDegradableError(mk(404)), false);
    assert.strictEqual(isDegradableError(mk(422)), false);
    assert.strictEqual(isDegradableError(mk(429)), true, '限流可以重试降级');
    assert.strictEqual(isDegradableError(mk(502)), true);
    assert.strictEqual(isDegradableError(mk(503)), true);
    assert.strictEqual(isDegradableError(new Error('socket hang up')), true, '网络错误允许降级');
    console.log('✅ 32. 4xx 不再全局降级（429/5xx/网络错误仍降级）');
    passed++;
  }

  console.log(`\n🎉 端到端 mock 测试全部通过（共 ${passed} 组，TOOLS_MODE=${promptMode ? 'prompt' : 'auto/native'}）`);
  process.exit(0);
}

require('../src/server.js'); // 启动（同进程）
main().catch((e) => {
  console.error('❌ 测试失败:', e);
  process.exit(1);
});
