'use strict';

/**
 * 合同审查工作台 —— 后端服务
 *
 * 职责：
 *  1. 托管前端静态页面（public/）
 *  2. 接收前端提交的合同信息，在【服务端】调用扣子工作流
 *  3. 个人访问密钥（PAT）只保存在 .env，绝不出现在浏览器 / 日志 / 前端代码中
 *  4. 未配置 PAT 时返回演示结果（前端会标注“当前为演示结果”）
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

// ---------- 极简 .env 加载（避免额外依赖） ----------
(function loadEnv(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
})('.env');

// ---------- 扣子配置（密钥仅服务端可见） ----------
const COZE_WORKFLOW_ID = process.env.COZE_WORKFLOW_ID || '768572726882038581';
const COZE_PAT = process.env.COZE_PAT || '';
const COZE_API_BASE = (process.env.COZE_API_BASE || 'https://api.coze.cn').replace(/\/+$/, '');
const cozeConfigured = Boolean(COZE_PAT);

// 工作流开始节点的输入参数名（从工作流 law_check 的真实定义读取）
//   wenjian：文档文件（doc 类型，需先上传文件拿 file_id 再传入）
//   xuqiu  ：需求文本（string）
const PARAM_NAMES = {
  doc: 'wenjian',
  requirement: 'xuqiu',
};

// ---------- 文本提取组件（可选，缺失时不阻断 txt/md/粘贴文本流程） ----------
let mammoth = null;
let pdfParse = null;
let docxLib = null;
try { mammoth = require('mammoth'); } catch (_) { /* 未安装 */ }
try { pdfParse = require('pdf-parse'); } catch (_) { /* 未安装 */ }
try { docxLib = require('docx'); } catch (_) { /* 未安装 */ }

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 健康检查：告知前端扣子是否已配置（不泄露密钥） ----------
app.get('/api/health', (req, res) => {
  res.json({ cozeConfigured });
});

// ---------- 从上传文件（base64）中提取文本 ----------
async function extractText(fileName, fileData) {
  if (!fileName || !fileData) return '';
  const ext = path.extname(fileName).toLowerCase();
  const buf = Buffer.from(fileData, 'base64');

  if (ext === '.txt' || ext === '.md') {
    return buf.toString('utf8');
  }
  if (ext === '.docx') {
    if (!mammoth) throw new Error('缺少 Word 文本提取组件，请先运行 npm install 后重启');
    const r = await mammoth.extractRawText({ buffer: buf });
    return r.value || '';
  }
  if (ext === '.doc') {
    throw new Error('暂不支持旧版 .doc 格式，请另存为 .docx 或直接粘贴文本');
  }
  if (ext === '.pdf') {
    if (!pdfParse) throw new Error('缺少 PDF 文本提取组件，请先运行 npm install 后重启');
    const r = await pdfParse(buf);
    return r.text || '';
  }
  throw new Error('不支持的文件格式：' + ext);
}

// ---------- 生成 .docx（粘贴文本 → 文档） ----------
async function textToDocx(text) {
  if (!docxLib) throw new Error('缺少文档生成组件，请先运行 npm install 后重启');
  const { Document, Packer, Paragraph, TextRun } = docxLib;
  const lines = String(text || '').split(/\r?\n/);
  const children = lines.map((line) => new Paragraph({ children: [new TextRun(line)] }));
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------- 上传文件到扣子，返回 file_id ----------
async function uploadFileToCoze(buffer, fileName) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), fileName);
  const url = `${COZE_API_BASE}/v1/files/upload`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${COZE_PAT}` },
    body: fd,
  });
  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0) {
    const err = new Error(json.msg || json.message || `扣子上传文件失败，错误码 ${json.code}`);
    err.code = json.code;
    throw err;
  }
  return json.data && json.data.id;
}

// ---------- 拼装工作流需求文本（xuqiu） ----------
function buildXuqiu(payload) {
  const parts = [];
  if (payload.contractType) parts.push(`合同类型：${payload.contractType}`);
  if (payload.stance) parts.push(`审查立场：${payload.stance}`);
  if (payload.focusAreas && payload.focusAreas.length) parts.push(`重点审查：${payload.focusAreas.join('、')}`);
  if (payload.additionalRequirements) parts.push(`补充要求：${payload.additionalRequirements}`);
  return parts.join('；') || '请对合同进行全面审查';
}

// ---------- 工具：从对象中按候选键名取值（大小写不敏感，递归） ----------
function pick(obj, keys) {
  if (obj == null) return undefined;
  const lower = keys.map((k) => String(k).toLowerCase());
  const hit = (v) => {
    if (v == null) return undefined;
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) return v.length ? pick(v[0], keys) : undefined;
    for (const k of Object.keys(v)) {
      if (lower.includes(k.toLowerCase())) return v[k];
    }
    return undefined;
  };
  return hit(obj);
}

function findDeep(obj, keys, depth = 0) {
  if (obj == null || depth > 5) return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const r = findDeep(it, keys, depth + 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof obj === 'object') {
    const lower = keys.map((k) => String(k).toLowerCase());
    for (const [k, v] of Object.entries(obj)) {
      if (lower.includes(k.toLowerCase())) return v;
    }
    for (const [k, v] of Object.entries(obj)) {
      const r = findDeep(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function findArray(obj, depth = 0) {
  if (obj == null || depth > 5) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const r = findArray(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function normalizeRisk(v) {
  if (v == null) return 'medium';
  const s = String(v).toLowerCase();
  if (/高|high|严重|重大|critical|red|红/.test(s)) return 'high';
  if (/低|low|轻微|minor|green|绿/.test(s)) return 'low';
  if (/中|medium|一般|orange|橙/.test(s)) return 'medium';
  return 'medium';
}

function strVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function normalizeOpinion(o) {
  if (typeof o === 'string') {
    return { title: '审查意见', riskLevel: 'medium', analysis: o, suggestion: '' };
  }
  if (!o || typeof o !== 'object') return null;
  const title = strVal(pick(o, ['title', '问题', '问题标题', '条款', 'clause', 'risk', '风险点', 'heading', 'name'])) || '审查意见';
  const riskLevel = normalizeRisk(pick(o, ['risk', 'risk_level', 'level', '风险', '风险等级', '等级', 'severity', 'grade']));
  const analysis = strVal(pick(o, ['analysis', '问题分析', '分析', '描述', 'description', 'detail', '说明', 'reason', '问题']));
  const suggestion = strVal(pick(o, ['suggestion', '修改建议', '建议', '修改意见', 'advice', 'recommendation', '整改建议', '修改建议文本']));
  return { title, riskLevel, analysis, suggestion };
}

function normalizeCheck(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { summary: raw, items: [] };
  if (Array.isArray(raw)) {
    return { summary: '', items: raw.map((x) => (typeof x === 'string' ? { text: x } : x)) };
  }
  const summary = strVal(pick(raw, ['summary', '摘要', '结果', 'conclusion', '核验结果', '说明', 'overview', 'result']));
  const items = findArray(raw) || [];
  return { summary, items: items.map((x) => (typeof x === 'string' ? { text: x } : x)) };
}

// ---------- 解析工作流 output 文本为结构化审查意见 ----------
// output 形如：
//   - 问题1：付款前提对应的验收规则约定不明
//     - 分析：...
//     - 修改建议：...
//   - 问题2：...
function parseOpinions(text) {
  if (!text) return [];
  const opinions = [];
  let cur = null;

  const flush = () => {
    if (cur && (cur.title || cur.analysis || cur.suggestion)) {
      opinions.push({
        title: cur.title || '审查意见',
        riskLevel: cur.riskLevel || 'medium',
        analysis: cur.analysis || '',
        suggestion: cur.suggestion || '',
      });
    }
  };

  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 问题标题行：- 问题1：xxx
    const titleMatch = line.match(/^[-*•]\s*问题\s*\d*\s*[：:]\s*(.*)$/);
    if (titleMatch) {
      flush();
      const title = (titleMatch[1] || '审查意见').trim();
      cur = { title, riskLevel: inferRisk(title), analysis: '', suggestion: '' };
      continue;
    }

    if (!cur) continue; // 问题块之前的说明文字，忽略

    const analysisMatch = line.match(/^[-*•]\s*分析\s*[：:]\s*(.*)$/);
    if (analysisMatch) { cur.analysis = analysisMatch[1].trim(); continue; }

    const suggestMatch = line.match(/^[-*•]\s*(?:修改建议|建议|修改意见|整改建议)\s*[：:]\s*(.*)$/);
    if (suggestMatch) { cur.suggestion = suggestMatch[1].trim(); continue; }

    // 续行：追加到最近已开启的字段
    if (cur.suggestion) cur.suggestion += '\n' + line;
    else if (cur.analysis) cur.analysis += '\n' + line;
    else cur.title += line;
  }
  flush();
  return opinions;
}

// 工作流未返回风险等级，先按标题关键词做保守推断（明显高风险词标 high，其余 medium）
function inferRisk(text) {
  const s = String(text || '');
  if (/违约|赔偿|解除|终止|知识产权|侵权|泄密|竞业|重大|严重/.test(s)) return 'high';
  return 'medium';
}

// ---------- 把扣子工作流返回结果规范化为前端所需结构 ----------
// 工作流固定输出四个字段：
//   output  → 合同问题审查意见（纯文本，含「问题/分析/修改建议」块）
//   output1 → 旧法引用核验结果
//   output2 → 合作方企业信息核验结果
//   url     → 飞书完整审查报告地址
function normalizeResult(data) {
  if (data == null) data = {};
  const feishuUrl = (typeof data.url === 'string' && data.url.trim()) ? data.url.trim() : null;

  let opinions = parseOpinions(data.output);
  if (!opinions.length && data.output) {
    // 兜底：格式未识别时，把整个 output 作为一条意见，避免丢内容
    opinions = [{ title: '审查意见', riskLevel: 'medium', analysis: strVal(data.output), suggestion: '' }];
  }

  const lawCheck = data.output1 ? { summary: strVal(data.output1), items: [] } : null;
  const enterpriseCheck = data.output2 ? { summary: strVal(data.output2), items: [] } : null;

  return { opinions, lawCheck, enterpriseCheck, feishuUrl, raw: data };
}

// ---------- 调用扣子工作流 ----------
async function runCozeWorkflow(payload, fileBuffer, fileName) {
  // 1) 先上传合同文件，拿到 file_id（工作流的 wenjian 是 doc 类型，只能传文件）
  const fileId = await uploadFileToCoze(fileBuffer, fileName);

  // 2) 构造工作流输入：wenjian 传 file_id 对象，xuqiu 传需求文本
  const parameters = {
    [PARAM_NAMES.doc]: JSON.stringify({ file_id: fileId }),
    [PARAM_NAMES.requirement]: buildXuqiu(payload),
  };

  const url = `${COZE_API_BASE}/v1/workflow/run`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COZE_PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workflow_id: COZE_WORKFLOW_ID, parameters }),
  });

  const json = await resp.json().catch(() => ({}));
  if (json.code !== 0) {
    const err = new Error(json.msg || json.message || `扣子返回错误码 ${json.code}`);
    err.code = json.code;
    throw err;
  }

  // 工作流被中断（如某个插件需要 OAuth 授权），给出明确提示而非返回空结果
  if (json.interrupt_data && !json.data) {
    let tip = '';
    try {
      const inner = typeof json.interrupt_data.data === 'string' ? JSON.parse(json.interrupt_data.data) : json.interrupt_data.data;
      if (inner && inner.need_auth) tip = `，请先到扣子后台授权「${inner.plugin_name || '飞书云文档'}」插件`;
    } catch (_) { /* ignore */ }
    throw new Error('工作流执行被中断' + tip + '，授权完成后重试');
  }

  let data = json.data;
  if (data == null) {
    throw new Error('工作流未返回结果，请到扣子后台查看运行日志（' + (json.debug_url || '无 debug_url') + '）');
  }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { /* 保持字符串 */ }
  }
  console.log('[coze] 工作流原始返回:', JSON.stringify(data));
  return normalizeResult(data);
}

// ---------- 演示结果生成 ----------
const DEMO_OPINIONS = {
  '付款与结算': [
    { title: '付款账期过长，回款风险高', risk: 'high', analysis: '合同约定“货到验收合格后 90 日内付款”，账期偏长，且未约定逾期付款的违约责任，显著拉长收款方回款周期，现金流压力较大。', suggestion: '建议将付款账期缩短至 30 日内，并补充“逾期付款按日万分之五支付违约金”条款，同时明确付款方式为银行转账至指定账户。' },
    { title: '结算方式与发票约定不明确', risk: 'medium', analysis: '合同未明确结算币种、发票类型（专票/普票）及开票时点，可能导致双方对结算金额与税费承担产生分歧。', suggestion: '建议明确结算币种、增值税专用发票的开具时点与内容，并约定发票不合规时的责任承担。' },
  ],
  '违约责任': [
    { title: '违约金比例偏高，存在被酌减风险', risk: 'medium', analysis: '约定违约金为合同总额的 30%，高于司法实践通常支持的 20%~30% 上限，法院可能依申请予以酌减。', suggestion: '建议将违约金比例调整至合同总额的 20% 以内，并区分不同违约情形的责任范围。' },
    { title: '缺少守约方救济条款', risk: 'low', analysis: '合同仅约定违约方责任，未约定守约方的单方解除权、损失赔偿范围及举证责任分配。', suggestion: '建议补充守约方单方解除权、可得利益损失赔偿及律师费等维权成本由违约方承担的条款。' },
  ],
  '知识产权': [
    { title: '交付成果知识产权归属未明确', risk: 'high', analysis: '合同未约定开发成果、文档及衍生作品的知识产权归属，可能引发成果权属争议。', suggestion: '建议明确约定成果知识产权在付清全款后归委托方所有，并保留受托方既有技术的许可范围及署名方式。' },
    { title: '缺少第三方侵权保证与赔偿', risk: 'medium', analysis: '未约定受托方保证交付成果不侵犯第三方知识产权，以及发生侵权时受托方的抗辩与赔偿义务。', suggestion: '建议增加知识产权不侵权保证与赔偿条款，明确侵权索赔时由受托方承担抗辩并赔偿委托方损失。' },
  ],
  '交付验收': [
    { title: '验收标准与期限缺失', risk: 'high', analysis: '合同未约定明确的验收标准、验收程序与验收期限，交付物可能长期处于“验收中”状态，影响结算。', suggestion: '建议约定验收标准附件、委托方在收到交付物后 15 日内完成验收，逾期视为验收合格。' },
    { title: '交付物清单不完整', risk: 'medium', analysis: '交付范围表述笼统，未列明交付物明细、版本及配套文档，交付时易产生争议。', suggestion: '建议以附件形式明确交付物清单、技术规格、源代码及配套文档，并约定交付方式与签收手续。' },
  ],
  '解除终止': [
    { title: '解除权触发条件模糊', risk: 'medium', analysis: '合同约定“严重违约”可解除，但未定义何为严重违约，解除权行使存在不确定性。', suggestion: '建议列明构成根本违约、可单方解除的具体情形，并约定解除通知的送达方式与生效时间。' },
    { title: '合同终止后义务未约定', risk: 'low', analysis: '未约定合同终止后的保密义务、数据返还、已付款项结算及成果移交等善后安排。', suggestion: '建议补充终止后善后条款，明确资料返还、保密义务存续期限及费用结算方式。' },
  ],
};

const DEMO_GENERAL = [
  { title: '争议解决条款缺少管辖约定', risk: 'medium', analysis: '合同未约定争议解决方式与管辖法院，发生纠纷时可能出现管辖权争议，增加维权成本。', suggestion: '建议约定“因本合同发生的争议，协商不成的，提交甲方所在地有管辖权的人民法院诉讼解决”。' },
  { title: '合同主体信息不完整', risk: 'low', analysis: '合同未载明双方统一社会信用代码、法定代表人或授权代表信息，影响合同主体确认。', suggestion: '建议补充双方完整主体信息、统一社会信用代码及授权代表签字信息。' },
];

function buildDemoResult({ contractType, stance, focusAreas, additionalRequirements }) {
  const areas = (focusAreas && focusAreas.length) ? focusAreas : ['付款与结算', '违约责任'];
  let opinions = [];
  for (const a of areas) {
    if (DEMO_OPINIONS[a]) opinions = opinions.concat(DEMO_OPINIONS[a]);
  }
  opinions = opinions.concat(DEMO_GENERAL);
  // 统一为前端使用的 riskLevel 字段
  opinions = opinions.map((o) => ({
    title: o.title,
    riskLevel: o.risk || 'medium',
    analysis: o.analysis,
    suggestion: o.suggestion,
  }));

  return {
    opinions,
    lawCheck: {
      summary: '共核验 7 条法律引用，其中 6 条现行有效，1 条建议人工复核。',
      items: [
        { cite: '《中华人民共和国民法典》第五百六十三条', result: '有效', note: '法定解除情形引用正确' },
        { cite: '《中华人民共和国民法典》第五百八十五条', result: '有效', note: '违约金调整规则引用正确' },
        { cite: '《中华人民共和国劳动合同法》第二十二条', result: '有效', note: '服务期与违约金规定引用正确' },
        { cite: '《中华人民共和国合同法》第一百零七条', result: '待复核', note: '《合同法》已废止，建议改用《民法典》第五百七十七条' },
      ],
    },
    enterpriseCheck: {
      summary: '企业主体信息核验完成：与公开工商登记信息一致。',
      items: [
        { name: '统一社会信用代码', value: '与工商登记一致', status: '一致' },
        { name: '企业名称', value: '与工商登记一致', status: '一致' },
        { name: '法定代表人', value: '与工商登记一致', status: '一致' },
        { name: '经营状态', value: '存续（在营）', status: '一致' },
      ],
    },
    feishuUrl: null,
  };
}

// ---------- 主接口：审查合同 ----------
app.post('/api/review', async (req, res) => {
  const body = req.body || {};
  const { contractType, stance, focusAreas, additionalRequirements, fileName, fileData, text: pastedText, mode } = body;

  const forceDemo = mode === 'demo';

  try {
    const pasted = (pastedText || '').trim();
    const hasFile = !!fileData;
    if (!hasFile && !pasted) {
      return res.status(400).json({ error: '请上传合同文件或粘贴合同文本后再试。' });
    }

    const payload = {
      contractType: contractType || '',
      stance: stance || '中立',
      focusAreas: focusAreas || [],
      additionalRequirements: additionalRequirements || '',
    };

    // 2) 演示模式（未配置 PAT 或前端显式要求）
    if (forceDemo || !cozeConfigured) {
      const result = buildDemoResult(payload);
      return res.json({ mode: 'demo', result });
    }

    // 3) 真实调用：把合同文件上传给工作流（上传的文件直接传原文件，粘贴文本转 .docx）
    let fileBuffer, uploadName;
    if (hasFile) {
      fileBuffer = Buffer.from(fileData, 'base64');
      uploadName = fileName || 'contract';
    } else {
      fileBuffer = await textToDocx(pasted);
      uploadName = '合同文本.docx';
    }
    const result = await runCozeWorkflow(payload, fileBuffer, uploadName);
    return res.json({ mode: 'real', result });
  } catch (err) {
    console.error('[review] 调用扣子工作流失败:', err.message);
    return res.status(502).json({
      error: '调用扣子工作流失败：' + (err.message || '未知错误') + '。请检查工作流是否已发布、参数名是否匹配，或稍后重试。',
      canDemo: true,
    });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log('合同审查工作台已启动： http://localhost:' + PORT);
  console.log(cozeConfigured
    ? '扣子工作流：已配置（PAT 仅存于服务端 .env）'
    : '扣子工作流：未配置 PAT，将使用演示结果');
});
