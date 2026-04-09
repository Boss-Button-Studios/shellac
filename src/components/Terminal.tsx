// Terminal — spec §17 Terminal (root)
//
// Root layout:
//   [Sidebar] | [block list + xterm + SuggestionCard? + input area]
//
// Input area states (mutually exclusive):
//   1. Command running (activeBlockId !== null) → Stop button only
//   2. Idle, last exit = 0 or no blocks       → NLBar only
//   3. Idle, last exit ≠ 0                    → NLBar + Help button
//
// Help button disappears the moment the user types in the NLBar.
// It calls explainResult() with stdout included (the only path where stdout
// enters a model context — requires explicit user action, spec §13).

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useBlockStore } from '../lib/BlockStore.ts'
import { explainResult } from '../lib/CommandExplainer.ts'
import TerminalBlock from './TerminalBlock.tsx'
import NLBar from './NLBar.tsx'
import SuggestionCard from './SuggestionCard.tsx'
import type { AppConfig, Block, CommandResult } from '../types/index.ts'
import { DEFAULT_CONFIG } from '../types/index.ts'

const isMac = navigator.platform.startsWith('Mac')

export default function Terminal() {
  const xtermRef      = useRef<XTerm | null>(null)
  const fitAddonRef   = useRef<FitAddon | null>(null)
  const containerRef  = useRef<HTMLDivElement>(null)
  const blockListRef  = useRef<HTMLDivElement>(null)

  // Config — fetched from main process once on mount
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)

  // Sidebar explain state — populated by Help button and post-run explanations
  const [sidebarExplain, setSidebarExplain]   = useState<CommandResult | null>(null)
  const [sidebarLoading, setSidebarLoading]   = useState(false)

  const blocks         = useBlockStore(s => s.blocks)
  const activeBlockId  = useBlockStore(s => s.activeBlockId)
  const suggestion     = useBlockStore(s => s.suggestion)
  const appendOutput   = useBlockStore(s => s.appendOutput)
  const finishBlock    = useBlockStore(s => s.finishBlock)
  const updateCwd      = useBlockStore(s => s.updateCwd)
  const startBlock     = useBlockStore(s => s.startBlock)
  const setSuggestion  = useBlockStore(s => s.setSuggestion)

  // ── Load config ────────────────────────────────────────────────────────────
  useEffect(() => {
    window.electronAPI.configGet().then(setConfig).catch(() => {/* use default */})
  }, [])

  // ── xterm init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const term = new XTerm({
      fontFamily:       "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize:         config.fontSize,
      cursorBlink:      true,
      allowProposedApi: false,
      theme: {
        background:          '#1C1814',
        foreground:          '#E8DDD0',
        cursor:              '#C4844A',
        cursorAccent:        '#1C1814',
        selectionBackground: 'rgba(196,132,74,0.25)',
        black:   '#2C2420', red:     '#C46060', green:   '#7A9E7E', yellow:  '#C4844A',
        blue:    '#6A8EAE', magenta: '#A07898', cyan:    '#7AAEA8', white:   '#E8DDD0',
        brightBlack:   '#5A504A', brightRed:     '#D4705A',
        brightGreen:   '#8ABE8E', brightYellow:  '#D4944A',
        brightBlue:    '#7A9EBE', brightMagenta: '#B088A8',
        brightCyan:    '#8ABEB8', brightWhite:   '#F0E8DC',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    if (containerRef.current) {
      term.open(containerRef.current)
      fitAddon.fit()
      term.focus()
    }

    xtermRef.current    = term
    fitAddonRef.current = fitAddon

    // copyOnSelect — xterm v6 removed the option; implement via selection event
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) window.electronAPI.clipboardWrite(sel)
    })

    // PTY data → xterm + block output accumulator
    const offData = window.electronAPI.onPtyData(data => {
      term.write(data)
      const { activeBlockId: id } = useBlockStore.getState()
      if (id) appendOutput(id, data)
    })

    const offExit = window.electronAPI.onPtyExit(code => {
      console.log('[Shellac] PTY_EXIT received, code:', code)
      const { activeBlockId: id } = useBlockStore.getState()
      if (id) finishBlock(id, code)
    })

    const offCwd = window.electronAPI.onPtyCwd(path => {
      updateCwd(path)
      // CWD update signals the prompt has returned. Finish the active block only
      // if PTY_EXIT hasn't already done so with the real exit code.
      // Use exit code 0 as a fallback (prompt returning implies success if we
      // didn't get an explicit exit event).
      const { activeBlockId: id, blocks } = useBlockStore.getState()
      if (id) {
        const block = blocks.find(b => b.id === id)
        // Only finish here if the block doesn't already have an exit code
        if (block && block.exitCode === null) finishBlock(id, 0)
      }
    })

    // Clipboard shortcuts (window-level, fires before xterm intercepts)
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCopy = isMac
        ? (e.metaKey && !e.shiftKey && e.key === 'c')
        : (e.ctrlKey && e.shiftKey && e.key === 'C')
      const isPaste = isMac
        ? (e.metaKey && !e.shiftKey && e.key === 'v')
        : (e.ctrlKey && e.shiftKey && e.key === 'V')

      if (isCopy) {
        e.preventDefault()
        const sel = term.getSelection()
        if (sel) window.electronAPI.clipboardWrite(sel)
      } else if (isPaste) {
        e.preventDefault()
        window.electronAPI.clipboardRead().then(text => {
          if (text) window.electronAPI.ptyWrite(text)
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    // Keyboard: data out (Ctrl+C swallowed — Stop button is the only SIGINT path)
    term.onKey(({ key }) => {
      if (key === '\x03') return
      window.electronAPI.ptyWrite(key)
    })

    // Auto-resize via ResizeObserver
    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.electronAPI.ptyResize(term.cols, term.rows)
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      offData()
      offExit()
      offCwd()
      window.removeEventListener('keydown', handleKeyDown)
      ro.disconnect()
      term.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Scroll block list to bottom on new blocks ──────────────────────────────
  useEffect(() => {
    const el = blockListRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks.length])

  // ── Stop button ───────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    window.electronAPI.ptyWrite('\x03')
  }, [])

  // ── Focus xterm (called by NLBar on Escape) ────────────────────────────────
  const focusXterm = useCallback(() => {
    xtermRef.current?.focus()
  }, [])

  // ── Direct execute (bash passthrough that passed static analysis) ────────────
  // No SuggestionCard, no model call — fires immediately.
  const handleDirectExecute = useCallback((command: string) => {
    startBlock(command, 'direct')
    window.electronAPI.ptyWrite(command + '\r')
    focusXterm()
  }, [startBlock, focusXterm])

  // ── SuggestionCard confirm ─────────────────────────────────────────────────
  const handleConfirm = useCallback((command: string, nlQuery?: string) => {
    setSuggestion(null)
    startBlock(command, suggestion?.source === 'direct' ? 'direct' : 'nl', nlQuery)
    window.electronAPI.ptyWrite(command + '\r')
    focusXterm()
  }, [suggestion, startBlock, setSuggestion, focusXterm])

  // ── SuggestionCard dismiss ────────────────────────────────────────────────
  const handleDismiss = useCallback(() => {
    setSuggestion(null)
    focusXterm()
  }, [setSuggestion, focusXterm])

  // ── Help button ────────────────────────────────────────────────────────────
  // Called by TerminalBlock when user clicks "Help me fix this".
  // Only path where stdout enters a model context (spec §13).
  const handleHelp = useCallback(async (block: Block) => {
    setSidebarLoading(true)
    setSidebarExplain(null)
    try {
      const result = await explainResult(
        block.command,
        block.output,
        block.exitCode ?? 1,
        config,
        true,  // includeOutput — user explicitly requested this
      )
      setSidebarExplain(result)
    } catch {
      setSidebarExplain({
        summary:     'Unable to explain — Ollama may be unavailable.',
        exitMeaning: '',
        nextSteps:   ['Run: ollama serve', 'Then click Help me fix this again'],
      })
    } finally {
      setSidebarLoading(false)
    }
  }, [config])

  // ── Input area state ───────────────────────────────────────────────────────
  const isRunning    = activeBlockId !== null
  const finishedBlocks = blocks.filter(b => b.finishedAt !== null)
  const lastBlock    = finishedBlocks[finishedBlocks.length - 1] ?? null
  const lastFailed   = lastBlock !== null && lastBlock.exitCode !== 0

  return (
    <div style={styles.root}>
      {/* Sidebar — Phase 5 full implementation; Phase 4 shows explain result */}
      <div style={styles.sidebar}>
        <SidebarPlaceholder
          loading={sidebarLoading}
          result={sidebarExplain}
        />
      </div>

      {/* Main terminal column */}
      <div style={styles.main}>
        {/* Block list */}
        <div ref={blockListRef} style={styles.blockList}>
          {finishedBlocks.map(block => (
            <TerminalBlock
              key={block.id}
              block={block}
              onHelp={handleHelp}
            />
          ))}
        </div>

        {/* xterm live surface — slim strip: just enough for the active prompt + streaming output.
            Hidden when no command is running and the suggestion card is up, so the NLBar
            feels like the primary interface. Always present in the DOM so the PTY stays alive. */}
        <div
          ref={containerRef}
          style={{
            ...styles.xtermContainer,
            height: isRunning ? '120px' : '28px',
          }}
        />

        {/* SuggestionCard — shown above input area when a suggestion is pending */}
        {suggestion && !isRunning && (
          <div style={styles.suggestionArea}>
            <SuggestionCard
              suggestion={suggestion}
              config={config}
              onConfirm={handleConfirm}
              onDismiss={handleDismiss}
            />
          </div>
        )}

        {/* Input area */}
        <div style={styles.inputArea}>
          {isRunning ? (
            <button onClick={handleStop} style={styles.stopButton}>
              ■ Stop
            </button>
          ) : suggestion ? null : (
            /* NLBar + optional Help button */
            <div style={styles.inputRow}>
              <NLBar
                config={config}
                onFocusXterm={focusXterm}
                onDirectExecute={handleDirectExecute}
                disabled={isRunning}
              />
              {lastFailed && (
                <button
                  style={styles.helpButton}
                  onClick={() => handleHelp(lastBlock!)}
                  title="Explain what went wrong"
                >
                  Help me fix this
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── SidebarPlaceholder ────────────────────────────────────────────────────────
// Phase 5 will replace this with the full Sidebar component.
// For Phase 4 MHTP, it shows the explain result when the Help button is clicked.

function SidebarPlaceholder({
  loading,
  result,
}: {
  loading: boolean
  result:  CommandResult | null
}) {
  if (loading) {
    return (
      <div style={sidebarStyles.panel}>
        <div style={sidebarStyles.tabBar}>
          <span style={sidebarStyles.activeTab}>Explain</span>
        </div>
        <div style={sidebarStyles.content}>
          <span style={sidebarStyles.muted}>Analyzing…</span>
        </div>
      </div>
    )
  }

  if (result) {
    return (
      <div style={sidebarStyles.panel}>
        <div style={sidebarStyles.tabBar}>
          <span style={sidebarStyles.activeTab}>Explain</span>
        </div>
        <div style={sidebarStyles.content}>
          <div style={sidebarStyles.summary}>{result.summary}</div>
          {result.exitMeaning && (
            <div style={sidebarStyles.exitMeaning}>{result.exitMeaning}</div>
          )}
          {result.nextSteps.length > 0 && (
            <div style={sidebarStyles.nextStepsSection}>
              <div style={sidebarStyles.sectionLabel}>Next steps</div>
              <ol style={sidebarStyles.nextStepsList}>
                {result.nextSteps.map((s, i) => (
                  <li key={i} style={sidebarStyles.nextStep}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={sidebarStyles.panel}>
      <div style={sidebarStyles.tabBar}>
        <span style={sidebarStyles.activeTab}>Explain</span>
        <span style={sidebarStyles.inactiveTab}>Navigate</span>
        <span style={sidebarStyles.inactiveTab}>Glossary</span>
        <span style={sidebarStyles.inactiveTab}>Settings</span>
      </div>
      <div style={sidebarStyles.content}>
        <div style={sidebarStyles.welcome}>
          <div style={sidebarStyles.welcomeTitle}>Welcome to Shellac</div>
          <div style={sidebarStyles.welcomeText}>
            Type a command or describe what you want to do. Shellac will
            translate your words into shell commands and explain what they do
            before anything runs.
          </div>
          <div style={sidebarStyles.welcomeText}>
            Sidebar tabs will be available in a future update.
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: {
    display:    'flex',
    width:      '100%',
    height:     '100%',
    overflow:   'hidden',
    background: '#1C1814',
  },
  sidebar: {
    width:       '300px',
    flexShrink:  0,
    borderRight: '1px solid rgba(200,170,140,0.09)',
    background:  '#201C18',
    overflow:    'hidden',
  },
  main: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column',
    overflow:      'hidden',
  },
  blockList: {
    flex:      1,
    overflowY: 'auto',
    padding:   '0.5rem 0',
  },
  xtermContainer: {
    flexShrink:  0,
    transition:  'height 120ms ease-out',
    padding:     '4px',
    overflow:    'hidden',
  },
  suggestionArea: {
    flexShrink: 0,
    padding:    '0 12px',
    maxHeight:  '50vh',
    overflowY:  'auto',
  },
  inputArea: {
    flexShrink: 0,
    borderTop:  '1px solid rgba(200,170,140,0.09)',
    padding:    '8px 12px',
    minHeight:  '48px',
    display:    'flex',
    alignItems: 'center',
  },
  inputRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    flex:       1,
  },
  stopButton: {
    background:    '#C46060',
    color:         '#F0E8DC',
    border:        'none',
    borderRadius:  '6px',
    padding:       '6px 16px',
    fontSize:      '13px',
    fontWeight:    600,
    cursor:        'pointer',
    letterSpacing: '0.02em',
    fontFamily:    '-apple-system, system-ui, sans-serif',
  },
  helpButton: {
    background:   'transparent',
    border:       '1px solid rgba(200,170,140,0.14)',
    borderRadius: '5px',
    color:        '#8A7D70',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '11px',
    padding:      '4px 10px',
    cursor:       'pointer',
    flexShrink:   0,
    whiteSpace:   'nowrap',
  },
}

const sidebarStyles: Record<string, React.CSSProperties> = {
  panel: {
    height:        '100%',
    display:       'flex',
    flexDirection: 'column',
    overflow:      'hidden',
  },
  tabBar: {
    display:    'flex',
    gap:        '2px',
    padding:    '8px 8px 0',
    borderBottom: '1px solid rgba(200,170,140,0.09)',
    flexShrink: 0,
  },
  activeTab: {
    color:        '#E8DDD0',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '11px',
    fontWeight:   600,
    padding:      '4px 8px 6px',
    borderBottom: '2px solid #C4844A',
    marginBottom: '-1px',
  },
  inactiveTab: {
    color:      '#5A504A',
    fontFamily: '-apple-system, system-ui, sans-serif',
    fontSize:   '11px',
    padding:    '4px 8px 6px',
    cursor:     'not-allowed',
  },
  content: {
    flex:      1,
    overflowY: 'auto',
    padding:   '12px',
  },
  muted: {
    color:      '#5A504A',
    fontFamily: '-apple-system, system-ui, sans-serif',
    fontSize:   '12px',
  },
  summary: {
    color:        '#C8BDB0',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '13px',
    lineHeight:   1.5,
    marginBottom: '8px',
  },
  exitMeaning: {
    color:        '#8A7D70',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '12px',
    marginBottom: '12px',
    fontStyle:    'italic',
  },
  nextStepsSection: {
    marginTop: '8px',
  },
  sectionLabel: {
    color:        '#5A504A',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '10px',
    fontWeight:   600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    marginBottom: '6px',
  },
  nextStepsList: {
    margin:      0,
    paddingLeft: '16px',
    color:       '#8A7D70',
    fontFamily:  '-apple-system, system-ui, sans-serif',
    fontSize:    '12px',
    lineHeight:  1.6,
  },
  nextStep: {
    marginBottom: '4px',
  },
  welcome: {
    paddingTop: '8px',
  },
  welcomeTitle: {
    color:        '#C8BDB0',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '13px',
    fontWeight:   600,
    marginBottom: '10px',
  },
  welcomeText: {
    color:        '#5A504A',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '12px',
    lineHeight:   1.6,
    marginBottom: '8px',
  },
}
