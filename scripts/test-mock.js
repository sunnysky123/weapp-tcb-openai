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

  console.log(`\n🎉 端到端 mock 测试全部通过（共 ${passed} 组，TOOLS_MODE=${promptMode ? 'prompt' : 'auto/native'}）`);
  process.exit(0);
}

require('../src/server.js'); // 启动（同进程）
main().catch((e) => {
  console.error('❌ 测试失败:', e);
  process.exit(1);
});
