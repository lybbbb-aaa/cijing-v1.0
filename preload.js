// 词境 · preload —— 渲染进程唯一的能力入口
// 开启 contextIsolation 后，页面拿不到 fs / path / require，
// 所有文件读写与 IPC 都通过下面这个受白名单约束的桥完成。
const { contextBridge, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(process.env.APPDATA || '', 'ielts-widget')
const NAME_RE = /^[A-Za-z0-9_.\-]+$/          // 只允许数据目录下的扁平文件名

const SEND_CHANNELS = [
  'win-drag-start', 'win-drag-move', 'win-drag-end',
  'win-quit', 'win-opacity', 'win-resize', 'win-topmost',
  'win-hide', 'win-show', 'win-toggle', 'set-boss-key',
  'open-tool-keybindings', 'open-tool-reset', 'open-tool-vocab',
  'open-external', 'open-data-dir', 'open-error-log', 'set-autostart',
  'notify-data-changed', 'open-doc'
]
const ON_CHANNELS = ['bosskey-status', 'word-picked', 'data-changed']
const INVOKE_CHANNELS = ['export-backup', 'import-backup', 'get-autostart']

function dataFile(name) {
  if (!NAME_RE.test(String(name))) throw new Error('illegal data file name')
  return path.join(DATA_DIR, name)
}

contextBridge.exposeInMainWorld('cj', {
  version: (() => { try { return require('./package.json').version } catch (e) { return '' } })(),
  dataDir: DATA_DIR,
  dataPath: (name) => dataFile(name),
  readData: (name) => { try { return fs.readFileSync(dataFile(name), 'utf8') } catch (e) { return null } },
  readDataWithBackup: (name) => {
    // 主文件解析失败时回退到 .bak
    let primary = null
    try { primary = fs.readFileSync(dataFile(name), 'utf8') } catch (e) {}
    if (primary) {
      try { JSON.parse(primary); return primary } catch (e) {}
    }
    try { return fs.readFileSync(dataFile(name + '.bak'), 'utf8') } catch (e) { return primary }
  },
  writeData: (name, text, opts) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const target = dataFile(name)
      if (opts && opts.backup && fs.existsSync(target)) {
        try { fs.copyFileSync(target, target + '.bak') } catch (e) {}
      }
      const tmp = target + '.tmp'
      fs.writeFileSync(tmp, String(text), 'utf8')
      fs.renameSync(tmp, target)   // 原子替换：不会留下写到一半的半份文件
      return true
    } catch (e) { return false }
  },
  appendData: (name, text) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const target = dataFile(name)
      // 日志超 256KB 先归档再清空，避免无限增长
      try {
        if (fs.statSync(target).size > 256 * 1024) {
          try { fs.copyFileSync(target, target + '.1') } catch (e) {}
          fs.writeFileSync(target, '', 'utf8')
        }
      } catch (e) {}
      fs.appendFileSync(target, String(text), 'utf8')
      return true
    } catch (e) { return false }
  },
  send: (channel, ...args) => {
    if (SEND_CHANNELS.indexOf(channel) !== -1) ipcRenderer.send(channel, ...args)
  },
  on: (channel, cb) => {
    if (ON_CHANNELS.indexOf(channel) !== -1) ipcRenderer.on(channel, (event, ...args) => cb(...args))
  },
  invoke: (channel, ...args) => {
    if (INVOKE_CHANNELS.indexOf(channel) === -1) return Promise.resolve({ ok: false, error: 'blocked' })
    return ipcRenderer.invoke(channel, ...args)
  }
})
