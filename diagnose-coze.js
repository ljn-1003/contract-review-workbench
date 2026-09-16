'use strict';
// 一次性诊断脚本：读取 .env，拉取扣子工作流的输入/输出参数结构（不打印 PAT）
const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
const env = {};
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const wid = env.COZE_WORKFLOW_ID;
const base = (env.COZE_API_BASE || 'https://api.coze.cn').replace(/\/+$/, '');

(async () => {
  const r = await fetch(`${base}/v1/workflows/${wid}?include_input_output=true`, {
    headers: { Authorization: `Bearer ${env.COZE_PAT}` },
  });
  const j = await r.json();
  console.log('HTTP', r.status);
  console.log(JSON.stringify(j, null, 2));
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
