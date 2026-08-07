const electron = require('electron')
const app = electron.app
const BrowserWindow = electron.BrowserWindow
const ipcMain = electron.ipcMain
const screen = electron.screen
const globalShortcut = electron.globalShortcut
const path = require('path')
const fs = require('fs')

let win
let winVisible = true

// Window position persistence
let statePath

function loadWinState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch(e) { return null }
}

function saveWinState() {
  if (!win) return
  try {
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    fs.writeFileSync(statePath, JSON.stringify({ x, y, w, h }), 'utf8')
  } catch(e) {}
}

// Tool window helper
const _toolWins = {}
function openToolWin(name, file, w, h, title) {
  if (_toolWins[name] && !_toolWins[name].isDestroyed()) {
    _toolWins[name].focus(); return
  }
  const tw = new BrowserWindow({
    width: w, height: h, title,
    autoHideMenuBar: true, resizable: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  tw.loadFile(path.join(__dirname, file))
  tw.once('ready-to-show', () => tw.show())
  tw.on('closed', () => { delete _toolWins[name] })
  _toolWins[name] = tw
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const saved = loadWinState()
  const wx = width - 310
  const wy = 20
  const wh = saved ? saved.h : 460

  win = new BrowserWindow({
    width: 300, height: wh, x: wx, y: wy,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })

  win.loadFile(path.join(__dirname, 'widget.html'))
  win.once('ready-to-show', () => win.show())
  win.on('moved',   saveWinState)
  win.on('resized', saveWinState)
  win.on('close',   saveWinState)
}

function toggleVisibility() {
  if (!win) return
  if (winVisible) { win.hide(); winVisible = false }
  else            { win.show(); win.focus(); winVisible = true }
}

app.whenReady().then(() => {
  statePath = path.join(app.getPath('userData'), 'win-state.json')

  // Tool mode: launched by bat
  const allArgs = process.argv.join(' ')
  const toolMap = [
    { key: 'tool=reset',        file: 'reset.html',          w: 400, h: 600, title: '\u8bcd\u5883 \u00b7 \u6e05\u7a7a\u8bb0\u5fc6' },
    { key: 'tool=keybindings',  file: 'keybindings.html',    w: 400, h: 560, title: '\u8bcd\u5883 \u00b7 \u952e\u4f4d\u8bbe\u7f6e' },
    { key: 'tool=vocab',        file: 'vocab-manager.html',  w: 520, h: 660, title: '\u8bcd\u5883 \u00b7 \u8bcd\u5e93\u7ba1\u7406' },
  ]
  const matchedTool = toolMap.find(t => allArgs.includes(t.key))

  if (matchedTool) {
    const tw = new BrowserWindow({
      width: matchedTool.w, height: matchedTool.h,
      title: matchedTool.title,
      autoHideMenuBar: true, resizable: true, show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    tw.loadFile(path.join(__dirname, matchedTool.file))
    tw.once('ready-to-show', () => tw.show())
    tw.on('closed', () => app.quit())
    return
  }

  createWindow()
  globalShortcut.register('CommandOrControl+Shift+H', toggleVisibility)
})

app.on('will-quit', () => { globalShortcut.unregisterAll(); saveWinState() })
app.on('window-all-closed', () => app.quit())

// IPC - tool windows
ipcMain.on('open-tool-reset',       () => openToolWin('reset', 'reset.html',         400, 600, '\u8bcd\u5883 \u00b7 \u6e05\u7a7a\u8bb0\u5fc6'))
ipcMain.on('open-tool-keybindings', () => openToolWin('kb',    'keybindings.html',   400, 560, '\u8bcd\u5883 \u00b7 \u952e\u4f4d\u8bbe\u7f6e'))
ipcMain.on('open-tool-vocab',       () => openToolWin('vocab', 'vocab-manager.html', 520, 660, '\u8bcd\u5883 \u00b7 \u8bcd\u5e93\u7ba1\u7406'))

// IPC - window control
ipcMain.on('win-quit',    ()        => { saveWinState(); app.quit() })
ipcMain.on('win-opacity', (_, v)    => win && win.setOpacity(v))
ipcMain.on('win-resize',  (_, w, h) => { if (win) { win.setSize(w, h); saveWinState() } })
ipcMain.on('win-topmost', (_, v)    => win && win.setAlwaysOnTop(v))
ipcMain.on('win-hide',    ()        => { if (win) { win.hide(); winVisible = false } })
ipcMain.on('win-show',    ()        => { if (win) { win.show(); win.focus(); winVisible = true } })
ipcMain.on('win-toggle',  ()        => toggleVisibility())

// IPC - drag
let _dragBase = null
ipcMain.on('win-drag-start', (_, sx, sy) => {
  if (!win) return
  const [wx, wy] = win.getPosition()
  _dragBase = { sx, sy, wx, wy }
})
ipcMain.on('win-drag-move', (_, sx, sy) => {
  if (!win || !_dragBase) return
  win.setPosition(_dragBase.wx + (sx - _dragBase.sx), _dragBase.wy + (sy - _dragBase.sy))
})
ipcMain.on('win-drag-end', () => { _dragBase = null; saveWinState() })
