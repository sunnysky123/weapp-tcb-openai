'use strict';

// 冒烟测试：tool_calls 两轮对话
// 第一轮：agent 发送 tools 定义，期望模型返回 finish_reason=tool_calls + tool_calls
// 第二轮：把工具结果回传，期望模型生成最终回答
// 用法：先启动服务（npm start），再运行 node scripts/test-tools.js

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8090';
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'default';

const HEADERS = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的天气',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称' },
        },
        required: ['city'],
      },
    },
  },
];

async function chat(body) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log(`== 第一轮：携带 tools，询问天气 ==`);
  const messages = [{ role: 'user', content: '北京今天天气怎么样？' }];
  const r1 = await chat({ model: MODEL, messages, tools });

  if (r1.status !== 200) {
    console.log(JSON.stringify(r1.data, null, 2));
    console.log('❌ 第一轮请求失败');
    process.exitCode = 1;
    return;
  }

  const msg1 = r1.data.choices?.[0]?.message;
  const finish1 = r1.data.choices?.[0]?.finish_reason;
  console.log(`finish_reason=${finish1}`);
  console.log(JSON.stringify(msg1, null, 2));

  const toolCalls = msg1?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    console.log('❌ 第一轮未返回 tool_calls（模型可能直接回答了，可重试或换模型）');
    process.exitCode = 1;
    return;
  }

  console.log(`\n== 第二轮：回传工具结果 ==`);
  messages.push(msg1);
  for (const tc of toolCalls) {
    // 本地 agent 在这里真实执行工具；测试里返回固定值
    const result = `${tc.function.arguments.includes('北京') ? '北京' : tc.function.arguments}：26°C，晴`;
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: result,
    });
  }

  const r2 = await chat({ model: MODEL, messages, tools });
  if (r2.status !== 200) {
    console.log(JSON.stringify(r2.data, null, 2));
    console.log('❌ 第二轮请求失败');
    process.exitCode = 1;
    return;
  }

  const msg2 = r2.data.choices?.[0]?.message;
  console.log(JSON.stringify(msg2, null, 2));
  console.log('\n--- 最终回答 ---');
  console.log(msg2?.content || '(空)');

  if (msg2?.content) {
    console.log('\n✅ 工具调用两轮对话通过');
  } else {
    console.log('\n❌ 第二轮未生成回答');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ 请求失败:', e.message);
  process.exitCode = 1;
});
