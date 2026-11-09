'use strict';

// 冒烟测试：非流式 chat.completions
// 用法：先启动服务（npm start），再运行 node scripts/test-nonstream.js
// 可通过环境变量覆盖：BASE_URL / API_KEY / MODEL

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8090';
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || 'default';

async function main() {
  console.log(`POST ${BASE_URL}/v1/chat/completions (model=${MODEL}, stream=false)`);
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: '用一句话介绍李白' }],
    }),
  });

  console.log(`HTTP ${res.status}`);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));

  if (res.status === 200 && data.choices?.[0]?.message?.content) {
    console.log('\n--- 回答 ---');
    console.log(data.choices[0].message.content);
    console.log('✅ 非流式调用通过');
  } else {
    console.log('\n❌ 非流式调用失败（若为 401/配置类错误，请检查 .env 与 API_KEY）');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ 请求失败:', e.message);
  process.exitCode = 1;
});
