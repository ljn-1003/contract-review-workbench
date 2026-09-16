'use strict';

// ================= 状态 =================
let isReviewing = false;
let currentResult = null;
let currentMode = null;
let currentFilter = 'all';
let selectedFile = null;      // { name, size, ext, data(base64) }
let stance = '甲方';
const focusAreas = new Set();
let lastPayload = null;

const HISTORY_KEY = 'contract-review-history';
const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'txt', 'md'];

// ================= DOM 引用 =================
const $ = (id) => document.getElementById(id);

// ================= 工具 =================
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

const RISK_META = {
  high: { label: '高风险', cls: 'risk-high' },
  medium: { label: '中风险', cls: 'risk-medium' },
  low: { label: '低风险', cls: 'risk-low' },
};

// ================= 连接状态 =================
async function checkHealth() {
  const badge = $('cozeStatus');
  const txt = badge.querySelector('.status-text');
  try {
    const res = await fetch('/api/health');
    const d = await res.json();
    badge.className = 'status-badge';
    if (d.cozeConfigured) {
      badge.classList.add('is-on');
      txt.textContent = '扣子工作流已连接';
    } else {
      badge.classList.add('is-off');
      txt.textContent = '演示模式（未配置扣子）';
    }
  } catch (_) {
    badge.className = 'status-badge';
    badge.classList.add('is-off');
    txt.textContent = '连接状态未知';
  }
}

// ================= 文件上传 =================
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  const errEl = $('fileError');
  errEl.hidden = true;
  errEl.textContent = '';
  if (!file) return;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    errEl.textContent = '不支持的文件类型，请上传 PDF、Word、TXT 或 MD 文件。';
    errEl.hidden = false;
    return;
  }
  if (file.size > MAX_SIZE) {
    errEl.textContent = '文件超过 10MB，请压缩后重试。';
    errEl.hidden = false;
    return;
  }

  try {
    const data = await readFileAsBase64(file);
    selectedFile = { name: file.name, size: file.size, ext, data };
    renderFileChip();
  } catch (e) {
    errEl.textContent = e.message || '文件读取失败';
    errEl.hidden = false;
  }
}

function renderFileChip() {
  const chip = $('fileChip');
  if (!selectedFile) { chip.hidden = true; return; }
  $('fileName').textContent = selectedFile.name;
  $('fileSize').textContent = formatSize(selectedFile.size);
  chip.hidden = false;
}

function clearFile() {
  selectedFile = null;
  $('fileInput').value = '';
  renderFileChip();
  $('fileError').hidden = true;
}

// ================= 表单错误 =================
function showFormError(msg) {
  const el = $('formError');
  el.textContent = msg;
  el.hidden = false;
}
function clearFormError() { $('formError').hidden = true; }

// ================= 审查流程 =================
function setSubmitDisabled(v) { $('submitBtn').disabled = v; }

function setStepState(steps, n, state) {
  const el = steps[n - 1];
  if (!el) return;
  el.classList.remove('is-active', 'is-done');
  if (state === 'active') el.classList.add('is-active');
  if (state === 'done') el.classList.add('is-done');
}

let processTimers = [];
function clearProcessTimers() {
  processTimers.forEach((t) => clearTimeout(t));
  processTimers = [];
}

function animateProcess() {
  clearProcessTimers();
  const steps = document.querySelectorAll('#processSteps .step');
  [1, 2, 3, 4].forEach((n) => setStepState(steps, n, 'pending'));
  setStepState(steps, 1, 'done');
  processTimers.push(setTimeout(() => {
    setStepState(steps, 2, 'done');
    setStepState(steps, 3, 'active');
    $('processStatus').textContent = '正在提取文本并逐项分析合同条款，请稍候…';
  }, 650));
}

function finishProcess() {
  clearProcessTimers();
  const steps = document.querySelectorAll('#processSteps .step');
  [1, 2, 3, 4].forEach((n) => setStepState(steps, n, 'done'));
  $('processStatus').textContent = '审查完成，正在整理结果…';
}

function failProcess() {
  clearProcessTimers();
  hideProcess();
}

function showProcess() { $('processCard').hidden = false; }
function hideProcess() { $('processCard').hidden = true; }
function showResult() { $('resultCard').hidden = false; }
function hideResult() { $('resultCard').hidden = true; }

// ================= 提交 =================
function buildPayload(mode) {
  const pastedText = $('contractText').value.trim();
  const hasFile = !!selectedFile;
  return {
    contractType: $('contractType').value,
    stance,
    focusAreas: Array.from(focusAreas),
    additionalRequirements: $('additionalRequirements').value.trim(),
    text: pastedText,
    fileName: pastedText ? '(粘贴文本)' : (selectedFile ? selectedFile.name : ''),
    fileData: (!pastedText && selectedFile) ? selectedFile.data : null,
    mode,
  };
}

async function onSubmit() {
  if (isReviewing) return;
  clearFormError();
  const pastedText = $('contractText').value.trim();
  if (!selectedFile && !pastedText) {
    showFormError('请先上传合同文件或粘贴合同文本，再开始审查。');
    $('contractText').focus();
    return;
  }
  lastPayload = buildPayload('auto');
  await startReview(lastPayload);
}

async function startReview(payload) {
  isReviewing = true;
  setSubmitDisabled(true);
  hideResult();
  hideProcess();
  showProcess();
  animateProcess();

  try {
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ error: '服务返回内容无法解析' }));

    if (res.ok && (data.mode === 'real' || data.mode === 'demo')) {
      currentMode = data.mode;
      currentResult = data.result;
      finishProcess();
      renderResult(data.result, data.mode);
      saveHistory(data.result, payload);
      setTimeout(() => $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    } else {
      failProcess();
      showError(data.error || '审查失败，请重试。', payload);
    }
  } catch (e) {
    failProcess();
    showError('网络错误：' + (e.message || '无法连接到服务'), payload);
  } finally {
    isReviewing = false;
    setSubmitDisabled(false);
  }
}

// ================= 错误提示 =================
function showError(msg, payload) {
  $('errorBanner').hidden = false;
  $('errorText').textContent = msg;
  $('resultBanner').hidden = true;
  $('demoBanner').hidden = true;
  $('summaryGrid').hidden = true;
  $('checkGrid').innerHTML = '';
  $('filterBar').hidden = true;
  $('opinionList').innerHTML = '';
  $('feishuBox').hidden = true;
  showResult();
  lastPayload = payload;
}
function hideError() { $('errorBanner').hidden = true; }

// ================= 结果渲染 =================
function renderResult(result, mode) {
  hideError();
  $('resultBanner').hidden = false;
  $('summaryGrid').hidden = false;
  $('filterBar').hidden = false;

  const opinions = result.opinions || [];
  const high = opinions.filter((o) => o.riskLevel === 'high').length;
  const medium = opinions.filter((o) => o.riskLevel === 'medium').length;
  const low = opinions.filter((o) => o.riskLevel === 'low').length;

  // 横幅
  $('resultTitle').textContent = '审查完成';
  $('resultSub').textContent = `本次审查共发现 ${opinions.length} 条意见（高风险 ${high} · 中风险 ${medium} · 低风险 ${low}）`;

  // 演示标记
  $('demoBanner').hidden = mode !== 'demo';

  // 摘要
  $('summaryOpinions').textContent = `${opinions.length} 条`;
  $('summaryLaw').textContent = result.lawCheck
    ? (result.lawCheck.items && result.lawCheck.items.length ? `已核验 ${result.lawCheck.items.length} 条` : '已完成')
    : '—';
  $('summaryEnterprise').textContent = result.enterpriseCheck
    ? (result.enterpriseCheck.items && result.enterpriseCheck.items.length ? `已核验 ${result.enterpriseCheck.items.length} 项` : '已完成')
    : '—';

  // 核验详情
  $('checkGrid').innerHTML =
    renderCheckBox('法律引用核验', result.lawCheck) +
    renderCheckBox('企业信息核验', result.enterpriseCheck);

  // 筛选
  const tabs = document.querySelectorAll('#filterTabs .filter-tab');
  const counts = { all: opinions.length, high, medium, low };
  tabs.forEach((t) => {
    const f = t.dataset.filter;
    t.querySelector('.count').textContent = `(${counts[f] ?? 0})`;
  });

  // 意见列表
  currentFilter = 'all';
  tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.filter === 'all'));
  renderOpinions();

  // 飞书报告
  const feishuBox = $('feishuBox');
  const feishuBtn = $('feishuBtn');
  const feishuNote = $('feishuNote');
  if (result.feishuUrl && mode === 'real') {
    feishuBox.hidden = false;
    feishuBtn.hidden = false;
    feishuBtn.href = result.feishuUrl;
    feishuNote.textContent = '';
  } else if (mode === 'demo') {
    feishuBox.hidden = false;
    feishuBtn.hidden = true;
    feishuNote.textContent = '演示模式不生成飞书报告。';
  } else {
    feishuBox.hidden = true;
  }

  showResult();
}

const CHECK_LABELS = {
  cite: '引用', result: '结果', note: '说明', name: '名称', value: '登记值',
  status: '状态', text: '内容', field: '字段', clause: '条款',
};

function renderCheckBox(title, check) {
  if (!check) return '';
  const items = (check.items || []).map((item) => {
    if (typeof item === 'string') return `<div class="check-item">${escapeHtml(item)}</div>`;
    if (!item || typeof item !== 'object') return '';
    const parts = Object.entries(item)
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => `<strong>${CHECK_LABELS[k] || k}:</strong> ${escapeHtml(v)}`);
    return `<div class="check-item">${parts.join('　')}</div>`;
  }).join('');
  return `<div class="check-box">
    <div class="check-box-title">${escapeHtml(title)}</div>
    ${check.summary ? `<div class="check-box-summary">${escapeHtml(check.summary)}</div>` : ''}
    ${items || '<div class="check-item">暂无详情</div>'}
  </div>`;
}

function opinionCardHTML(o, idx) {
  const meta = RISK_META[o.riskLevel] || RISK_META.medium;
  return `<article class="opinion-card">
    <div class="opinion-head">
      <h3 class="opinion-title">${escapeHtml(o.title)}</h3>
      <span class="risk-badge ${meta.cls}">${meta.label}</span>
    </div>
    <div class="opinion-section">
      <div class="opinion-label">问题分析</div>
      <p class="opinion-text">${escapeHtml(o.analysis || '—')}</p>
    </div>
    <div class="opinion-section">
      <div class="opinion-label">修改建议</div>
      <p class="opinion-suggest">${escapeHtml(o.suggestion || '—')}</p>
    </div>
    <div class="opinion-actions">
      <button type="button" class="btn btn-ghost btn-sm copy-suggest-btn" data-idx="${idx}">复制修改建议</button>
    </div>
  </article>`;
}

function renderOpinions() {
  const list = $('opinionList');
  if (!currentResult) { list.innerHTML = ''; return; }
  const filtered = currentResult.opinions
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => currentFilter === 'all' || o.riskLevel === currentFilter);
  if (!filtered.length) {
    list.innerHTML = '<p class="process-status">该风险等级下暂无意见。</p>';
    return;
  }
  list.innerHTML = filtered.map(({ o, i }) => opinionCardHTML(o, i)).join('');
}

function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('#filterTabs .filter-tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.filter === f));
  renderOpinions();
}

// ================= 复制 =================
async function copySuggestion(idx) {
  const o = currentResult && currentResult.opinions[idx];
  if (!o) return;
  const ok = await copyText(o.suggestion || '');
  const btn = document.querySelector(`.copy-suggest-btn[data-idx="${idx}"]`);
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

async function copyAll() {
  if (!currentResult) return;
  const parts = currentResult.opinions.map((o, i) => {
    const meta = RISK_META[o.riskLevel] || RISK_META.medium;
    return `${i + 1}. [${meta.label}] ${o.title}\n问题分析：${o.analysis || '—'}\n修改建议：${o.suggestion || '—'}`;
  });
  const text = `合同审查意见（共 ${currentResult.opinions.length} 条）\n\n` + parts.join('\n\n');
  const ok = await copyText(text);
  const btn = $('copyAllBtn');
  const old = btn.textContent;
  btn.textContent = ok ? '已复制全部意见' : '复制失败';
  setTimeout(() => { btn.textContent = old; }, 1200);
}

// ================= 历史记录 =================
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; }
}
function saveHistory(result, payload) {
  const high = (result.opinions || []).filter((o) => o.riskLevel === 'high').length;
  const name = payload.fileName && payload.fileName !== '(粘贴文本)'
    ? payload.fileName
    : (payload.contractType || '合同');
  let list = loadHistory();
  list.unshift({ name, time: formatTime(new Date()), opinions: (result.opinions || []).length, high });
  list = list.slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  $('historyCard').hidden = list.length === 0;
  $('historyList').innerHTML = list.map((it) => `
    <li class="history-item">
      <span class="history-name">${escapeHtml(it.name)}</span>
      <span class="history-meta">
        <span>${escapeHtml(it.time)}</span>
        <span>意见 ${it.opinions} 条</span>
        <span class="history-high">高风险 ${it.high} 条</span>
      </span>
    </li>`).join('');
}
function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

// ================= 重置 =================
function resetAll() {
  clearProcessTimers();
  $('contractType').selectedIndex = 0;
  setStance('甲方');
  focusAreas.clear();
  document.querySelectorAll('#focusAreas .chip').forEach((c) => c.classList.remove('is-active'));
  $('additionalRequirements').value = '';
  $('contractText').value = '';
  clearFile();
  clearFormError();
  $('fileError').hidden = true;
  hideProcess();
  hideResult();
  currentResult = null;
  currentMode = null;
  isReviewing = false;
  setSubmitDisabled(false);
}

// ================= 交互绑定 =================
function setStance(v) {
  stance = v;
  document.querySelectorAll('#stance .seg-btn').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.value === v));
}

function bindEvents() {
  // 立场
  $('stance').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setStance(btn.dataset.value);
  });

  // 重点审查内容
  $('focusAreas').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const v = chip.dataset.value;
    if (focusAreas.has(v)) { focusAreas.delete(v); chip.classList.remove('is-active'); }
    else { focusAreas.add(v); chip.classList.add('is-active'); }
  });

  // 上传：点击
  const dz = $('dropzone');
  dz.addEventListener('click', () => $('fileInput').click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  $('fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));

  // 上传：拖拽
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });
  $('fileRemove').addEventListener('click', clearFile);

  // 提交 / 重置
  $('submitBtn').addEventListener('click', onSubmit);
  $('resetBtn').addEventListener('click', resetAll);

  // 筛选
  $('filterTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.filter-tab');
    if (tab) setFilter(tab.dataset.filter);
  });

  // 复制（事件委托）
  $('opinionList').addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-suggest-btn');
    if (btn) copySuggestion(Number(btn.dataset.idx));
  });
  $('copyAllBtn').addEventListener('click', copyAll);

  // 错误重试 / 演示
  $('retryBtn').addEventListener('click', () => {
    if (lastPayload) { hideResult(); startReview({ ...lastPayload, mode: 'auto' }); }
  });
  $('useDemoBtn').addEventListener('click', () => {
    if (lastPayload) { hideResult(); startReview({ ...lastPayload, mode: 'demo' }); }
  });

  // 历史
  $('clearHistoryBtn').addEventListener('click', clearHistory);
}

// ================= 初始化 =================
function init() {
  bindEvents();
  renderHistory();
  checkHealth();
}

document.addEventListener('DOMContentLoaded', init);
