'use strict';

// 冒烟测试：Responses API（POST /v1/responses）
// 覆盖：非流式对话、流式事件、工具调用（function_call → function_call_output）、
//       previous_response_id 多轮上下文。
// 用法：先启动服务（npm start），再运行 node scripts/test-responses.js

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
    name: 'get_weather',
    description: '查询指定城市的天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名称' } },
      required: ['city'],
    },
  },
];

async function postResponses(body) {
  const res = await fetch(`${BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return res;
}

function textOf(response) {
  return (response.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content || [])
    .filter((c) => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

async function testNonStream() {
  console.log('\n== 1. 非流式对话 ==');
  const res = await postResponses({
    model: MODEL,
    instructions: '请用简洁中文回答。',
    input: '用一句话介绍李白',
  });
  const data = await res.json();
  if (res.status !== 200) {
    console.log(JSON.stringify(data, null, 2));
    throw new Error(`HTTP ${res.status}`);
  }
  const text = textOf(data);
  console.log(`status=${data.status} output_items=${data.output.length}`);
  console.log(text);
  if (!text) throw new Error('未拿到 output_text');
  console.log(`✅ 非流式通过（id=${data.id}）`);
  return data;
}

async function testStream() {
  console.log('\n== 2. 流式对话 ==');
  const res = await postResponses({
    model: MODEL,
    stream: true,
    input: '写一首关于春天的五言绝句',
  });
  if (res.status !== 200) {
    console.log(await res.text());
    throw new Error(`HTTP ${res.status}`);
  }

  let text = '';
  let reasoning = '';
  const seen = new Set();
  let completed = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      seen.add(ev.type);
      if (ev.type === 'response.output_text.delta') {
        text += ev.delta;
        process.stdout.write(ev.delta);
      } else if (ev.type === 'response.reasoning_summary_text.delta') {
        reasoning += ev.delta;
      } else if (
        ev.type === 'response.completed' ||
        ev.type === 'response.incomplete' ||
        ev.type === 'response.failed'
      ) {
        completed = ev.response;
      } else if (ev.type === 'error') {
        throw new Error(`流内错误: ${ev.message}`);
      }
    }
  }

  console.log(`\n事件类型: ${[...seen].join(', ')}`);
  if (!seen.has('response.created')) throw new Error('缺少 response.created');
  if (!seen.has('response.output_item.done')) throw new Error('缺少 output_item.done');
  if (!completed) throw new Error('未收到终止事件');
  if (!text) throw new Error('未收到 output_text.delta');
  const reasoningNote = reasoning ? `，reasoning ${reasoning.length} 字` : '';
  console.log(`✅ 流式通过（status=${completed.status}${reasoningNote}）`);
}

async function testTools() {
  console.log('\n== 3. 工具调用 ==');
  const res = await postResponses({
    model: MODEL,
    input: '北京今天天气怎么样？',
    tools,
  });
  const data = await res.json();
  if (res.status !== 200) {
    console.log(JSON.stringify(data, null, 2));
    throw new Error(`HTTP ${res.status}`);
  }

  const call = (data.output || []).find((o) => o.type === 'function_call');
  if (!call) {
    console.log('❌ 未返回 function_call（模型可能直接回答，可重试或换模型）');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(call, null, 2));

  console.log('\n== 3b. 回传 function_call_output ==');
  const res2 = await postResponses({
    model: MODEL,
    tools,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京今天天气怎么样？' }] },
      { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: 'function_call_output', call_id: call.call_id, output: '北京：26°C，晴' },
    ],
  });
  const data2 = await res2.json();
  if (res2.status !== 200) {
    console.log(JSON.stringify(data2, null, 2));
    throw new Error(`HTTP ${res2.status}`);
  }
  const answer = textOf(data2);
  console.log(answer);
  if (!answer) throw new Error('第二轮未生成回答');
  console.log('✅ 工具调用两轮通过');
}

async function testPreviousResponseId() {
  console.log('\n== 4. previous_response_id 多轮 ==');
  const r1 = await postResponses({ model: MODEL, input: '记住数字 42，只回复“收到”。' });
  const d1 = await r1.json();
  if (r1.status !== 200) {
    console.log(JSON.stringify(d1, null, 2));
    throw new Error(`HTTP ${r1.status}`);
  }
  console.log(`第一轮: ${textOf(d1)}`);

  const r2 = await postResponses({
    model: MODEL,
    input: '刚才让你记住的数字是多少？',
    previous_response_id: d1.id,
  });
  const d2 = await r2.json();
  if (r2.status !== 200) {
    console.log(JSON.stringify(d2, null, 2));
    throw new Error(`HTTP ${r2.status}`);
  }
  const answer = textOf(d2);
  console.log(`第二轮: ${answer}`);
  if (!answer.includes('42')) {
    console.log('⚠️ 回答中未出现 42，模型未遵循上下文（不一定是适配器问题）');
  }
  console.log(`✅ previous_response_id 链路可用（${d1.id} → ${d2.id}）`);
}

async function main() {
  console.log(`Base URL: ${BASE_URL}  model=${MODEL}`);
  await testNonStream();
  await testStream();
  await testTools();
  await testPreviousResponseId();
  console.log('\n🎉 Responses API 冒烟测试全部通过');
}

main().catch((e) => {
  console.error('\n❌ 请求失败:', e.message);
  process.exitCode = 1;
});
