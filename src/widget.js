

// ── Convert array vocab to object format ──────────────────────────────────
// vocab.js exports: const vocab = [[word, chinese, level, category], ...]
// category: c=core, h=high_freq, b=basic, a=advanced
const CAT_LABEL = { c:'核心词汇', h:'高频词汇', b:'基础词汇', a:'进阶词汇', x:'自定义词' };
const CAT_COLOR = { c:'#c9a96e', h:'#7eb89a', b:'#7aabcc', a:'#c07070', x:'#d480c0' };
let ALL = vocab.map(v => ({
  w: v[0], cn: v[1], lv: v[2], cat: v[3] || 'h',
  p: '', ph: v[4] || '', en: v[5] || '', ee: v[6] || '', ec: v[7] || '',
  c: CAT_LABEL[v[3]] || '高频学术'
}));
const WORD_MAP = {};
ALL.forEach(v => { WORD_MAP[v.w] = v; });

// 所有文件读写都走 preload 暴露的桥（window.cj），渲染进程不再直接 require fs/path
const CJ = (typeof window !== 'undefined' && window.cj) ? window.cj : null;
const _stateFile = CJ ? CJ.dataPath('progress.json') : null;

// 出错不再静默：写到 %APPDATA%\ielts-widget\error.log，方便排查用户反馈
let _errTimes = [];
function logError(tag, err) {
  try {
    if (!CJ) return;
    CJ.appendData('error.log',
      '[' + new Date().toISOString() + '] ' + tag + ': ' +
      (err && (err.stack || err.message) || String(err)) + '\n');
    // 短时间连续报错 → 弹出兜底面板，不让用户面对半截界面
    const now = Date.now();
    _errTimes = _errTimes.filter(t => now - t < 10000);
    _errTimes.push(now);
    if (_errTimes.length >= 3) showErrorPanel(tag + ': ' + (err && (err.message || err) || ''));
  } catch(e) {}
}
window.addEventListener('error', e => logError('widget.onerror', e.error || e.message));
window.addEventListener('unhandledrejection', e => logError('widget.unhandledrejection', e.reason));

// Load custom vocab additions and deletions
var _customData = null;
try {
  const _ctext = CJ ? CJ.readData('custom_vocab.json') : null;
  if (_ctext) {
    _customData = JSON.parse(_ctext);
    // Add custom words
    (_customData.words || []).forEach(v => {
      // 自定义词若与基础词同词，则覆盖其释义/音标/例句（与词库管理页保持一致）
      const exist = WORD_MAP[v.w];
      if (exist) {
        if (v.cn) exist.cn = v.cn;
        if (v.ph) exist.ph = v.ph;
        if (v.en) exist.en = v.en;
        if (v.ee) exist.ee = v.ee;
        return;
      }
      {
        const entry = { w:v.w, cn:v.cn||'', lv:2, cat:v.cat||'h', p:v.p||'', ph:v.ph||'', en:v.en||'', ee:v.ee||'', ec:'', c: CAT_LABEL[v.cat]||'自定义', _custom:true };
        ALL.push(entry);
        WORD_MAP[v.w] = entry;
      }
    });
    // Remove deleted words
    const deleted = new Set(_customData.deleted || []);
    if (deleted.size > 0) {
      ALL = ALL.filter(v => !deleted.has(v.w));
      deleted.forEach(w => { delete WORD_MAP[w]; });
    }
  }
  // Apply category overrides (user reclassified words)
  if (_customData && _customData.categories) {
    Object.keys(_customData.categories).forEach(function(k) {
      var entry = WORD_MAP[k];
      if (entry) {
        entry.cat = _customData.categories[k];
        entry.c = CAT_LABEL[_customData.categories[k]] || entry.c;
      }
    });
  }
  // Apply priority flags (starred words appear first)
  if (_customData && _customData.priority) {
    var _priSet = new Set(_customData.priority || []);
    ALL.forEach(function(v) { if (_priSet.has(v.w)) v._pri = true; });
  }
} catch(e) {}

// 每 5 秒与磁盘对账一次（多窗口/清空记忆后能很快反映到界面上）
setInterval(function() {
  if (document.hidden) return;
  if (syncFromDisk()) { updateHUD(); updateMiniBar(); try { renderList(); } catch(e) {} updateStreakBanner(); }
}, 5000);

// Filter includes: c=核心only, h=核心+高频, b=核心+高频+基础, all=全部
const CAT_INCLUDES = { c:['c'], h:['c','h'], b:['c','h','b'], all:['c','h','b','a'], x:['x'] };
let activeFilter = 'all';
function getFilteredWords() {
  if (activeFilter === 'x') return ALL.filter(v => v._custom === true);
  if (activeFilter === 'all') return ALL;
  const allowed = CAT_INCLUDES[activeFilter] || ['c','h','b','a'];
  return ALL.filter(v => allowed.includes(v.cat) && !v._custom);
}
function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.f === f);
  });
  const words = getFilteredWords();
  const lbl = document.getElementById('filter-count');
  if (lbl) lbl.textContent = words.length + ' 词';
  buildDeck(words); renderCard();
}

// ── Electron IPC ───────────────────────────────────────────────────────────
// preload 暴露的桥；直接用浏览器打开时为空，代码自动降级
const ipc = CJ;

// ── JS Drag (no webkit-app-region needed) ────────────────────────────────
{
  let _drag = false;
  document.getElementById('topbar').addEventListener('mousedown', e => {
    const t = e.target;
    if (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.closest('button') || t.closest('input')) return;
    e.preventDefault();
    _drag = true;
    if (ipc) ipc.send('win-drag-start', e.screenX, e.screenY);
  });
  document.addEventListener('mousemove', e => { if(_drag && ipc) ipc.send('win-drag-move', e.screenX, e.screenY); });
  document.addEventListener('mouseup', () => { if(_drag && ipc) ipc.send('win-drag-end'); _drag=false; });
}

function quitApp() {
  _writeStateNow();
  if (ipc) ipc.send('win-quit');
  else window.close();
}
window.addEventListener('beforeunload', _writeStateNow);

// ── Drag (fallback for non-Electron) ──────────────────────────────────────
if (!ipc) {
  let drag = false, ox = 0, oy = 0;
  document.getElementById('topbar').addEventListener('mousedown', e => {
    if (e.target.closest('.topbar-right')) return;
    drag = true; ox = e.clientX; oy = e.clientY;
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    window.scrollBy(-(e.clientX - ox), -(e.clientY - oy));
    ox = e.clientX; oy = e.clientY;
  });
  document.addEventListener('mouseup', () => drag = false);
}

// ── Silent / No-anim toggles ──────────────────────────────────────────────
function toggleSilent() {
  isSilent = !isSilent;
  var b = document.getElementById('mute-btn');
  if (b) {
    b.classList.toggle('on', isSilent);
    b.innerHTML = isSilent ? '&#128263;' : '&#128264;';
  }
  if (isSilent && window.speechSynthesis) { window.speechSynthesis.cancel(); }
  try { localStorage.setItem('ielts_silent', isSilent ? '1' : '0'); } catch(_) {}
}
function toggleAnim() {
  noAnim = !noAnim;
  var b = document.getElementById('anim-btn');
  if (b) {
    b.classList.toggle('on', noAnim);
    b.innerHTML = noAnim ? '&#8634;' : '&#8635;';
    b.title = noAnim ? '翻转动画已关闭 - 点击开启' : '翻转动画已开启 - 点击关闭';
  }
  document.getElementById('widget').classList.toggle('no-anim', noAnim);
  try { localStorage.setItem('ielts_noanim', noAnim ? '1' : '0'); } catch(_) {}
}
// Load saved silent/anim state
(function(){
  try {
    if (localStorage.getItem('ielts_silent') === '1') { isSilent = true; var mb = document.getElementById('mute-btn'); if (mb) mb.classList.add('on'); mb.innerHTML='&#128263;'; }
    if (localStorage.getItem('ielts_noanim') === '1') { noAnim = true; var ab = document.getElementById('anim-btn'); if (ab) { ab.classList.add('on'); ab.innerHTML = '&#8634;'; } document.getElementById('widget').classList.add('no-anim'); }
  } catch(_) {}
})();

// ── State ─────────────────────────────────────────────────────────────────
function _readProgress() {
  if (!CJ) return {};
  try {
    const txt = CJ.readDataWithBackup ? CJ.readDataWithBackup('progress.json') : CJ.readData('progress.json');
    return JSON.parse(txt || '{}');
  } catch(e) { return {}; }
}
function _writeProgress(obj) {
  if (!CJ) return;
  // 原子写入 + 保留上一份 .bak，避免写一半崩溃损坏存档
  try {
    obj = (obj && typeof obj === 'object') ? obj : {};
    obj.updatedAt = Date.now();
    _loadedRev = obj.updatedAt;
    CJ.writeData('progress.json', JSON.stringify(obj), { backup: true });
  } catch(e) {}
}

// 其他窗口（词库管理 / 清空记忆）改了数据时，把内存状态对回磁盘版本
let _loadedRev = 0;
function syncFromDisk() {
  try {
    if (!CJ) return false;
    const d = JSON.parse((CJ.readDataWithBackup ? CJ.readDataWithBackup('progress.json') : CJ.readData('progress.json')) || '{}');
    if (!d || !d.updatedAt || d.updatedAt === _loadedRev) return false;
    known   = new Set(d.known   || []);
    unknown = new Set(d.unknown || []);
    favs    = new Set(d.favs    || []);
    streak  = d.streak || 0;
    srs     = d.srs || {};
    dailyStats = d.dailyStats || { date:'', count:0, dayStreak:0 };
    _loadedRev = d.updatedAt;
    invalidateScope();
    return true;
  } catch(e) { return false; }
}
let isMini = false;
let isSilent = false;
let noAnim = false;
let listTab = 'k';
let _listSel = -1;
let _scopeCache = null;
let _resizeTimer = null;
let _listTimer = null;
let _listLimit = 200;
let pinned = true;
// `scope` = the word set currently in play (filter or review deck); stats are always relative to it
let scope = [], _stateTimer = null;
let deck = [], known = new Set(), unknown = new Set(), favs = new Set();
let idx = 0, revealed = false, streak = 0, isReview = false, _reviewLabel = '';
// 间隔复习（SM-2 简化版）：word -> { ef 难度系数, n 连续答对, iv 间隔(ms), due 下次到期 }
let srs = {};
const SR_FAIL_MS = 2 * 60 * 1000;    // 答错：约 2 分钟后重现
const SR_DAY = 24 * 60 * 60 * 1000;  // 答对：1 天 / 3 天 / 7 天 … 递增
// Daily stats
let dailyStats = { date:'', count:0, dayStreak:0 };

function todayStr() {
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function loadState() {
  try {
    const d = _readProgress();
    if (!d || Object.keys(d).length === 0) return;
    known   = new Set(d.known   || []);
    unknown = new Set(d.unknown || []);
    favs    = new Set(d.favs    || []);
    streak  = d.streak || 0;
    srs = d.srs || {};
    _loadedRev = d.updatedAt || 0;
    // 兼容旧进度文件里的 {w, due} 复习队列
    if (Array.isArray(d.srQueue)) {
      d.srQueue.forEach(function(e) {
        if (e && e.w && !srs[e.w]) srs[e.w] = { ef: 2.5, n: 0, iv: 0, due: e.due || Date.now() };
      });
    }
    dailyStats = d.dailyStats || { date:'', count:0, dayStreak:0 };
    const today = todayStr();
    if (dailyStats.date !== today) {
      const wasYesterday = dailyStats.date === (() => {
        const y = new Date(); y.setDate(y.getDate()-1);
        return y.getFullYear()+'-'+String(y.getMonth()+1).padStart(2,'0')+'-'+String(y.getDate()).padStart(2,'0');
      })();
      dailyStats = { date: today, count: 0, dayStreak: wasYesterday ? (dailyStats.dayStreak||0)+1 : 1 };
    }
  } catch(e) {}
}
function saveState() {
  // Debounced: marking cards used to rewrite the whole file on every keypress
  if (_stateTimer) clearTimeout(_stateTimer);
  _stateTimer = setTimeout(_writeStateNow, 400);
}
function _writeStateNow() {
  if (_stateTimer) { clearTimeout(_stateTimer); _stateTimer = null; }
  // 写之前先对账：别人刚改了（比如清空了进度），不要拿陈旧内存盖回去
  syncFromDisk();
  try {
    _writeProgress({
      known:[...known], unknown:[...unknown], favs:[...favs], streak,
      srs, dailyStats
    });
  } catch(e) {}
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 到期的复习词重新插回当前卡组（答错约 2 分钟，答对按 1/3/7… 天）
function pumpSR() {
  if (!deck || !deck.length || isReview) return;
  const now = Date.now();
  const due = (scope || []).filter(v => { const r = srs[v.w]; return r && r.due && r.due <= now; });
  if (!due.length) return;
  due.slice(0, 10).forEach(v => {
    if (deck.some(x => x.w === v.w && x._sr)) return;
    deck.splice(Math.min(idx + 4, deck.length), 0, { ...v, _sr: true });
  });
}
function buildDeck(words) {
  scope = words;
  invalidateScope();
  const now = Date.now();
  // 取当前词表里已到期的复习词，最该复习的排前面，最多 30 个
  const srDue = words
    .filter(v => { const r = srs[v.w]; return r && r.due && r.due <= now; })
    .sort((a, b) => (srs[a.w].due || 0) - (srs[b.w].due || 0))
    .slice(0, 30);
  const srSet = new Set(srDue.map(v => v.w));
  var _priW = words.filter(function(v){ return v._pri && !srSet.has(v.w); });
  var _norW = words.filter(function(v){ return !v._pri && !srSet.has(v.w); });
  var base = shuffle([].concat(_priW)).concat(shuffle([].concat(_norW)));
  deck = [];
  var srIdx = 0;
  for (var i = 0; i < base.length; i++) {
    if (srIdx < srDue.length && i > 0 && i % 5 === 0) {
      deck.push({ ...srDue[srIdx++], _sr: true });
    }
    deck.push(base[i]);
  }
  while (srIdx < srDue.length) deck.push({ ...srDue[srIdx++], _sr: true });
  idx = 0;
}

// ── 兜底错误面板：连续报错时给用户一个出口 ──────────────────────────────
function showErrorPanel(msg) {
  try {
    const el = document.getElementById('error-overlay');
    if (!el) return;
    const d = document.getElementById('error-detail');
    if (d) d.textContent = msg || '';
    el.classList.add('on');
  } catch(e) {}
}
function hideErrorPanel() {
  try { const el = document.getElementById('error-overlay'); if (el) el.classList.remove('on'); } catch(e) {}
}
function reloadApp() { try { location.reload(); } catch(e) {} }

// ── 首次启动引导 ─────────────────────────────────────────────────────────
function maybeShowGuide() {
  try { if (localStorage.getItem('ielts_welcomed') === '1') return; } catch(e) { return; }
  const el = document.getElementById('guide-overlay');
  if (el) el.classList.add('on');
}
function closeGuide() {
  const el = document.getElementById('guide-overlay');
  if (el) el.classList.remove('on');
  try { localStorage.setItem('ielts_welcomed', '1'); } catch(e) {}
  autoResize();
}

// ── Init ──────────────────────────────────────────────────────────────────
try {
  loadState();
  updateStreakBanner();
  var fw = getFilteredWords();
  if (!fw || fw.length === 0) {
    document.getElementById('word').textContent = 'ERR: 词库为空';
  } else {
    buildDeck(fw);
    renderCard();
  }
} catch(e) {
  logError('init', e);
  document.getElementById('word').textContent = 'ERR: ' + (e.message || 'init');
}
maybeShowGuide();

function renderCard() {
  try {
  document.getElementById('finish-view').classList.remove('on');
  document.getElementById('study-view').style.display = '';
  document.getElementById('acts').style.display = 'none';

  if (!deck || idx >= deck.length) { showFinish(); return; }
  pumpSR();

  // Reset card state: clear back content before flip animation to prevent leaking previous word
  const inner = document.getElementById('card-inner');
  const wb = document.getElementById('word-back');
  const cb = document.getElementById('wcat-back');
  if (inner) inner.classList.add('no-transition');
  if (inner) inner.classList.remove('flipped');
  revealed = false;
  if (wb) wb.textContent = '';
  if (cb) cb.textContent = '';
  requestAnimationFrame(() => { if (inner) inner.classList.remove('no-transition'); });

  const v = deck[idx];
  const catEl = document.getElementById('wcat');
  catEl.textContent = v.c;
  catEl.style.color = CAT_COLOR[v.cat] || '#7eb89a';
  catEl.style.borderColor = (CAT_COLOR[v.cat] || '#7eb89a') + '55';
  const wordEl = document.getElementById('word');
  wordEl.textContent = v.w;
  // 长单词自适应字号，避免撑破 300px 宽的卡片
  wordEl.style.fontSize = v.w.length > 16 ? '20px' : v.w.length > 12 ? '24px' : v.w.length > 9 ? '28px' : '32px';
  document.getElementById('pos').textContent = v.p;
  // 音标 / 英文释义 / 例句来自增强词库，缺失时隐藏占位（不显示空行）
  const phEl = document.getElementById('ph');
  phEl.textContent = v.ph || '';
  phEl.style.display = v.ph ? '' : 'none';
  document.getElementById('def-cn').textContent = v.cn;
  const enEl = document.getElementById('def-en');
  enEl.textContent = v.en || '';
  enEl.style.display = v.en ? '' : 'none';
  const exEn = document.getElementById('ex-en'), exCn = document.getElementById('ex-cn');
  if (exEn) exEn.textContent = v.ee || '';
  if (exCn) exCn.textContent = v.ec || '';
  const exBox = document.getElementById('ex-box');
  if (exBox) exBox.style.display = (v.ee || v.ec) ? '' : 'none';

  const _inner = document.getElementById('card-inner');
  if (_inner) _inner.classList.remove('flipped');
  document.getElementById('hint').classList.remove('hide');
  revealed = false;

  // Update fav star
  const fb = document.getElementById('card-fav');
  if (favs.has(v.w)) { fb.textContent = '★'; fb.classList.add('on'); }
  else { fb.textContent = '☆'; fb.classList.remove('on'); }

  updateHUD();
  updateMiniBar();
  sizeCardBody();
  autoResize();
  setTimeout(() => speak(v.w), 350);
  } catch(e) { logError('renderCard', e); }
}

function revealAnswer() {
  const inner = document.getElementById('card-inner');
  if (!revealed) {
    revealed = true;
    const v = deck && deck[idx];
    if (v) {
      const wb = document.getElementById('word-back');
      const cb = document.getElementById('wcat-back');
      if (wb) wb.textContent = v.w;
      if (cb) cb.textContent = document.getElementById('wcat').textContent;
    }
    inner && inner.classList.add('flipped');
    document.getElementById('acts').style.display = 'flex';
    sizeCardBody();
    setTimeout(autoResize, 500);
  } else {
    revealed = false;
    inner && inner.classList.remove('flipped');
    document.getElementById('acts').style.display = 'none';
    sizeCardBody();
    setTimeout(autoResize, 480);
  }
}

function skipCard() { if (idx < deck.length) { idx++; renderCard(); } }
function prevCard() { if (idx > 0) { idx = Math.max(0, idx-1); renderCard(); } }

// SM-2 简化版：答错 → 重置并 2 分钟后再来；答对 → 间隔 1 天 / 3 天 / 7 天… 递增
function srsUpdate(word, passed) {
  const rec = srs[word] || { ef: 2.5, n: 0, iv: 0, due: 0 };
  const now = Date.now();
  if (passed) {
    rec.n = (rec.n || 0) + 1;
    rec.ef = Math.min(2.8, Math.max(1.3, (rec.ef || 2.5) + 0.1));
    if (rec.n === 1) rec.iv = SR_DAY;
    else if (rec.n === 2) rec.iv = 3 * SR_DAY;
    else rec.iv = Math.round(Math.max(SR_DAY, (rec.iv || SR_DAY) * (rec.ef || 2.5)));
    rec.due = now + rec.iv;
  } else {
    rec.n = 0;
    rec.ef = Math.max(1.3, (rec.ef || 2.5) - 0.2);
    rec.iv = SR_FAIL_MS;
    rec.due = now + SR_FAIL_MS;
  }
  srs[word] = rec;
}
function mark(isKnown) {
  const v = deck[idx]; if (!v) return;
  if (isKnown) { known.add(v.w); unknown.delete(v.w); streak++; }
  else { unknown.add(v.w); known.delete(v.w); streak = 0; }
  srsUpdate(v.w, isKnown);
  invalidateScope();
  dailyStats.count++;
  saveState();
  idx++;
  updateStreakBanner();
  renderCard();
}

function toggleFav(e) {
  e.stopPropagation();
  const v = deck[idx]; if (!v) return;
  if (favs.has(v.w)) favs.delete(v.w); else favs.add(v.w);
  invalidateScope();
  saveState();
  const fb = document.getElementById('card-fav');
  if (favs.has(v.w)) { fb.textContent = '★'; fb.classList.add('on'); }
  else { fb.textContent = '☆'; fb.classList.remove('on'); }
}

function showFinish() {
  document.getElementById('study-view').style.display = 'none';
  document.getElementById('finish-view').classList.add('on');
  document.getElementById('fin-title').textContent = isReview ? '🎯 复习完成！' : '🎉 本轮完成！';
  const c = scopeCounts();
  document.getElementById('fin-sub').textContent = isReview
    ? '点击返回正常学习'
    : '认识 ' + c.k + ' 个 · 还有 ' + c.u + ' 个需复习';
  document.getElementById('fk').textContent = c.k;
  document.getElementById('fu').textContent = c.u;
  document.getElementById('ff').textContent = c.f;
  var fbRev = document.getElementById('fb-rev');
  var fbFav = document.getElementById('fb-fav');
  if (isReview) {
    if (fbRev) { fbRev.style.display = ''; fbRev.textContent = '🔄 再练一次'; fbRev.onclick = function() { if (_reviewLabel === '收藏') reviewFav(); else reviewUnknown(); }; }
    if (fbFav) { fbFav.style.display = ''; fbFav.textContent = '🚪 返回正常学习'; fbFav.onclick = exitReview; }
  } else {
    if (fbRev) { fbRev.style.display = c.u > 0 ? '' : 'none'; fbRev.textContent = '复习不认识'; fbRev.onclick = reviewUnknown; }
    if (fbFav) { fbFav.style.display = c.f > 0 ? '' : 'none'; fbFav.textContent = '复习收藏'; fbFav.onclick = reviewFav; }
  }
  autoResize();
}

function reviewUnknown() {
  if (isReview) { exitReview(); return; }
  const words = ALL.filter(v => unknown.has(v.w));
  if (!words.length) return;
  isReview = true; _reviewLabel = '不认识';
  updateReviewBtn();
  buildDeck(words); renderCard();
}

function reviewFav() {
  if (isReview) { exitReview(); return; }
  const words = ALL.filter(v => favs.has(v.w));
  if (!words.length) return;
  isReview = true; _reviewLabel = '收藏';
  updateReviewBtn();
  buildDeck(words); renderCard();
}

function restartAll() {
  known.clear(); unknown.clear(); streak = 0;
  saveState(); isReview = false; buildDeck(getFilteredWords()); renderCard();
}

// Counts are relative to `scope` (the words in play), never global - otherwise
// switching filter or entering review showed impossible progress (>100%).
function invalidateScope() { _scopeCache = null; }
function scopeCounts() {
  if (_scopeCache) return _scopeCache;
  const base = (scope && scope.length) ? scope : getFilteredWords();
  let k = 0, u = 0, f = 0;
  base.forEach(v => {
    if (known.has(v.w)) k++;
    if (unknown.has(v.w)) u++;
    if (favs.has(v.w)) f++;
  });
  _scopeCache = { total: base.length, k: k, u: u, f: f, done: k + u };
  return _scopeCache;
}
function updateHUD() {
  const c = scopeCounts();
  document.getElementById('sk').textContent = c.k;
  document.getElementById('su').textContent = c.u;
  document.getElementById('strk').textContent = streak;
  const pct = c.total ? Math.round(c.done / c.total * 100) : 0;
  document.getElementById('pf').style.width = pct + '%';
  document.getElementById('pt').textContent = c.done + ' / ' + c.total;
  document.getElementById('pp').textContent = pct + '%';
  const fb2 = document.getElementById('filt-fav-btn');
  if (fb2) { fb2.classList.toggle('has-favs', favs.size > 0); }
}


// 卡片背面是绝对定位的，需要手动把容器撑到「正/背面较高的那个」高度，
// 否则背面的释义/例句会盖到进度条和按钮上。
function sizeCardBody() {
  try {
    const body = document.getElementById('body-click');
    const front = document.querySelector('.card-front');
    const back = document.querySelector('.card-back');
    if (!body || !front || !back) return;
    const h = revealed ? Math.max(front.offsetHeight, back.offsetHeight) : front.offsetHeight;
    body.style.height = h + 'px';
  } catch(e) {}
}

// ── Auto resize window height ────────────────────────────────────────────
function autoResize() {
  if (!ipc) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      const widget = document.getElementById('widget');
      const h = widget.offsetHeight + 2;
      if (ipc) ipc.send('win-resize', 300, h);   // 高度上限由主进程按屏幕工作区钳制
    });
  }, 80);
}

// ── Opacity ─────────────────────────────────────────────────────────────

function setOpacity(val) {
  const v = parseInt(val) / 100;
  if (ipc) ipc.send('win-opacity', v);
  else document.getElementById('widget').style.opacity = v;
  document.getElementById('opacity-range').value = val;
}


// ── Word Detail Modal ────────────────────────────────────────────────────
function openDetail(word) {
  const v = ALL.find(x => x.w === word);
  if (!v) return;
  window._detailWord = word;

  document.getElementById('detail-word').textContent = v.w;
  document.getElementById('detail-ph').textContent = v.ph ? v.ph : '';
  document.getElementById('detail-pos').textContent = v.p || '';
  document.getElementById('detail-cat').textContent = v.c || '';
  document.getElementById('detail-cn').textContent = v.cn;

  // English definition
  const enEl = document.getElementById('detail-en');
  enEl.textContent = v.en || '';
  enEl.style.display = v.en ? 'block' : 'none';

  // Example
  const exWrap = document.getElementById('detail-example-wrap');
  if (v.ee) {
    document.getElementById('detail-ex-en').textContent = v.ee;
    document.getElementById('detail-ex-cn').textContent = v.ec || '';
    exWrap.style.display = 'block';
  } else {
    exWrap.style.display = 'none';
  }

  // Status tags
  const ik = known.has(word), iu = unknown.has(word), ifav = favs.has(word);
  const sr = document.getElementById('detail-status-row');
  const tags = [];
  if (ik)   tags.push('<span class="detail-status known">✓ 已认识</span>');
  if (iu)   tags.push('<span class="detail-status unknown">✗ 待复习</span>');
  if (ifav) tags.push('<span class="detail-status faved">★ 已收藏</span>');
  if (!ik && !iu) tags.push('<span class="detail-status">未学习</span>');
  sr.innerHTML = tags.join('');

  // Action btn states
  document.getElementById('dbk').classList.toggle('on', ik);
  document.getElementById('dbu').classList.toggle('on', iu);
  document.getElementById('dbf').classList.toggle('on', ifav);

  document.getElementById('detail-overlay').classList.add('on');
  document.getElementById('word-detail').classList.add('on');

  // Auto speak
  speak(word);
}
function closeDetail() {
  document.getElementById('detail-overlay').classList.remove('on');
  document.getElementById('word-detail').classList.remove('on');
  window._detailWord = null;
}
function detailSpeak() {
  const word = window._detailWord; if (!word) return;
  const btn = document.getElementById('detail-speak-btn');
  if (btn) { btn.textContent = '…'; }
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US'; u.rate = 0.85;
  u.onend = () => { if (btn) btn.textContent = '♪'; };
  u.onerror = () => { if (btn) btn.textContent = '♪'; };
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function detailMark(action) {
  const word = window._detailWord; if (!word) return;
  if (action === 'k') { known.add(word); unknown.delete(word); }
  else if (action === 'u') { unknown.add(word); known.delete(word); }
  else if (action === 'f') { if (favs.has(word)) favs.delete(word); else favs.add(word); }
  invalidateScope();
  saveState(); updateHUD(); renderList();
  const ik = known.has(word), iu = unknown.has(word), ifav = favs.has(word);
  document.getElementById('dbk').classList.toggle('on', ik);
  document.getElementById('dbu').classList.toggle('on', iu);
  document.getElementById('dbf').classList.toggle('on', ifav);
  // refresh status tags
  const sr = document.getElementById('detail-status-row');
  if (sr) {
    const tags = [];
    if (ik)   tags.push('<span class="detail-status known">✓ 已认识</span>');
    if (iu)   tags.push('<span class="detail-status unknown">✗ 待复习</span>');
    if (ifav) tags.push('<span class="detail-status faved">★ 已收藏</span>');
    if (!ik && !iu) tags.push('<span class="detail-status">未学习</span>');
    sr.innerHTML = tags.join('');
  }
}

// ── Word List Panel ───────────────────────────────────────────────────────────────────────
function openList(tab) {
  const overlay = document.getElementById('list-overlay');
  if (overlay.classList.contains('on')) { closeList(); return; }
  listTab = tab || 'k';
  _listLimit = 200;
  _listSel = -1;
  overlay.classList.add('on');
  renderList();
}
function closeList() {
  document.getElementById('list-overlay').classList.remove('on');
}
function switchListTab(t) {
  listTab = t;
  _listLimit = 200;
  _listSel = -1;
  document.querySelectorAll('.ltab').forEach(b => b.classList.toggle('active', b.dataset.t===t));
  renderList();
}
// HTML-escape anything that goes into an attribute or text node
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function scheduleRenderList() {
  clearTimeout(_listTimer);
  _listTimer = setTimeout(renderList, 150);
}
function listMoveSel(delta) {
  const items = Array.prototype.slice.call(document.querySelectorAll('#list-body .list-item'));
  if (!items.length) return;
  _listSel = Math.max(0, Math.min(items.length - 1, (_listSel < 0 ? (delta > 0 ? 0 : items.length - 1) : _listSel + delta)));
  items.forEach((el, i) => el.classList.toggle('sel', i === _listSel));
  items[_listSel].scrollIntoView({ block: 'nearest' });
}
function listOpenSel() {
  const items = document.querySelectorAll('#list-body .list-item');
  const el = items[_listSel];
  if (el && el.dataset.w) openDetail(el.dataset.w);
}
function listLoadMore() { _listLimit += 200; renderList(); }
function renderList() {
  const body = document.getElementById('list-body');
  const countBar = document.getElementById('list-count-bar');
  let words;
  if (listTab==='k') words = ALL.filter(v => known.has(v.w));
  else if (listTab==='u') words = ALL.filter(v => unknown.has(v.w));
  else words = ALL.filter(v => favs.has(v.w));
  const q = (document.getElementById('list-search-input')?.value||'').trim().toLowerCase();
  if (q) words = words.filter(v => v.w.toLowerCase().includes(q) || (v.cn||'').toLowerCase().includes(q));
  const total = {k:known.size, u:unknown.size, f:favs.size}[listTab] || 0;
  if (countBar) {
    const shown = q ? words.length + ' / ' + total : total;
    const label = {k:'已认识', u:'不认识', f:'已收藏'}[listTab];
    countBar.textContent = label + ' ' + shown + ' 词' + (q ? '（搜索中）' : '');
  }
  if (!words.length) {
    const labels = {
      k:'还没有认识的单词\n学完一张卡片后点"认识"即可',
      u:'还没有不认识的单词',
      f:'还没有收藏的单词\n在卡片右上角点 ☆ 即可收藏'
    };
    const _icons = {k:'📖',u:'📝',f:'⭐'};
    body.innerHTML = '<div class="list-empty"><div class="list-empty-icon">'+(_icons[listTab]||'📋')+'</div>' + (labels[listTab]||'暂无数据').replace('\n','<br>') + '</div>';
    return;
  }
  const shown = words.slice(0, _listLimit);
  body.innerHTML = shown.map(v => {
    const ik = known.has(v.w), iu = unknown.has(v.w), ifav = favs.has(v.w);
    const dotCls = ik ? 'k' : iu ? 'u' : '';
    const ph = v.ph ? '<span class="li-ph">' + esc(v.ph) + '</span>' : '';
    const w = esc(v.w);
    return `<div class="list-item" data-w="${w}" role="listitem" tabindex="0" style="cursor:pointer">
      <div class="li-dot ${dotCls}"></div>
      <div style="flex:1;min-width:0">
        <div class="li-word-row">
          <span class="li-word">${w}</span>${ph}
        </div>
        <div class="li-cn">${esc(v.cn)}</div>
      </div>
      <div class="li-actions" data-stop="1">
        <button class="li-btn k ${ik?'on':''}" data-act="k" title="认识">✓</button>
        <button class="li-btn u ${iu?'on':''}" data-act="u" title="不认识">✗</button>
        <button class="li-btn f ${ifav?'on':''}" data-act="f" title="收藏">★</button>
      </div>
    </div>`;
  }).join('') + (words.length > shown.length
    ? '<div class="list-more" onclick="listLoadMore()">加载更多（' + shown.length + ' / ' + words.length + '）</div>'
    : '');
}
// Delegated clicks: word text is never interpolated into an inline handler
// (words like o'clock used to break the markup)
document.getElementById('list-body').addEventListener('click', function(e) {
  const row = e.target.closest('[data-w]');
  if (!row) return;
  const word = row.dataset.w;
  if (e.target.closest('[data-stop]')) {
    const b = e.target.closest('[data-act]');
    if (b) listMark(word, b.dataset.act);
    return;
  }
  openDetail(word);
});
// 键盘可达：聚焦到某一项后回车/空格打开详情
document.getElementById('list-body').addEventListener('keydown', function(e) {
  const row = e.target.closest('[data-w]');
  if (!row) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    openDetail(row.dataset.w);
  }
});
function listMark(word, action) {
  if (action==='k') { known.add(word); unknown.delete(word); }
  else if (action==='u') { unknown.add(word); known.delete(word); }
  else if (action==='f') { if(favs.has(word)) favs.delete(word); else favs.add(word); }
  invalidateScope();
  saveState();
  renderList();
  updateHUD();
}

// ── Mini mode ─────────────────────────────────────────────────────────────
function toggleMini() {
  isMini = !isMini;
  document.getElementById('widget').classList.toggle('mini', isMini);
  updateMiniBar();
  autoResize();
}
function updateMiniBar() {
  if (!isMini) return;
  var v = deck && deck[idx];
  if (!v) return;
  document.getElementById('mini-word').textContent = v.w;
  document.getElementById('mini-cn').textContent = v.cn;
  var c = scopeCounts();
  document.getElementById('mini-prog').textContent = c.done + '/' + c.total + ' (' + Math.round(c.done/Math.max(1,c.total)*100) + '%)';
}

// ── Daily streak banner ───────────────────────────────────────────────────
function updateStreakBanner() {
  const el = document.getElementById('streak-banner');
  if (dailyStats.dayStreak >= 2 || dailyStats.count >= 10) {
    el.classList.remove('hide');
    el.textContent = `🔥 连续学习 ${dailyStats.dayStreak} 天 · 今日已学 ${dailyStats.count} 词`;
  } else if (dailyStats.count > 0) {
    el.classList.remove('hide');
    el.textContent = `今日已学 ${dailyStats.count} 词`;
  } else {
    el.classList.add('hide');
  }
}

// ── TTS ───────────────────────────────────────────────────────────────────
// ── Pin / always-on-top toggle ──────────────────────────────────────────
function togglePin() {
  pinned = !pinned;
  const btn = document.getElementById('pin-btn');
  btn.classList.toggle('on', pinned);
  btn.title = pinned ? '取消置顶' : '置顶';
  btn.textContent = pinned ? '⊕' : '⊖';
  if (ipc) ipc.send('win-topmost', pinned);
}

function speakCurrent() { const _v = deck && deck[idx]; if (_v) speak(_v.w); }
function speak(word) {
  try {
    if (!window.speechSynthesis) return;
    if (isSilent) return;
    const w = word || (deck[idx] && deck[idx].w);
    if (!w) return;
    window.speechSynthesis.cancel();
    const btn = document.getElementById('speak-btn');
    if (btn) { btn.textContent = '…'; btn.style.color = '#7eb89a'; }
    const u = new SpeechSynthesisUtterance(w);
    u.onend = () => { if (btn) { btn.textContent = '♪'; btn.style.color = ''; } };
    u.onerror = () => { if (btn) { btn.textContent = '♪'; btn.style.color = ''; } };
    u.lang = 'en-US'; u.rate = 0.85;
    window.speechSynthesis.speak(u);
  } catch(e) {}
}



function miniToggleReveal() {
  if (!isMini) return;
  if (!revealed) revealAnswer();
  else { idx++; renderCard(); }
}
function reviewFavQuick() { reviewFav(); }
function updateReviewBtn() {
  var b = document.getElementById('filt-fav-btn');
  if (!b) return;
  if (isReview) {
    b.textContent = '退出复习';
    b.classList.add('reviewing');
    b.title = '点击退出复习模式';
  } else {
    b.textContent = '复习';
    b.classList.remove('reviewing');
    b.title = '复习收藏单词';
  }
}
function exitReview() {
  isReview = false; _reviewLabel = '';
  updateReviewBtn();
  buildDeck(getFilteredWords()); renderCard();
}

// ── Theme ─────────────────────────────────────────────────────────────────
function toggleThemePanel() {
  document.getElementById('theme-panel').classList.toggle('on');
}
function setTheme(cls) {
  const themes = ['theme-blue','theme-purple','theme-amber','theme-rose','theme-light'];
  // Apply to both html and widget so CSS vars cascade correctly
  const root = document.documentElement;
  const w = document.getElementById('widget');
  themes.forEach(c => { root.classList.remove(c); w.classList.remove(c); });
  if (cls) { root.classList.add(cls); w.classList.add(cls); }
  document.querySelectorAll('.theme-opt').forEach(o => {
    o.classList.toggle('active', o.dataset.theme === cls);
  });
  document.getElementById('theme-panel').classList.remove('on');
  try { localStorage.setItem('ielts_theme', cls); } catch(e) {}
  setTimeout(autoResize, 50);
}
// Load saved theme
(function() {
  try {
    const t = localStorage.getItem('ielts_theme');
    if (t) setTheme(t);
  } catch(e) {}
})();
// Close theme panel on outside click
document.addEventListener('click', e => {
  const panel = document.getElementById('theme-panel');
  const btn = document.getElementById('theme-btn');
  if (panel && panel.classList.contains('on') && !panel.contains(e.target) && e.target !== btn) {
    panel.classList.remove('on');
  }
});


// ── Custom Keybindings ────────────────────────────────────────────────────
const KB_KEY = 'ielts_keybindings';
const KB_DEFAULTS = {
  reveal:  [' ','Enter'],
  known:   ['ArrowRight','l'],
  unknown: ['ArrowLeft','h'],
  skip:    ['ArrowDown','s'],
  prev:    ['Backspace','z'],
  fav:     ['f'],
  speak:   ['p'],
  mini:    ['m'],
  anim:    ['a'],
  boss:    ['ctrl+shift+h'],
};
let KB = {};
function loadKeybindings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KB_KEY) || '{}');
    Object.keys(KB_DEFAULTS).forEach(k => {
      KB[k] = (saved[k] || KB_DEFAULTS[k]).map(normKey);
    });
  } catch(e) {
    Object.keys(KB_DEFAULTS).forEach(k => { KB[k] = KB_DEFAULTS[k].map(normKey); });
  }
}
// Space arrives as ' ' from the event but was stored as 'Space' by the keybinding
// tool, which silently killed the space shortcut; normalise both sides.
function normKey(k) {
  k = String(k == null ? '' : k);
  if (k === ' ') return ' ';
  const lk = k.toLowerCase();
  return (lk === 'space') ? ' ' : lk;
}
function matchKey(e, action) {
  return KB[action] && KB[action].includes(normKey(e.key));
}
function matchBossKey(e) {
  if (!KB['boss']) return false;
  return KB['boss'].some(function(bk) {
    var parts = bk.toLowerCase().split('+');
    var hasCtrl  = parts.includes('ctrl');
    var hasShift = parts.includes('shift');
    var hasAlt   = parts.includes('alt');
    var keyPart  = parts.filter(function(p) { return !['ctrl','shift','alt'].includes(p); })[0];
    return e.ctrlKey === hasCtrl && e.shiftKey === hasShift && e.altKey === hasAlt && e.key.toLowerCase() === keyPart;
  });
}
// Keep the OS-level global shortcut in sync with the user's custom boss key
function syncBossKey() {
  if (!ipc || !KB['boss'] || !KB['boss'][0]) return;
  try { ipc.send('set-boss-key', KB['boss'][0]); } catch(e) {}
}
function showTip(msg) {
  var el = document.getElementById('kb-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kb-tip';
    el.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);' +
      'max-width:272px;text-align:center;line-height:1.5;background:rgba(150,80,80,.94);' +
      'color:#fff;font-size:10px;padding:5px 12px;border-radius:12px;z-index:99999;' +
      'pointer-events:none;opacity:0;transition:opacity .25s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(function(){ el.style.opacity = '0'; }, 3800);
}
if (ipc && ipc.on) {
  ipc.on('bosskey-status', function(d) {
    if (!d || d.ok) return;
    var a = d.accel || '';
    if (d.reason === 'nomod') showTip('老板键必须含 Ctrl 或 Alt，已回退为 ' + a);
    else showTip('老板键 ' + a + ' 被占用，请到「改键位」换一个');
  });
  // 主进程用全局快捷键收录的生词，实时加进本次会话（并已写入自定义词库）
  ipc.on('word-picked', function(word) {
    if (!word) return;
    if (!WORD_MAP[word]) {
      const entry = { w: word, cn: '(待补充释义)', lv: 2, cat: 'h', p: '', ph: '', en: '', ee: '', ec: '', c: CAT_LABEL['h'], _custom: true };
      ALL.push(entry);
      WORD_MAP[word] = entry;
    }
    showTip('已加入生词本：' + word + '（「自定义」筛选可查看）');
  });
  // 其他窗口改了数据（清空记忆 / 词库管理）→ 立即同步界面
  ipc.on('data-changed', function() {
    if (syncFromDisk()) { updateHUD(); updateMiniBar(); try { renderList(); } catch(e) {} updateStreakBanner(); }
  });
}
loadKeybindings();
syncBossKey();
// Reload keybindings when window regains focus (user may have changed settings)
window.addEventListener('focus', () => { try { loadKeybindings(); syncBossKey(); } catch(e) {} });
function openKeybindings() {
  if (ipc) ipc.send('open-tool-keybindings');
  else window.open('keybindings.html');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
// Space / Enter  = reveal answer (or next card if already revealed)
// ArrowRight / K = mark known
// ArrowLeft  / J = mark unknown
// F              = toggle fav
// Escape         = close list panel
document.addEventListener('keydown', e => {
  // ── 列表面板打开时 ────────────────────────────────────────────
  if (document.getElementById('list-overlay').classList.contains('on')) {
    if (matchBossKey(e)) { e.preventDefault(); if(ipc) ipc.send('win-hide'); return; }
    if (e.key === 'ArrowDown' && e.target.tagName !== 'INPUT') { e.preventDefault(); listMoveSel(1); return; }
    if (e.key === 'ArrowUp' && e.target.tagName !== 'INPUT')   { e.preventDefault(); listMoveSel(-1); return; }
    if (e.key === 'Enter' && e.target.tagName !== 'INPUT')     { e.preventDefault(); listOpenSel(); return; }
    if (e.key === 'Escape') {
      // Close detail modal first if open
      const dw = document.getElementById('word-detail');
      if (dw && dw.classList.contains('on')) { closeDetail(); e.preventDefault(); return; }
      const si = document.getElementById('list-search-input');
      if (si && si.value) { si.value = ''; renderList(); si.blur(); }
      else { closeList(); }
      e.preventDefault();
    }
    return;
  }
  if (matchBossKey(e)) { e.preventDefault(); if(ipc) ipc.send('win-hide'); return; }
  // ── 首次启动引导打开时，任意键关闭 ─────────────────────────────
  const _gd = document.getElementById('guide-overlay');
  if (_gd && _gd.classList.contains('on')) {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeGuide(); }
    return;
  }
  // ── 完成页 ────────────────────────────────────────────────────
  if (document.getElementById('finish-view').classList.contains('on')) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restartAll(); }
    return;
  }
  // ── 学习页 ────────────────────────────────────────────────────
  // 不拦截输入框
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'F1')                  { e.preventDefault(); revealAnswer(); }
  else if (e.key === 'F2')           { if (revealed) { e.preventDefault(); mark(true); } }
  else if (e.key === 'F3')           { if (revealed) { e.preventDefault(); mark(false); } }
  else if (matchKey(e,'reveal'))     { e.preventDefault(); revealAnswer(); }
  else if (matchKey(e,'known'))      { if (revealed) { e.preventDefault(); mark(true); } }
  else if (matchKey(e,'unknown'))    { if (revealed) { e.preventDefault(); mark(false); } }
  else if (matchKey(e,'skip'))    { e.preventDefault(); skipCard(); }
  else if (matchKey(e,'prev'))    { e.preventDefault(); prevCard(); }
  else if (matchKey(e,'fav'))     { e.preventDefault(); toggleFav({ stopPropagation: () => {} }); }
  else if (matchKey(e,'speak'))   { e.preventDefault(); speakCurrent(); }
  else if (matchKey(e,'anim'))    { e.preventDefault(); toggleAnim(); }
  else if (matchKey(e,'mini'))    { e.preventDefault(); toggleMini(); }
  else if (matchKey(e,'boss'))    { e.preventDefault(); if(ipc) ipc.send('win-hide'); }
  else if (e.key === '1')         { e.preventDefault(); setFilter('c'); }
  else if (e.key === '2')         { e.preventDefault(); setFilter('h'); }
  else if (e.key === '3')         { e.preventDefault(); setFilter('b'); }
  else if (e.key === '4')         { e.preventDefault(); setFilter('all'); }
  else if (e.key === '5')         { e.preventDefault(); setFilter('x'); }
  else if (e.key === 'Escape')    { if (isReview) { exitReview(); } else { closeList(); } }
});
