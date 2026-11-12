'use strict';

const http = require('http');
const { config, logConfig } = require('./config');
const {
  toCloudbaseParams,
  fromOpenAITools,
  buildCompletionResponse,
  mapModel,
  openaiError,
  nowSec,
} = require('./convert');
const cb = require('./cloudbase');

// ---------------------------------------------------------------- 请求体解析

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          // 立即抛给调用方回 413；不 req.destroy()，否则客户端只会看到
          // ECONNRESET 而拿不到 413
          reject(
            openaiError('request body too large', 'invalid_request_error', 'body_too_large', 413)
          );
        }
        // 继续吸收（丢弃）剩余请求体，让连接正常收尾、响应能送达
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) {
    throw openaiError('request body is empty', 'invalid_request_error', 'empty_body', 400);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw openaiError('request body is not valid JSON', 'invalid_request_error', 'invalid_json', 400);
  }
}

// ---------------------------------------------------------------- 鉴权

function checkAuth(req) {
  if (!config.apiKey) return; // 未设置 API_KEY 时不鉴权
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m || m[1] !== config.apiKey) {
    throw openaiError(
      'Invalid API key. Set "Authorization: Bearer <API_KEY>" matching the API_KEY configured on the adapter.',
      'authentication_error',
      'invalid_api_key',
      401
    );
  }
}

// ---------------------------------------------------------------- 错误响应

function sendError(res, e) {
  if (res.writableEnded || res.destroyed) return; // 响应已结束/连接已断：不再写
  const payload = e && e.openai ? e.openai : { error: { message: 'internal error', type: 'api_error', code: null } };
  const status = (e && e.status) || 500;
  if (res.headersSent) {
    // 响应头已发出（SSE 已开始）：状态码改不了，以 error 帧收尾，避免裸 JSON 混进事件流
    if (res._sse) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.end(JSON.stringify(payload));
    }
  } else {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
  if (config.debug && e && !e.openai) console.error(e);
}

// ---------------------------------------------------------------- 客户端断开取消

// 客户端提前断开时取消上游生成（避免上游白跑继续计费）。
// 必须挂在 res 的 close 上：req 的 close 在请求体读完后就已经触发过，
// 之后客户端断开不会再触发（实测探针：res close ✅ / req close ❌）。
// 正常完成时 writableFinished 为 true，不会误伤。
function abortOnClientClose(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

// ---------------------------------------------------------------- 路由

const routes = {
  'GET /health': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: nowSec() }));
  },

  'GET /v1/models': async (req, res) => {
    // 返回配置里的模型：默认模型 + MODEL_MAP 的键与值去重
    const ids = [...new Set([config.defaultModel, ...Object.keys(config.modelMap), ...Object.values(config.modelMap)])];
    const body = {
      object: 'list',
      data: ids.map((id) => ({
        id,
        object: 'model',
        created: nowSec(),
        owned_by: 'cloudbase-adapter',
      })),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  },

  'POST /v1/chat/completions': async (req, res) => {
    const body = await readJsonBody(req);

    if (config.debug) {
      console.log(
        `[server] chat/completions model=${body.model} stream=${!!body.stream} ` +
          `tools=${Array.isArray(body.tools) ? body.tools.length : 0} ` +
          `msgs=${Array.isArray(body.messages) ? body.messages.length : 0}`
      );
    }

    if (!Array.isArray(body.messages)) {
      throw openaiError(
        '"messages" is required and must be an array',
        'invalid_request_error',
        'missing_messages',
        400
      );
    }

    const requestedModel = mapModel(body.model, config);
    const cloudbaseParams = toCloudbaseParams(body, config);
    const openaiTools = fromOpenAITools(body.tools);
    const wantsStream = body.stream === true;

    if (wantsStream) {
      // SSE 响应头由 cb.chatCompletionStream 在拿到上游数据、写首个 chunk 前才发，
      // 上游早期报错（如 429）才能以正确状态码返回而不是 200 + SSE 里的裸 JSON
      const signal = abortOnClientClose(res);
      await cb.chatCompletionStream(cloudbaseParams, openaiTools, requestedModel, res, signal);
      return;
    }

    const signal = abortOnClientClose(res);
    const raw = await cb.chatCompletion(cloudbaseParams, openaiTools, requestedModel, signal);
    const completion = buildCompletionResponse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion));
  },
};

// ---------------------------------------------------------------- 服务器

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  // CORS：让浏览器端 / webview 客户端也能直连（错误路径同样生效，writeHead 会合并这里的字段）
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    // 预检请求不鉴权，直接放行
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
    // /health 豁免鉴权：探活 / 负载均衡不应拿到 401
    if (key !== 'GET /health') checkAuth(req);
    const handler = routes[key];
    if (!handler) {
      throw openaiError(
        `unknown route: ${key}. Available: GET /health, GET /v1/models, POST /v1/chat/completions`,
        'invalid_request_error',
        'not_found',
        404
      );
    }
    await handler(req, res);
  } catch (e) {
    sendError(res, e);
  }
});

server.listen(config.port, config.host, () => {
  logConfig();
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(`[server] listening on http://${shown}:${config.port}`);
  if (!isLoopback(config.host)) {
    const wildcard = config.host === '0.0.0.0' || config.host === '::';
    console.log(
      `[server] 已监听非回环地址（${config.host}），局域网/外网可直接访问` +
        (wildcard ? '（所有网卡）' : '')
    );
    if (!config.apiKey) {
      console.warn('[server] 警告：当前未设置 API_KEY，任何能访问该端口的人都可以调用本服务');
    }
  }
  console.log('[server] OpenAI-compatible endpoints:');
  console.log('[server]   POST /v1/chat/completions');
  console.log('[server]   GET  /v1/models');
  console.log('[server]   GET  /health');
});

server.on('error', (e) => {
  if (e.code === 'EADDRNOTAVAIL') {
    console.error(`[server] 无法绑定 ${config.host}:${config.port}：该 IP 不属于本机网卡`);
    console.error('[server] 请把 .env 里的 HOST 改为本机实际 IP（如 192.168.x.x），或 0.0.0.0 监听所有网卡');
  } else if (e.code === 'EACCES') {
    console.error(`[server] 无法绑定端口 ${config.port}：权限不足或端口被占用`);
  } else {
    console.error(`[server] failed to start: ${e.message}`);
  }
  process.exit(1);
});
