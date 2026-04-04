import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useBlockStore } from '../lib/BlockStore.ts'
import TerminalBlock from './TerminalBlock.tsx'

const isMac = navigator.platform.startsWith('Mac')

export default function Terminal() {
  const xtermRef    = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const blocks        = useBlockStore(s => s.blocks)
  const activeBlockId = useBlockStore(s => s.activeBlockId)
  const appendOutput  = useBlockStore(s => s.appendOutput)
  const finishBlock   = useBlockStore(s => s.finishBlock)
  const updateCwd     = useBlockStore(s => s.updateCwd)

  // ── xterm init ────────────────────────────────────────────────────────────
  useEffect(() => {
    const term = new XTerm({
      fontFamily:       "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize:         14,
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
    }

    xtermRef.current    = term
    fitAddonRef.current = fitAddon

    // ── copyOnSelect — xterm v6 removed the option; implement via event ─────
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) navigator.clipboard.writeText(sel)
    })

    // ── PTY data in ─────────────────────────────────────────────────────────
    const offData = window.electronAPI.onPtyData(data => {
      term.write(data)
      // Route to active block if one is running
      const { activeBlockId: id } = useBlockStore.getState()
      if (id) appendOutput(id, data)
    })

    const offExit = window.electronAPI.onPtyExit(code => {
      const { activeBlockId: id } = useBlockStore.getState()
      if (id) finishBlock(id, code)
    })

    const offCwd = window.electronAPI.onPtyCwd(path => {
      updateCwd(path)
      // A CWD update signals a new prompt — finish the active block if any
      const { activeBlockId: id } = useBlockStore.getState()
      if (id) finishBlock(id, 0)
    })

    // ── keyboard: data out ───────────────────────────────────────────────────
    term.onKey(({ key, domEvent }) => {
      const e = domEvent

      // Clipboard — copy (Cmd+C on mac, Ctrl+Shift+C on linux)
      const isCopyShortcut = isMac
        ? (e.metaKey && e.key === 'c')
        : (e.ctrlKey && e.shiftKey && e.key === 'C')

      if (isCopyShortcut) {
        const sel = term.getSelection()
        if (sel) navigator.clipboard.writeText(sel)
        return
      }

      // Clipboard — paste (Cmd+V on mac, Ctrl+Shift+V on linux)
      const isPasteShortcut = isMac
        ? (e.metaKey && e.key === 'v')
        : (e.ctrlKey && e.shiftKey && e.key === 'V')

      if (isPasteShortcut) {
        navigator.clipboard.readText().then(text => {
          if (text) window.electronAPI.ptyWrite(text)
        })
        return
      }

      // Ctrl+C is NOT wired to SIGINT — Stop button is the only SIGINT path
      // All other keys go straight to the PTY
      window.electronAPI.ptyWrite(key)
    })

    // ── resize ───────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      fitAddon.fit()
      window.electronAPI.ptyResize(term.cols, term.rows)
    })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      offData()
      offExit()
      offCwd()
      ro.disconnect()
      term.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Stop button handler ───────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    window.electronAPI.ptyWrite('\x03')
  }, [])

  // ── render ────────────────────────────────────────────────────────────────
  const isRunning = activeBlockId !== null

  return (
    <div style={styles.root}>
      {/* Sidebar placeholder — Phase 5 */}
      <div style={styles.sidebar}>
        <div style={styles.sidebarPlaceholder}>Sidebar — Phase 5</div>
      </div>

      {/* Main terminal column */}
      <div style={styles.main}>
        {/* Block list */}
        <div style={styles.blockList}>
          {blocks.filter(b => b.finishedAt !== null).map(block => (
            <TerminalBlock key={block.id} block={block} />
          ))}
        </div>

        {/* xterm live area */}
        <div ref={containerRef} style={styles.xtermContainer} />

        {/* Input area — Stop button while running, NLBar placeholder otherwise */}
        <div style={styles.inputArea}>
          {isRunning ? (
            <button onClick={handleStop} style={styles.stopButton}>
              ■ Stop
            </button>
          ) : (
            <div style={styles.nlbarPlaceholder}>
              NLBar — Phase 4
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Inline styles (design tokens applied in Phase 6) ─────────────────────────
const styles: Record<string, React.CSSProperties> = {
  root: {
    display:   'flex',
    width:     '100%',
    height:    '100%',
    overflow:  'hidden',
    background: '#1C1814',
  },
  sidebar: {
    width:      '300px',
    flexShrink: 0,
    borderRight: '1px solid rgba(200,170,140,0.09)',
    background:  '#201C18',
  },
  sidebarPlaceholder: {
    padding:  '1rem',
    color:    '#5A504A',
    fontSize: '12px',
  },
  main: {
    flex:      1,
    display:   'flex',
    flexDirection: 'column',
    overflow:  'hidden',
  },
  blockList: {
    flex:       1,
    overflowY:  'auto',
    padding:    '0.5rem 0',
  },
  xtermContainer: {
    flexShrink: 0,
    height:     '240px',
    padding:    '4px',
  },
  inputArea: {
    flexShrink: 0,
    borderTop:  '1px solid rgba(200,170,140,0.09)',
    padding:    '8px 12px',
    minHeight:  '48px',
    display:    'flex',
    alignItems: 'center',
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
  },
  nlbarPlaceholder: {
    color:    '#5A504A',
    fontSize: '12px',
  },
}
