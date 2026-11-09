'use strict';

// 冒烟测试：流式 chat.completions（SSE），含 reasoning_content 透传展示
// 用法：先启动服务（npm start），再运行 node scripts/test-stream.js

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8090';
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'default';

async function main() {
  console.log(`POST ${BASE_URL}/v1/chat/completions (model=${MODEL}, stream=true)`);
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: '写一首关于春天的五言绝句' }],
    }),
  });

  console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
  if (!res.ok || !res.body) {
    console.log(await res.text());
    console.log('\n❌ 流式调用失败');
    process.exitCode = 1;
    return;
  }

  let content = '';
  let reasoning = '';
  let chunks = 0;
  let gotDone = false;

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
      const payload = line.slice(6);
      if (payload === '[DONE]') {
        gotDone = true;
        continue;
      }
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      chunks++;
      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        process.stdout.write(`[思] ${delta.reasoning_content}`);
      }
      if (delta.content) {
        content += delta.content;
        process.stdout.write(delta.content);
      }
      if (chunk.usage) {
        console.log(`\n[usage] ${JSON.stringify(chunk.usage)}`);
      }
    }
  }

  console.log(`\n\n--- 统计 ---`);
  console.log(`chunks=${chunks}, gotDone=${gotDone}`);
  if (reasoning) console.log(`reasoning(${reasoning.length} 字)已透传`);
  if (chunks > 0 && gotDone && content.length > 0) {
    console.log('✅ 流式调用通过');
  } else {
    console.log('❌ 流式调用未收到有效内容');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ 请求失败:', e.message);
  process.exitCode = 1;
});
