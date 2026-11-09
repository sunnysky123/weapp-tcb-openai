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
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(
          openaiError('request body too large', 'invalid_request_error', 'body_too_large', 413)
        );
        req.destroy();
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
  const payload = e && e.openai ? e.openai : { error: { message: 'internal error', type: 'api_error', code: null } };
  const status = (e && e.status) || 500;
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify(payload));
  if (config.debug && e && !e.openai) console.error(e);
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
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      await cb.chatCompletionStream(cloudbaseParams, openaiTools, requestedModel, res, controller.signal);
      return;
    }

    const { raw } = await cb.chatCompletion(cloudbaseParams, openaiTools, requestedModel);
    const completion = buildCompletionResponse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completion));
  },
};

// ---------------------------------------------------------------- 服务器

const server = http.createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  try {
    checkAuth(req);
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
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log('[server] OpenAI-compatible endpoints:');
  console.log('[server]   POST /v1/chat/completions');
  console.log('[server]   GET  /v1/models');
  console.log('[server]   GET  /health');
});

server.on('error', (e) => {
  console.error(`[server] failed to start: ${e.message}`);
  process.exit(1);
});
