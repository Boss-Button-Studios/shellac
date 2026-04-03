import { app, BrowserWindow, ipcMain, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'
import { DEFAULT_CONFIG, IPC } from '../src/types/index.ts'
import type { AppConfig } from '../src/types/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST     = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// ─── Config ───────────────────────────────────────────────────────────────────
// configPath deferred to app.whenReady() — app.getPath() is unavailable at module load time.

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

// ─── PTY (Phase 0 stub — PTYManager wired in Phase 1) ────────────────────────

// ptyProcess is null until Phase 1. The IPC handler is registered now so the
// security contract (newline stripping) is in place from the start.
let ptyProcess: { write: (data: string) => void } | null = null

// ─── State ────────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null
let currentConfig: AppConfig = { ...DEFAULT_CONFIG }
let configPath = ''

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
      preload:                     path.join(__dirname, 'preload.mjs'),
    },
    minWidth:  900,
    minHeight: 600,
    width:     1100,
    height:    700,
    title:     'Shellac — Boss Button Studios',
    backgroundColor: '#1C1814',
  })

  // §8b — Content Security Policy
  // connect-src whitelists only localhost:11434. No Anthropic endpoint.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "connect-src 'self' http://localhost:11434; " +
          "style-src 'self' 'unsafe-inline';"
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

// ─── IPC handlers ────────────────────────────────────────────────────────────

// §8c — PTY_WRITE: one command per call, strip everything after first newline.
// Prevents command-chaining attacks through the IPC boundary.
ipcMain.on(IPC.PTY_WRITE, (_e, data: string) => {
  const sanitized = data.split('\n')[0]
  ptyProcess?.write(sanitized + '\n')
})

// PTY_RESIZE handler stub — wired to ptyProcess in Phase 1
ipcMain.on(IPC.PTY_RESIZE, (_e, cols: number, rows: number) => {
  if (ptyProcess && 'resize' in ptyProcess) {
    (ptyProcess as { resize: (cols: number, rows: number) => void }).resize(cols, rows)
  }
})

// Config IPC
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
  // Safe to call app.getPath() only after app is ready
  configPath = path.join(app.getPath('userData'), 'shellac-config.json')
  currentConfig = loadConfig(configPath)
  createWindow()
})

// Export for Phase 1 PTYManager wiring
export { win, ptyProcess, currentConfig }
