const electron = require('electron')
const app = electron.app
const BrowserWindow = electron.BrowserWindow
const ipcMain = electron.ipcMain
const screen = electron.screen
const globalShortcut = electron.globalShortcut
const path = require('path')
const fs = require('fs')

let win = null
let winVisible = true

// Window position persistence
let statePath

function loadWinState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch(e) { return null }
}

function saveWinState() {
  if (!win || win.isDestroyed()) return
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
    width: t.w, height: t.h, title: t.title,
    autoHideMenuBar: true, resizable: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  tw.loadFile(path.join(__dirname, t.file))
  tw.once('ready-to-show', () => tw.show())
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

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const saved = loadWinState()
  const wh = Math.min(Math.max((saved && saved.h) ? saved.h : 460, 160), 540)

  let wx = width - 310
  let wy = 20
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) &&
      rectOnScreen(saved.x, saved.y, 300, wh)) {
    wx = saved.x
    wy = saved.y
  }

  win = new BrowserWindow({
    width: 300, height: wh, x: Math.round(wx), y: Math.round(wy),
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })

  win.loadFile(path.join(__dirname, 'widget.html'))
  win.once('ready-to-show', () => win.show())
  win.on('moved',   saveWinState)
  win.on('resized', saveWinState)
  win.on('close',   saveWinState)
  win.on('closed',  () => { win = null })
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) return
  if (winVisible) { win.hide(); winVisible = false }
  else            { win.show(); win.focus(); winVisible = true }
}

function bootstrap() {
  statePath = path.join(app.getPath('userData'), 'win-state.json')

  if (launchTool) { openToolWin(launchTool, true); return }

  createWindow()
  registerBossKey()
}

// Single instance: a second launch either opens a tool or resurfaces the widget
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    const key = Object.keys(TOOLS).find(k => (argv || []).join(' ').includes(k))
    if (key) { openToolWin(key, false); return }
    if (!win || win.isDestroyed()) { createWindow(); registerBossKey(); return }
    win.show(); win.focus(); winVisible = true
  })

  app.whenReady().then(bootstrap)
}

app.on('will-quit', () => { globalShortcut.unregisterAll(); saveWinState() })
app.on('window-all-closed', () => app.quit())

// IPC - tool windows
ipcMain.on('open-tool-reset',       () => openToolWin('tool=reset',       false))
ipcMain.on('open-tool-keybindings', () => openToolWin('tool=keybindings', false))
ipcMain.on('open-tool-vocab',       () => openToolWin('tool=vocab',       false))

// IPC - window control
ipcMain.on('win-quit',    ()        => { saveWinState(); app.quit() })
ipcMain.on('win-opacity', (_, v)    => { if (win && !win.isDestroyed()) win.setOpacity(v) })
ipcMain.on('win-resize',  (_, w, h) => { if (win && !win.isDestroyed()) { win.setSize(w, h); saveWinState() } })
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
