'use strict';
// 一次性诊断：完整走一遍 上传文件 + workflow/run，打印每一步的原始响应（不打印 PAT）
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
const env = {};
for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const base = (env.COZE_API_BASE || 'https://api.coze.cn').replace(/\/+$/, '');
const wid = env.COZE_WORKFLOW_ID;
const PAT = env.COZE_PAT;

(async () => {
  const text = '甲方与乙方签订采购合同，合同金额人民币伍拾万元整。付款方式：货到验收合格后90日内付款。乙方应在合同签订后30日内完成交付。';
  const doc = new Document({ sections: [{ children: text.split(/\r?\n/).map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
  const buf = await Packer.toBuffer(doc);
  console.log('docx bytes:', buf.length);

  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'test.docx');
  const up = await fetch(`${base}/v1/files/upload`, { method: 'POST', headers: { Authorization: `Bearer ${PAT}` }, body: fd });
  const upJson = await up.json();
  console.log('UPLOAD HTTP', up.status, ':', JSON.stringify(upJson));

  const fileId = upJson.data && upJson.data.id;
  if (!fileId) { console.log('NO FILE ID, abort'); return; }

  const parameters = {
    wenjian: JSON.stringify({ file_id: fileId }),
    xuqiu: '合同类型：采购合同；审查立场：甲方；重点审查：付款与结算',
  };
  const run = await fetch(`${base}/v1/workflow/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow_id: wid, parameters }),
  });
  const runJson = await run.json();
  console.log('RUN HTTP', run.status, ':');
  console.log(JSON.stringify(runJson, null, 2));
})().catch((e) => { console.error('ERR', e); });
