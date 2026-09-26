// 词境 · 核心逻辑单元测试
// 直接从 src/widget.js 抽取被改动的函数，用桩环境跑断言，保证测试与实现同源。
// 运行： node tests/widget_logic.test.js    （或 npm test）
'use strict'
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget.js'), 'utf8')

// ── 花括号配对抽取函数 ─────────────────────────────────────────────────────
function extract(name) {
  const re = new RegExp('\\nfunction\\s+' + name + '\\s*\\(')
  const m = re.exec(SRC)
  if (!m) throw new Error('function not found: ' + name)
  const start = SRC.indexOf('{', m.index)
  let depth = 0
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(m.index, i + 1)
    }
  }
  throw new Error('unbalanced braces: ' + name)
}

const NAMES = ['normKey', 'matchKey', 'esc', 'scopeCounts', 'invalidateScope', 'srsUpdate', 'pumpSR', 'buildDeck']
const body = NAMES.map(extract).join('\n\n')

// ── 桩环境 ────────────────────────────────────────────────────────────────
const stubs = `
let KB = { reveal:[' ','enter'], known:['arrowright','l'], boss:['ctrl+shift+h'] };
const SR_FAIL_MS = 2 * 60 * 1000;
const SR_DAY = 24 * 60 * 60 * 1000;
let deck = [], idx = 0, isReview = false, scope = [];
let known = new Set(), unknown = new Set(), favs = new Set();
let srs = {}, ALL = [];
let _scopeCache = null;
function invalidateScope() { _scopeCache = null; }
function shuffle(a) { return a; }
function getFilteredWords() { return ALL; }
`
const harness = stubs + body + '\nmodule.exports = { normKey, matchKey, esc, scopeCounts, invalidateScope, srsUpdate, pumpSR, buildDeck,\n' +
  '  st: { get KB(){return KB}, set KB(v){KB=v}, get deck(){return deck}, set deck(v){deck=v},\n' +
  '        get idx(){return idx}, set idx(v){idx=v}, get isReview(){return isReview}, set isReview(v){isReview=v},\n' +
  '        get scope(){return scope}, set scope(v){scope=v}, get known(){return known}, set known(v){known=v},\n' +
  '        get unknown(){return unknown}, set unknown(v){unknown=v}, get favs(){return favs}, set favs(v){favs=v},\n' +
  '        get srs(){return srs}, set srs(v){srs=v}, get ALL(){return ALL}, set ALL(v){ALL=v} } };'

const mod = { exports: {} }
new Function('module', 'exports', harness)(mod, mod.exports)
const api = mod.exports
const st = api.st

// ── 断言工具 ──────────────────────────────────────────────────────────────
let failed = 0
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? '' : '   got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)))
}
function section(t) { console.log('\n' + t) }

// ── 1. 空格键归一化（改键位保存后空格失效的回归） ──────────────────────────
section('1. normKey / matchKey')
eq('normKey(" ")', api.normKey(' '), ' ')
eq('normKey("Space")', api.normKey('Space'), ' ')
eq('normKey("ArrowRight")', api.normKey('ArrowRight'), 'arrowright')
eq('matchKey space', api.matchKey({ key: ' ' }, 'reveal'), true)
eq('matchKey ArrowRight', api.matchKey({ key: 'ArrowRight' }, 'known'), true)
eq('matchKey 未绑定键', api.matchKey({ key: 'x' }, 'known'), false)
eq('旧版存成 "space" 也能命中', st.KB.reveal.map(api.normKey).indexOf(api.normKey(' ')) >= 0, true)

// ── 2. HTML 转义（o'clock 之类破坏界面） ──────────────────────────────────
section('2. esc')
eq("esc(o'clock)", api.esc("o'clock"), 'o&#39;clock')
eq('esc 混合字符', api.esc('a<b&"c">d'), 'a&lt;b&amp;&quot;c&quot;&gt;d')
eq('esc(null)', api.esc(null), '')

// ── 3. 进度统计以当前卡组为准 ──────────────────────────────────────────────
section('3. scopeCounts')
st.scope = [{ w: 'a' }, { w: 'b' }, { w: 'c' }]
st.known = new Set(['a', 'zzz'])
st.unknown = new Set(['b', 'yyy'])
st.favs = new Set(['c'])
api.invalidateScope()
const c = api.scopeCounts()
eq('total', c.total, 3)
eq('known（不含卡组外的 zzz）', c.k, 1)
eq('unknown', c.u, 1)
eq('favs', c.f, 1)
eq('done', c.done, 2)
eq('百分比 <= 100', c.done / c.total * 100 <= 100, true)

// ── 4. SM-2 难度/间隔 ────────────────────────────────────────────────────
section('4. srsUpdate (SM-2)')
st.srs = {}
api.srsUpdate('alpha', false)
eq('答错：n 归零', st.srs.alpha.n, 0)
eq('答错：2 分钟后再来', st.srs.alpha.iv, 2 * 60 * 1000)
eq('答错：难度系数降到 2.3', Math.round(st.srs.alpha.ef * 10) / 10, 2.3)
api.srsUpdate('alpha', true)
eq('答对：n=1', st.srs.alpha.n, 1)
eq('答对：间隔 1 天', st.srs.alpha.iv, 24 * 60 * 60 * 1000)
api.srsUpdate('alpha', true)
eq('答对第二次：间隔 3 天', st.srs.alpha.iv, 3 * 24 * 60 * 60 * 1000)
api.srsUpdate('alpha', true)
eq('答对第三次：按难度递增（>=3 天）', st.srs.alpha.iv >= 3 * 24 * 60 * 60 * 1000, true)
for (let i = 0; i < 30; i++) api.srsUpdate('beta', false)
eq('难度系数下限 1.3', Math.round(st.srs.beta.ef * 10) / 10, 1.3)

// ── 5. pumpSR：到期复习词插回卡组 ────────────────────────────────────────
section('5. pumpSR')
st.scope = [{ w: 'w0' }, { w: 'w1' }, { w: 'x' }]
st.deck = [{ w: 'w0' }, { w: 'w1' }, { w: 'x' }, { w: 'w2' }, { w: 'w3' }, { w: 'w4' }]
st.idx = 0
st.isReview = false
st.srs = { x: { ef: 2.5, n: 0, iv: 1000, due: Date.now() - 1 } }
api.pumpSR()
eq('到期词插到 idx+4 之后', st.deck.map(v => v.w), ['w0', 'w1', 'x', 'w2', 'x', 'w3', 'w4'])
eq('插入项带 _sr 标记', st.deck[4]._sr, true)
api.pumpSR()
eq('同一词不重复插入', st.deck.filter(v => v.w === 'x').length, 2)
st.deck = [{ w: 'w0' }]
st.srs = { x: { ef: 2.5, n: 0, iv: 1000, due: Date.now() + 60000 } }
api.pumpSR()
eq('未到期不插入', st.deck.length, 1)
st.deck = [{ w: 'w0' }]
st.srs = { x: { ef: 2.5, n: 0, iv: 1000, due: Date.now() - 1 } }
st.isReview = true
api.pumpSR()
eq('复习模式不插入', st.deck.length, 1)
st.isReview = false

// ── 6. buildDeck：到期词参与组卡且不重复 ─────────────────────────────────
section('6. buildDeck')
st.srs = { b: { ef: 2.5, n: 1, iv: 1000, due: Date.now() - 1 } }
api.buildDeck([{ w: 'a' }, { w: 'b' }, { w: 'c' }, { w: 'd' }, { w: 'e' }, { w: 'f' }])
eq('卡组包含全部词', st.deck.length, 6)
eq('到期词只出现一次', st.deck.filter(v => v.w === 'b').length, 1)
eq('所有词都在卡组里', ['a', 'b', 'c', 'd', 'e', 'f'].every(w => st.deck.some(v => v.w === w)), true)
eq('idx 归零', st.idx, 0)

console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : failed + ' TEST(S) FAILED'))
process.exit(failed === 0 ? 0 : 1)
