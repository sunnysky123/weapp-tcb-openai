'use strict';

const fs = require('fs');
const path = require('path');

// ---- 极简 .env 加载（不引第三方依赖）----
// 只做 KEY=VALUE 解析；已存在的环境变量优先，不被 .env 覆盖
function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // 去掉成对包裹的引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env 不存在是正常情况
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

function boolEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function parseModelMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v) map[k] = v;
      }
      return map;
    }
  } catch (e) {
    console.warn(`[config] MODEL_MAP 不是合法 JSON，已忽略: ${e.message}`);
  }
  return {};
}

const config = {
  // CloudBase
  envId: process.env.TCB_ENV_ID || '',
  secretId: process.env.TCB_SECRET_ID || '',
  secretKey: process.env.TCB_SECRET_KEY || '',
  tcbTimeout: Number(process.env.TCB_TIMEOUT) || 300000,

  // 服务
  port: Number(process.env.PORT) || 8090,
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.API_KEY || '',
  defaultModel: process.env.DEFAULT_MODEL || 'hy3',
  modelMap: parseModelMap(process.env.MODEL_MAP),

  // 工具模式: auto | native | prompt
  toolsMode: ['native', 'prompt'].includes(process.env.TOOLS_MODE)
    ? process.env.TOOLS_MODE
    : 'auto',

  // 调试
  debug: boolEnv('DEBUG', false),
};

function logConfig() {
  console.log('[config] CloudBase → OpenAI adapter');
  console.log(`[config]   envId        : ${config.envId ? `${config.envId.slice(0, 4)}****` : '(未设置)'}`);
  console.log(`[config]   secretId     : ${config.secretId ? `${config.secretId.slice(0, 6)}****` : '(未设置，云函数内可留空)'}`);
  console.log(`[config]   port         : ${config.port}`);
  console.log(`[config]   defaultModel : ${config.defaultModel}`);
  console.log(`[config]   modelMap     : ${JSON.stringify(config.modelMap)}`);
  console.log(`[config]   toolsMode    : ${config.toolsMode}`);
  console.log(`[config]   apiKey       : ${config.apiKey ? '(已设置，开启鉴权)' : '(未设置，不鉴权)'}`);
}

module.exports = { config, logConfig };
