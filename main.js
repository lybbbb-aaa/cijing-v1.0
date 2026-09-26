const electron = require('electron')
const app = electron.app
const BrowserWindow = electron.BrowserWindow
const ipcMain = electron.ipcMain
const screen = electron.screen
const globalShortcut = electron.globalShortcut
const path = require('path')
const fs = require('fs')
const shell = electron.shell
const clipboard = electron.clipboard
const Notification = electron.Notification

// 所有用户数据（进度 / 自定义词 / 窗口位置 / 错误日志）都放在同一个目录，
// 与渲染进程使用的路径保持一致，改应用名也不会分叉。
const DATA_DIR = path.join(process.env.APPDATA || app.getPath('userData'), 'ielts-widget')
const ICON = path.join(__dirname, 'assets', 'icon.ico')
const LOG_MAX = 256 * 1024

function logError(tag, err) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const p = path.join(DATA_DIR, 'error.log')
    try { if (fs.statSync(p).size > LOG_MAX) fs.writeFileSync(p, '', 'utf8') } catch (e) {}
    fs.appendFileSync(p,
      '[' + new Date().toISOString() + '] ' + tag + ': ' +
      (err && (err.stack || err.message) || String(err)) + '\n', 'utf8')
  } catch (e) {}
}
process.on('uncaughtException', e => logError('main.uncaughtException', e))
process.on('unhandledRejection', e => logError('main.unhandledRejection', e))

let win = null
let winVisible = true

// Window position persistence
let statePath

function loadWinState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch(e) { return null }
}

let _saveWinTimer = null
function saveWinState() {
  // Debounced: 'moved'/'resized' fire per pixel while dragging
  if (_saveWinTimer) clearTimeout(_saveWinTimer)
  _saveWinTimer = setTimeout(writeWinState, 400)
}
function writeWinState() {
  if (_saveWinTimer) { clearTimeout(_saveWinTimer); _saveWinTimer = null }
  if (!win || win.isDestroyed() || !statePath) return
  try {
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    fs.writeFileSync(statePath, JSON.stringify({ x, y, w, h }), 'utf8')
  } catch(e) {}
}

// Keep at least a 40px sliver of the window reachable on some display
const EDGE = 40
function clampToScreen(x, y, w, h) {
  const displays = screen.getAllDisplays()
  if (!displays.length) return { x: Math.round(x), y: Math.round(y) }
  const left   = Math.min.apply(null, displays.map(d => d.workArea.x))
  const top    = Math.min.apply(null, displays.map(d => d.workArea.y))
  const right  = Math.max.apply(null, displays.map(d => d.workArea.x + d.workArea.width))
  const bottom = Math.max.apply(null, displays.map(d => d.workArea.y + d.workArea.height))
  return {
    x: Math.round(Math.min(Math.max(x, left - w + EDGE), right - EDGE)),
    y: Math.round(Math.min(Math.max(y, top), bottom - EDGE)),
  }
}

function rectOnScreen(x, y, w, h) {
  return screen.getAllDisplays().some(d => {
    const b = d.workArea
    return x + w > b.x && x < b.x + b.width && y + h > b.y && y < b.y + b.height
  })
}

// ── Tool windows (single definition, reused everywhere) ──────────────────
const TOOLS = {
  'tool=reset':       { file: 'reset.html',         w: 400, h: 600, title: '\u8bcd\u5883 \u00b7 \u6e05\u7a7a\u8bb0\u5fc6' },
  'tool=keybindings': { file: 'keybindings.html',   w: 400, h: 560, title: '\u8bcd\u5883 \u00b7 \u952e\u4f4d\u8bbe\u7f6e' },
  'tool=vocab':       { file: 'vocab-manager.html', w: 520, h: 660, title: '\u8bcd\u5883 \u00b7 \u8bcd\u5e93\u7ba1\u7406' },
}
const launchArgs = process.argv.join(' ')
const launchTool = Object.keys(TOOLS).find(k => launchArgs.includes(k)) || null

const _toolWins = {}
function openToolWin(key, quitOnClose) {
  const t = TOOLS[key]
  if (!t) return
  if (_toolWins[key] && !_toolWins[key].isDestroyed()) { _toolWins[key].show(); _toolWins[key].focus(); return }
  const tw = new BrowserWindow({
    width: t.w, height: t.h, title: t.title, icon: ICON,
    autoHideMenuBar: true, resizable: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js') }
  })
  tw.loadFile(path.join(__dirname, t.file))
  tw.once('ready-to-show', () => tw.show())
  attachCrashGuard(tw, key, () => { if (tw && !tw.isDestroyed()) tw.webContents.reload() })
  tw.on('closed', () => {
    delete _toolWins[key]
    if (quitOnClose) app.quit()
  })
  _toolWins[key] = tw
}

// ── Boss key (follows the user's custom binding, with conflict fallback) ──
const DEFAULT_BOSS = 'ctrl+shift+h'
let _bossAccel = null

function toAccelerator(k) {
  const parts = String(k || '').toLowerCase().split('+').filter(Boolean)
  const mods = []
  if (parts.includes('ctrl') || parts.includes('control')) mods.push('CommandOrControl')
  if (parts.includes('shift')) mods.push('Shift')
  if (parts.includes('alt'))   mods.push('Alt')
  const raw = parts.filter(p => !['ctrl','control','shift','alt'].includes(p))[0] || 'h'
  const named = {
    ' ':'Space', 'space':'Space', 'enter':'Enter', 'return':'Enter',
    'escape':'Escape', 'esc':'Escape', 'backspace':'Backspace', 'tab':'Tab', 'delete':'Delete',
    'arrowup':'Up', 'arrowdown':'Down', 'arrowleft':'Left', 'arrowright':'Right'
  }
  const key = named[raw] || (raw.length === 1 ? raw.toUpperCase() : raw.charAt(0).toUpperCase() + raw.slice(1))
  return mods.concat([key]).join('+')
}

// A modifier-free boss key would swallow a bare letter system-wide
function bossKeyHasModifier(k) {
  const parts = String(k || '').toLowerCase().split('+')
  return parts.includes('ctrl') || parts.includes('control') || parts.includes('alt')
}

function notifyBossKey(ok, accel, reason) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send('bosskey-status', { ok: !!ok, accel: accel || '', reason: reason || '' })
  }
}

function registerBossKey(preferred) {
  const raw     = String(preferred || DEFAULT_BOSS)
  const badMod  = !bossKeyHasModifier(raw)
  const accel   = toAccelerator(badMod ? DEFAULT_BOSS : raw)

  if (!badMod && _bossAccel === accel && globalShortcut.isRegistered(accel)) {
    notifyBossKey(true, accel)
    return true
  }

  let ok = false
  try { ok = globalShortcut.register(accel, toggleVisibility) } catch(e) { ok = false }

  if (ok) {
    if (_bossAccel && _bossAccel !== accel) {
      try { globalShortcut.unregister(_bossAccel) } catch(e) {}
    }
    _bossAccel = accel
    notifyBossKey(!badMod, accel, badMod ? 'nomod' : '')
    return !badMod
  }

  // Registration failed (usually taken by another app). Keep or restore the
  // default so the user is never left without a working boss key.
  if (!_bossAccel || !globalShortcut.isRegistered(_bossAccel)) {
    const d = toAccelerator(DEFAULT_BOSS)
    if (d !== accel) {
      try { if (globalShortcut.register(d, toggleVisibility)) _bossAccel = d } catch(e) {}
    }
  }
  notifyBossKey(false, accel, 'conflict')
  return false
}

// ── 崩溃自愈：渲染进程挂了自动重载，短时间反复崩溃则问用户怎么处理 ────────
const _crashLog = {}

function maxWindowHeight() {
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return Math.max(200, Math.min(900, d.workAreaSize.height - 80))
  } catch (e) { return 560 }
}

function askAfterRepeatedCrash(label) {
  try {
    const r = electron.dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : null, {
      type: 'error',
      title: '\u8bcd\u5883',
      message: '\u754c\u9762\u7ec4\u4ef6\u53cd\u590d\u5d29\u6e83',
      detail: '\u5df2\u5c1d\u8bd5\u81ea\u52a8\u6062\u590d\u591a\u6b21\u3002\u53ef\u4ee5\u91cd\u65b0\u52a0\u8f7d\u754c\u9762\uff0c\u6216\u9000\u51fa\u540e\u91cd\u5f00\u7a0b\u5e8f\u3002\n\u65e5\u5fd7\uff1a%APPDATA%\\ielts-widget\\error.log',
      buttons: ['\u91cd\u65b0\u52a0\u8f7d', '\u9000\u51fa'],
      defaultId: 0,
      cancelId: 1
    })
    if (r === 0) { try { win && win.webContents.reload() } catch (e) {} }
    else app.quit()
  } catch (e) { logError('crash-dialog:' + label, e) }
}

function attachCrashGuard(bw, label, reloadFn) {
  const wc = bw.webContents
  const bump = () => {
    const now = Date.now()
    const arr = (_crashLog[label] || []).filter(t => now - t < 60000)
    arr.push(now)
    _crashLog[label] = arr
    return arr.length
  }
  wc.on('render-process-gone', (e, details) => {
    logError('render-process-gone:' + label, new Error(JSON.stringify(details)))
    if (details && details.reason === 'clean-exit') return
    if (bump() <= 3) setTimeout(() => { try { reloadFn() } catch (err) { logError('reload:' + label, err) } }, 800)
    else askAfterRepeatedCrash(label)
  })
  wc.on('unresponsive', () => {
    logError('unresponsive:' + label, new Error('renderer unresponsive'))
    if (bump() <= 3) setTimeout(() => { try { wc.reload() } catch (err) {} }, 500)
  })
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) logError('did-fail-load:' + label, new Error(code + ' ' + desc + ' ' + url))
  })
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const saved = loadWinState()
  const wh = Math.min(Math.max((saved && saved.h) ? saved.h : 460, 160), maxWindowHeight())

  let wx = width - 310
  let wy = 20
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) &&
      rectOnScreen(saved.x, saved.y, 300, wh)) {
    wx = saved.x
    wy = saved.y
  }

  win = new BrowserWindow({
    width: 300, height: wh, x: Math.round(wx), y: Math.round(wy), icon: ICON,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js') }
  })

  win.loadFile(path.join(__dirname, 'widget.html'))
  win.once('ready-to-show', () => win.show())
  attachCrashGuard(win, 'widget', () => { if (win && !win.isDestroyed()) win.webContents.reload() })
  win.on('moved',   saveWinState)
  win.on('resized', saveWinState)
  win.on('close',   writeWinState)
  win.on('closed',  () => { win = null })
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) return
  if (winVisible) { win.hide(); winVisible = false }
  else            { win.show(); win.focus(); winVisible = true }
}

function bootstrap() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch(e) {}
  statePath = path.join(DATA_DIR, 'win-state.json')

  if (launchTool) { openToolWin(launchTool, true); return }

  createWindow()
  registerBossKey()
  registerPickKey()
}

// Single instance: a second launch either opens a tool or resurfaces the widget
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    const key = Object.keys(TOOLS).find(k => (argv || []).join(' ').includes(k))
    if (key) { openToolWin(key, false); return }
    if (!win || win.isDestroyed()) { createWindow(); registerBossKey(); registerPickKey(); return }
    win.show(); win.focus(); winVisible = true
  })

  app.whenReady().then(() => {
    bootstrap()
    // 显示器分辨率/缩放变化后重新钳制窗口，避免飘到屏幕外或超出工作区
    try {
      screen.on('display-metrics-changed', () => {
        if (!win || win.isDestroyed()) return
        const [w, h] = win.getSize()
        const [x, y] = win.getPosition()
        const p = clampToScreen(x, y, w, h)
        win.setSize(w, Math.min(h, maxWindowHeight()))
        win.setPosition(p.x, p.y)
      })
    } catch (e) { logError('display-metrics-changed', e) }
  })
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); writeWinState() })
app.on('window-all-closed', () => app.quit())

// IPC - tool windows
ipcMain.on('open-tool-reset',       () => openToolWin('tool=reset',       false))
ipcMain.on('open-tool-keybindings', () => openToolWin('tool=keybindings', false))
ipcMain.on('open-tool-vocab',       () => openToolWin('tool=vocab',       false))

// IPC - window control
ipcMain.on('win-quit',    ()        => { writeWinState(); app.quit() })
ipcMain.on('win-opacity', (_, v)    => { if (win && !win.isDestroyed()) win.setOpacity(v) })
ipcMain.on('win-resize',  (_, w, h) => { if (win && !win.isDestroyed()) { win.setSize(w, Math.min(Math.max(Math.round(h) || 0, 160), maxWindowHeight())); saveWinState() } })
ipcMain.on('win-topmost', (_, v)    => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(v) })
ipcMain.on('win-hide',    ()        => { if (win && !win.isDestroyed()) { win.hide(); winVisible = false } })
ipcMain.on('win-show',    ()        => { if (win && !win.isDestroyed()) { win.show(); win.focus(); winVisible = true } })
ipcMain.on('win-toggle',  ()        => toggleVisibility())

// IPC - boss key changed in the keybinding tool
ipcMain.on('set-boss-key', (_, k) => { if (win && !win.isDestroyed()) registerBossKey(k) })

// IPC - drag
let _dragBase = null
ipcMain.on('win-drag-start', (_, sx, sy) => {
  if (!win || win.isDestroyed()) return
  const [wx, wy] = win.getPosition()
  _dragBase = { sx, sy, wx, wy }
})
ipcMain.on('win-drag-move', (_, sx, sy) => {
  if (!win || win.isDestroyed() || !_dragBase) return
  const [w, h] = win.getSize()
  const p = clampToScreen(_dragBase.wx + (sx - _dragBase.sx), _dragBase.wy + (sy - _dragBase.sy), w, h)
  win.setPosition(p.x, p.y)
})
ipcMain.on('win-drag-end', () => { _dragBase = null; saveWinState() })

// ── 复制取词：全局快捷键把剪贴板里的英文单词加进生词本 ────────────────────
const PICK_ACCEL = 'CommandOrControl+Shift+D'
let _pickAccel = null
let _baseSet = null

function baseWordSet() {
  if (!_baseSet) {
    try {
      const v = require('./vocab.js')
      _baseSet = new Set(v.map(x => String(x[0]).toLowerCase()))
    } catch (e) { _baseSet = new Set() }
  }
  return _baseSet
}

function customFile() { return path.join(DATA_DIR, 'custom_vocab.json') }

function loadCustomFile() {
  try { return JSON.parse(fs.readFileSync(customFile(), 'utf8')) } catch (e) { return null }
}

function saveCustomFile(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(customFile(), JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { logError('saveCustomFile', e) }
}

function notify(body) {
  try { new Notification({ title: '\u8bcd\u5883', body: body }).show() } catch (e) {}
}

// 复制一段文本后按 Ctrl+Shift+D，取其中第一个英文单词收进生词本
function pickWordFromClipboard() {
  try {
    const raw = String(clipboard.readText() || '').trim()
    if (!raw) { notify('\u526a\u8d34\u677f\u662f\u7a7a\u7684\uff0c\u5148\u590d\u5236\u4e00\u4e2a\u5355\u8bcd'); return }
    const m = raw.match(/[A-Za-z][A-Za-z'\-]{1,39}/)
    if (!m) { notify('\u6ca1\u6709\u627e\u5230\u82f1\u6587\u5355\u8bcd'); return }
    const word = m[0].toLowerCase().replace(/^[-']+|[-']+$/g, '')
    if (word.length < 2) return
    if (baseWordSet().has(word)) { notify('\u300c' + word + '\u300d\u5df2\u5728\u8bcd\u5e93\u4e2d'); return }
    const data = loadCustomFile() || { words: [], deleted: [], categories: {}, priority: [] }
    if (!Array.isArray(data.words)) data.words = []
    if (data.words.some(x => x && x.w === word)) { notify('\u300c' + word + '\u300d\u5df2\u5728\u751f\u8bcd\u672c\u4e2d'); return }
    data.words.push({ w: word, cn: '', cat: 'h', p: '', ph: '', en: '', ee: '' })
    if (Array.isArray(data.deleted)) data.deleted = data.deleted.filter(x => x !== word)
    saveCustomFile(data)
    notify('\u5df2\u52a0\u5165\u751f\u8bcd\u672c\uff1a' + word)
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('word-picked', word)
    }
  } catch (e) { logError('pickWordFromClipboard', e) }
}

function registerPickKey() {
  if (_pickAccel && globalShortcut.isRegistered(_pickAccel)) return true
  let ok = false
  try { ok = globalShortcut.register(PICK_ACCEL, pickWordFromClipboard) } catch (e) { ok = false }
  if (ok) { _pickAccel = PICK_ACCEL; return true }
  logError('registerPickKey', new Error('\u5feb\u6377\u952e\u88ab\u5360\u7528: ' + PICK_ACCEL))
  return false
}

// ── IPC - 外部链接 / 数据目录 / 备份对话框 ───────────────────────────────
const EXTERNAL_ALLOW = ['github.com', 'www.github.com', 'docs.github.com', 'afdian.com', 'www.afdian.com']

ipcMain.on('open-external', (_, url) => {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'https:' || EXTERNAL_ALLOW.indexOf(u.hostname) === -1) {
      logError('open-external', new Error('\u5df2\u62e6\u622a\u975e\u767d\u540d\u5355\u94fe\u63a5: ' + url))
      return
    }
    shell.openExternal(u.toString())
  } catch (e) { logError('open-external', e) }
})

ipcMain.on('open-data-dir', () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); shell.openPath(DATA_DIR) } catch (e) { logError('open-data-dir', e) } })

// 托盘口子：某个窗口改了数据，通知所有窗口刷新（避免多窗口互相覆盖）
ipcMain.on('notify-data-changed', (_, what) => {
  try {
    BrowserWindow.getAllWindows().forEach(w => {
      if (w.isDestroyed() || !w.webContents || w.webContents.isDestroyed()) return
      w.webContents.send('data-changed', String(what || 'all'))
    })
  } catch (e) { logError('notify-data-changed', e) }
})

// 打开包内文档（白名单）
const DOC_ALLOW = ['CHANGELOG.md', 'README.md', 'LICENSE']
ipcMain.on('open-doc', (_, name) => {
  try {
    const n = String(name || '')
    if (DOC_ALLOW.indexOf(n) === -1) { logError('open-doc', new Error('\u975e\u767d\u540d\u5355\u6587\u6863: ' + n)); return }
    shell.openPath(path.join(__dirname, n))
  } catch (e) { logError('open-doc', e) }
})

// ── 开机自启 ────────────────────────────────────────────────────────────
ipcMain.handle('get-autostart', () => {
  try { return !!app.getLoginItemSettings().openAtLogin } catch (e) { logError('get-autostart', e); return false }
})

ipcMain.on('set-autostart', (_, on) => {
  try { app.setLoginItemSettings({ openAtLogin: !!on }) } catch (e) { logError('set-autostart', e) }
})

ipcMain.on('open-error-log', () => {
  try {
    const p = path.join(DATA_DIR, 'error.log')
    if (!fs.existsSync(p)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(p, '', 'utf8') }
    shell.openPath(p)
  } catch (e) { logError('open-error-log', e) }
})

function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

ipcMain.handle('export-backup', async () => {
  try {
    const dialog = electron.dialog
    const r = await dialog.showSaveDialog(win, {
      title: '\u5bfc\u51fa\u5b66\u4e60\u5907\u4efd',
      defaultPath: path.join(app.getPath('desktop'), 'cijing-backup-' + new Date().toISOString().slice(0, 10) + '.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    const payload = {
      app: 'cijing', version: app.getVersion(), exportedAt: new Date().toISOString(),
      progress: readJsonSafe(path.join(DATA_DIR, 'progress.json')),
      custom: readJsonSafe(path.join(DATA_DIR, 'custom_vocab.json'))
    }
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: r.filePath }
  } catch (e) { logError('export-backup', e); return { ok: false, error: String(e && e.message || e) } }
})

ipcMain.handle('import-backup', async () => {
  try {
    const dialog = electron.dialog
    const r = await dialog.showOpenDialog(win, {
      title: '\u9009\u62e9\u5b66\u4e60\u5907\u4efd\u6587\u4ef6',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true }
    const payload = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
    if (!payload || payload.app !== 'cijing') return { ok: false, error: '\u4e0d\u662f\u8bcd\u5883\u7684\u5907\u4efd\u6587\u4ef6' }
    // \u7ed3\u6784\u6821\u9a8c\uff1a\u5b81\u53ef\u5426\u6389\uff0c\u4e5f\u4e0d\u80fd\u62ff\u574f\u6587\u4ef6\u8986\u76d6\u7528\u6237\u8fdb\u5ea6
    const p = payload.progress
    if (p != null) {
      const badField = ['known', 'unknown', 'favs'].find(k => p[k] != null && !Array.isArray(p[k]))
      if (typeof p !== 'object' || badField) return { ok: false, error: '\u5907\u4efd\u91cc\u7684\u8fdb\u5ea6\u6570\u636e\u683c\u5f0f\u4e0d\u5bf9' }
    }
    const c = payload.custom
    if (c != null && (typeof c !== 'object' || (c.words != null && !Array.isArray(c.words)))) {
      return { ok: false, error: '\u5907\u4efd\u91cc\u7684\u81ea\u5b9a\u4e49\u8bcd\u5e93\u683c\u5f0f\u4e0d\u5bf9' }
    }
    if (p == null && c == null) return { ok: false, error: '\u5907\u4efd\u6587\u4ef6\u91cc\u6ca1\u6709\u53ef\u5bfc\u5165\u7684\u6570\u636e' }
    // \u8986\u76d6\u524d\u5148\u7ed9\u73b0\u6709\u6570\u636e\u7559\u4e00\u4efd\u540e\u6094\u836f
    fs.mkdirSync(DATA_DIR, { recursive: true })
    for (const name of ['progress.json', 'custom_vocab.json']) {
      const src = path.join(DATA_DIR, name)
      try { if (fs.existsSync(src)) fs.copyFileSync(src, src + '.pre-import.bak') } catch (e) {}
    }
    if (p) fs.writeFileSync(path.join(DATA_DIR, 'progress.json'), JSON.stringify(p), 'utf8')
    if (c) fs.writeFileSync(path.join(DATA_DIR, 'custom_vocab.json'), JSON.stringify(c, null, 2), 'utf8')
    return { ok: true, path: r.filePaths[0] }
  } catch (e) { logError('import-backup', e); return { ok: false, error: String(e && e.message || e) } }
})
