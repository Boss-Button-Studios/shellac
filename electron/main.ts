import { app, BrowserWindow, ipcMain, session, Menu, clipboard } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { DEFAULT_CONFIG, IPC } from '../src/types/index.ts'
import type { AppConfig } from '../src/types/index.ts'

// node-pty must only ever be imported in the main process.
const require = createRequire(import.meta.url)
const pty = require('node-pty') as typeof import('node-pty')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST     = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// ─── Config ───────────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  generatorModel:         z.string().min(1).max(100),
  validatorModel:         z.string().min(1).max(100),
  ollamaBaseUrl:          z.string().url().startsWith('http://localhost'),
  maxContextTokens:       z.number().int().min(500).max(32000),
  maxOutputCharsPerBlock: z.number().int().min(100).max(10000),
  shell:                  z.string().min(1),
  theme:                  z.enum(['dark', 'light', 'system']),
  fontSize:               z.number().int().min(8).max(32),
  sidebarOpen:            z.boolean(),
  sidebarWidth:           z.number().int().min(200).max(600),
  activeTab:              z.enum(['explain', 'navigate', 'glossary', 'settings']),
  explainCommands:        z.enum(['off', 'on', 'on-warn']),
  autoSwitchToExplain:    z.boolean(),
  safetyLevel:            z.enum(['newbie', 'balanced', 'pro']),
})

function loadConfig(configPath: string): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return { ...DEFAULT_CONFIG, ...ConfigSchema.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function saveConfig(configPath: string, config: AppConfig): void {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Shellac] Failed to save config:', err)
  }
}

// ─── PTY (§15) ────────────────────────────────────────────────────────────────

// Shell hooks that emit OSC 1337 CurrentDir on every prompt.
// The renderer uses these to track CWD without shelling out.
const CWD_HOOK: Record<string, string> = {
  zsh:  'precmd() { printf "\\x1b]1337;CurrentDir=%s\\x07" "$(pwd)"; }\n',
  bash: 'PROMPT_COMMAND=\'printf "\\x1b]1337;CurrentDir=%s\\x07" "$(pwd)"\'\n',
}

// Matches OSC 1337 CurrentDir sequences emitted by the hook above.
const CWD_REGEX = /\x1b\]1337;CurrentDir=([^\x07]+)\x07/g

type PtyProcess = ReturnType<typeof pty.spawn>
let ptyProcess: PtyProcess | null = null

function spawnPty(config: AppConfig, win: BrowserWindow): void {
  const shellBin  = config.shell
  const shellName = path.basename(shellBin)

  ptyProcess = pty.spawn(shellBin, [], {
    name: 'xterm-256color',
    cwd:  os.homedir(),
    env:  process.env as Record<string, string>,
    cols: 80,
    rows: 24,
  })

  // Inject CWD tracking hook if we know this shell. Unknown shells get no hook
  // (CWD tracking simply won't work — not a security concern).
  if (CWD_HOOK[shellName]) {
    ptyProcess.write(CWD_HOOK[shellName])
  }

  ptyProcess.onData(data => {
    // Strip OSC CWD sequences before sending to renderer.
    // The extracted CWD is sent on a separate channel.
    let clean = data
    CWD_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CWD_REGEX.exec(data)) !== null) {
      win.webContents.send(IPC.PTY_CWD, match[1])
      clean = clean.replace(match[0], '')
    }
    win.webContents.send(IPC.PTY_DATA, clean)
  })

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[Shellac] Shell exited with code ${exitCode}`)
    win.webContents.send(IPC.PTY_EXIT, exitCode ?? 0)
    ptyProcess = null
    // Respawn a fresh shell so the terminal remains usable after `exit`
    setTimeout(() => { if (win) spawnPty(currentConfig, win) }, 500)
  })
}

// ─── State ────────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null
let currentConfig: AppConfig  = { ...DEFAULT_CONFIG }
let configPath = ''

// ─── Application menu (§17 clipboard) ────────────────────────────────────────
// Minimal Edit menu required for the clipboard bridge to work in the sandboxed
// renderer. No extra capabilities exposed beyond standard clipboard operations.

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS requires the app name as the first menu item
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Copy',
          // macOS: Cmd+C  |  Linux/Win: Ctrl+Shift+C
          // Ctrl+C is intentionally left unwired to preserve terminal SIGINT
          // (Stop button handles SIGINT — spec §17)
          accelerator: isMac ? 'Cmd+C' : 'Ctrl+Shift+C',
          role: 'copy',
        },
        {
          label: 'Paste',
          accelerator: isMac ? 'Cmd+V' : 'Ctrl+Shift+V',
          role: 'paste',
        },
        {
          label: 'Select All',
          accelerator: isMac ? 'Cmd+A' : 'Ctrl+Shift+A',
          role: 'selectAll',
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    // §8a — security flags
    webPreferences: {
      nodeIntegration:             false,  // NEVER true
      contextIsolation:            true,   // MUST be true
      sandbox:                     true,
      webSecurity:                 true,   // NEVER false
      allowRunningInsecureContent: false,
      preload:                     path.join(__dirname, 'preload.js'),
    },
    minWidth:  900,
    minHeight: 600,
    width:     1100,
    height:    700,
    title:     'Shellac — Boss Button Studios',
    backgroundColor: '#1C1814',
  })

  // §8b — Content Security Policy
  // Dev: 'unsafe-inline' added to script-src only — Vite's React Fast Refresh
  // preamble is an inline script. Production build has no inline scripts.
  const scriptSrc = VITE_DEV_SERVER_URL ? "'self' 'unsafe-inline'" : "'self'"
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; ` +
          `script-src ${scriptSrc}; ` +
          `connect-src 'self' http://localhost:11434 ws://localhost:5173; ` +
          `style-src 'self' 'unsafe-inline';`
        ]
      }
    })
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// §8c — one command per call: strip everything after the first '\n'.
// This prevents command-chaining attacks through the IPC boundary.
//
// We do NOT append '\n'. Two distinct callers use this channel:
//   • xterm keyboard input — sends raw sequences; Enter arrives as '\r'.
//     Adding '\n' would execute every character typed.
//   • NLBar (Phase 4) — sends a complete command string and appends '\r'
//     itself before calling ptyWrite.
// In both cases the security invariant holds: only the content before the
// first Unix newline reaches the PTY.
ipcMain.on(IPC.PTY_WRITE, (_e, data: string) => {
  const sanitized = data.split('\n')[0]
  if (sanitized) ptyProcess?.write(sanitized)
})

ipcMain.on(IPC.PTY_RESIZE, (_e, cols: number, rows: number) => {
  ptyProcess?.resize(cols, rows)
})

// Clipboard — routed through main process; navigator.clipboard blocked in sandbox
ipcMain.handle(IPC.CLIPBOARD_READ,  ()              => clipboard.readText())
ipcMain.handle(IPC.CLIPBOARD_WRITE, (_e, text: string) => { clipboard.writeText(text) })

ipcMain.handle(IPC.CONFIG_GET, () => currentConfig)

ipcMain.handle(IPC.CONFIG_SET, (_e, partial: Partial<AppConfig>) => {
  currentConfig = { ...currentConfig, ...partial }
  saveConfig(configPath, currentConfig)
})

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  configPath    = path.join(app.getPath('userData'), 'shellac-config.json')
  currentConfig = loadConfig(configPath)
  buildAppMenu()
  createWindow()
  // Spawn PTY after window exists so onData can send to win.webContents
  if (win) spawnPty(currentConfig, win)
})
