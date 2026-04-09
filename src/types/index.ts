// ─── Block ────────────────────────────────────────────────────────────────────

export type BlockId = string;

export interface Block {
  id: BlockId;
  command: string;
  nlQuery?: string;
  output: string;            // visible to human in TerminalBlock — never enters model context
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  contextFlagged: boolean;   // if true: excluded from all model context
  flagReasons: string[];
  source: 'nl' | 'direct';  // nl = came through AIBridge, direct = bash passthrough
}

// ─── AI / Suggestion types ────────────────────────────────────────────────────

export interface SuggestedCommand {
  command: string;
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'generator' | 'direct';
}

export interface CommandExplanation {
  summary: string;
  effects: string[];
  reversible: boolean;       // conservative default: false on failure
  requiresSudo: boolean;
  confidence: 'high' | 'low';
}

export interface CommandResult {
  summary: string;
  exitMeaning: string;
  nextSteps: string[];       // max 3 items
}

export interface ValidationResult {
  approved: boolean;
  confidence: 'pass' | 'warn' | 'block';
  reasons: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export type SafetyLevel = 'newbie' | 'balanced' | 'pro';

export interface AppConfig {
  generatorModel: string;            // default: 'qwen2.5-coder:7b'
  validatorModel: string;            // default: 'mistral:7b'
  ollamaBaseUrl: string;             // default: 'http://localhost:11434'
  maxContextTokens: number;          // default: 4000
  maxOutputCharsPerBlock: number;    // default: 2000
  shell: string;
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  activeTab: 'explain' | 'navigate' | 'glossary' | 'settings';
  explainCommands: 'off' | 'on' | 'on-warn';
  autoSwitchToExplain: boolean;
  safetyLevel: SafetyLevel;
}

export const DEFAULT_CONFIG: AppConfig = {
  generatorModel:         'qwen2.5-coder:1.5b',
  validatorModel:         'llama3.2:3b',
  ollamaBaseUrl:          'http://localhost:11434',
  maxContextTokens:       4000,
  maxOutputCharsPerBlock: 2000,
  shell:                  typeof process !== 'undefined' && process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
  theme:                  'system',
  fontSize:               14,
  sidebarOpen:            true,
  sidebarWidth:           300,
  activeTab:              'explain',
  explainCommands:        'on',
  autoSwitchToExplain:    true,
  safetyLevel:            'balanced',
};

// ─── Error types ──────────────────────────────────────────────────────────────

export class ShellacError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message); this.name = 'ShellacError';
  }
}

export class ContextOverflowError extends ShellacError {
  constructor(public readonly tokenCount: number, public readonly limit: number) {
    super(`Context overflow: ${tokenCount} tokens exceeds limit of ${limit}`);
    this.name = 'ContextOverflowError';
  }
}

export class OllamaUnavailableError extends ShellacError {
  constructor(public readonly model: string) {
    super(`Ollama unavailable or model not loaded: ${model}`);
    this.name = 'OllamaUnavailableError';
  }
}

// ─── IPC channels ─────────────────────────────────────────────────────────────

export const IPC = {
  PTY_WRITE:      'pty:write',
  PTY_RESIZE:     'pty:resize',
  PTY_DATA:       'pty:data',
  PTY_EXIT:       'pty:exit',
  PTY_CWD:        'pty:cwd',
  CONFIG_GET:     'config:get',
  CONFIG_SET:     'config:set',
  INSTALL_STATUS:  'install:status',   // main → renderer during first-run
  INSTALL_START:   'install:start',    // renderer → main
  // Clipboard routed through main process — navigator.clipboard is blocked
  // in Electron's sandboxed renderer (not accounted for in original spec).
  CLIPBOARD_READ:  'clipboard:read',
  CLIPBOARD_WRITE: 'clipboard:write',
} as const;

// ─── Electron API (exposed via preload contextBridge) ─────────────────────────

export interface ElectronAPI {
  ptyWrite:       (data: string) => void;
  ptyResize:      (cols: number, rows: number) => void;
  onPtyData:      (cb: (data: string) => void) => () => void;
  onPtyExit:      (cb: (code: number) => void) => () => void;
  onPtyCwd:       (cb: (cwd: string) => void) => () => void;
  configGet:      () => Promise<AppConfig>;
  configSet:      (partial: Partial<AppConfig>) => Promise<void>;
  onInstallStatus:(cb: (status: InstallStatus) => void) => () => void;
  clipboardRead:  () => Promise<string>;
  clipboardWrite: (text: string) => Promise<void>;
}

// ─── Installer types ──────────────────────────────────────────────────────────

export type InstallStage =
  | 'detecting-ollama'
  | 'downloading-ollama'
  | 'installing-ollama'
  | 'starting-daemon'
  | 'pulling-generator'
  | 'pulling-validator'
  | 'complete'
  | 'error';

export interface InstallStatus {
  stage: InstallStage;
  progress?: number;   // 0–1 for pull stages
  error?: string;      // human-readable, no raw stack traces
  recovery?: string;   // copyable recovery command
}

// ─── Global augmentation ──────────────────────────────────────────────────────

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
