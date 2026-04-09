// NLBar — spec §17 NLBar
//
// The single input surface for both natural language and bash commands.
// Routing happens on submit:
//   - looksLikeBash() → SuggestedCommand{source:'direct'}, no model call
//   - else            → translate() → SuggestedCommand{source:'generator'}
//
// Ghost text: when the first token matches COMMAND_HINTS, dim synopsis text
// is shown inline after the user's typed value.
//
// Error recovery: OllamaUnavailableError shows a copyable three-line panel.
// The query is preserved — user can retry after starting Ollama.

import { useEffect, useRef, useState, useCallback } from 'react'
import { useBlockStore } from '../lib/BlockStore.ts'
import { translate, looksLikeBash, COMMAND_HINTS } from '../lib/AIBridge.ts'
import { OllamaUnavailableError } from '../types/index.ts'
import type { AppConfig } from '../types/index.ts'

const isMac = navigator.platform.startsWith('Mac')

interface Props {
  config:          AppConfig
  onFocusXterm:    () => void  // called when Escape clears with nothing in flight
  disabled?:       boolean
}

export default function NLBar({ config, onFocusXterm, disabled }: Props) {
  const [value,    setValue]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const inputRef      = useRef<HTMLInputElement>(null)
  const abortRef      = useRef<AbortController | null>(null)

  const setSuggestion = useBlockStore(s => s.setSuggestion)

  // ── Cmd+K / Ctrl+K: focus from anywhere ────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isActivate = isMac
        ? (e.metaKey && e.key === 'k')
        : (e.ctrlKey && e.key === 'k')
      if (isActivate) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Ghost text: synopsis for the first known command token ────────────────
  const ghostSuffix = (() => {
    if (!value || loading) return ''
    const firstToken = value.trimStart().split(/\s+/)[0]
    const hint = COMMAND_HINTS[firstToken]
    if (!hint) return ''
    // Show the portion of the synopsis that extends beyond what the user typed
    if (hint.startsWith(value.trimStart())) return hint.slice(value.trimStart().length)
    // If user typed beyond the synopsis, show nothing (they know what they're doing)
    return ''
  })()

  // ── Submit handler ─────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const query = value.trim()
    if (!query || loading || disabled) return

    setError(null)

    if (looksLikeBash(query)) {
      // Bash path — no model call. Validator runs inside SuggestionCard.
      setSuggestion({ command: query, explanation: '', confidence: 'high', source: 'direct' })
      return
    }

    // NL path — call translate()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)

    try {
      const contextBlocks = useBlockStore.getState().getContextBlocks()
      const suggestion = await translate(query, contextBlocks, config, controller.signal)
      // Preserve the NL query so the block can label itself
      setSuggestion({ ...suggestion, nlQuery: query } as typeof suggestion & { nlQuery: string })
    } catch (err) {
      if (controller.signal.aborted) return  // user pressed Escape — silent
      if (err instanceof OllamaUnavailableError) {
        setError('ollama-unavailable')
      } else {
        setError(err instanceof Error ? err.message : 'Unknown error')
      }
    } finally {
      abortRef.current = null
      setLoading(false)
    }
  }, [value, loading, disabled, config, setSuggestion])

  // ── Keyboard handler (on input element) ───────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
        setLoading(false)
      } else {
        setValue('')
        setError(null)
        onFocusXterm()
      }
    }
  }, [handleSubmit, onFocusXterm])

  // ── Window-level keydown: clears error panel so the user isn't stuck ───────
  // When the error panel is shown the <input> is unmounted, so handleKeyDown
  // never fires. This listener catches any key and restores the input.
  useEffect(() => {
    if (!error) return
    const handler = (e: KeyboardEvent) => {
      // Don't steal modifier-only combos or tab navigation
      if (e.key === 'Tab' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') return
      setError(null)
      // Re-focus the input on the next tick (after it mounts)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [error])

  // ── Error panels ──────────────────────────────────────────────────────────
  const clearError = () => {
    setError(null)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (error === 'ollama-unavailable') {
    return (
      <div style={styles.recovery}>
        <div style={styles.recoveryRow}>
          <div style={styles.recoveryTitle}>Ollama is not running.</div>
          <button style={styles.recoveryDismiss} onClick={clearError} title="Dismiss">✕</button>
        </div>
        <CopyLine label="Start it:" cmd="ollama serve" />
        <CopyLine label="Check it:" cmd="ollama list" />
        <div style={styles.recoveryHint}>
          Not installed? Run Shellac&apos;s installer again.
        </div>
        <div style={styles.recoveryQuery}>
          <span style={styles.recoveryQueryLabel}>Your query: </span>
          <span style={styles.recoveryQueryText}>{value}</span>
        </div>
      </div>
    )
  }

  // Generic model error — show the message so we can diagnose
  if (error) {
    return (
      <div style={styles.recovery}>
        <div style={styles.recoveryRow}>
          <div style={styles.recoveryTitle}>Model error</div>
          <button style={styles.recoveryDismiss} onClick={clearError} title="Dismiss">✕</button>
        </div>
        <div style={styles.recoveryError}>{error}</div>
        <div style={styles.recoveryHint}>Press any key or click ✕ to retry.</div>
        <div style={styles.recoveryQuery}>
          <span style={styles.recoveryQueryLabel}>Your query: </span>
          <span style={styles.recoveryQueryText}>{value}</span>
        </div>
      </div>
    )
  }

  // ── Normal input ──────────────────────────────────────────────────────────
  return (
    <div style={styles.wrapper}>
      {/* Accent glyph */}
      <span style={styles.glyph} aria-hidden="true">›</span>

      {/* Input + ghost text container */}
      <div style={styles.inputContainer}>
        {/* Ghost text layer — positioned behind input, same font/size */}
        {ghostSuffix && (
          <div style={styles.ghostLayer} aria-hidden="true">
            <span style={{ color: 'transparent' }}>{value}</span>
            <span style={styles.ghost}>{ghostSuffix}</span>
          </div>
        )}

        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || loading}
          placeholder={loading ? '' : 'Type a command or describe what you want to do…'}
          style={styles.input}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

      {/* Loading indicator */}
      {loading && <span style={styles.spinner} aria-label="Translating…">⟳</span>}
    </div>
  )
}

// ── CopyLine: a recovery instruction line that copies on click ─────────────
function CopyLine({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    window.electronAPI.clipboardWrite(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div style={styles.recoveryLine}>
      <span style={styles.recoveryLabel}>{label}</span>
      <button style={styles.recoveryCmd} onClick={handleCopy} title="Click to copy">
        {cmd}
        {copied && <span style={styles.copiedBadge}> ✓</span>}
      </button>
    </div>
  )
}

// Re-export for Terminal.tsx to focus the NLBar programmatically
export { NLBar }

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display:     'flex',
    alignItems:  'center',
    gap:         '8px',
    flex:        1,
  },
  glyph: {
    color:      '#C4844A',
    fontSize:   '18px',
    flexShrink: 0,
    lineHeight: 1,
    userSelect: 'none',
  },
  inputContainer: {
    position:   'relative',
    flex:       1,
    display:    'flex',
    alignItems: 'center',
  },
  ghostLayer: {
    position:    'absolute',
    top:         0,
    left:        0,
    right:       0,
    bottom:      0,
    display:     'flex',
    alignItems:  'center',
    pointerEvents: 'none',
    fontFamily:  "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:    '13px',
    whiteSpace:  'pre',
    overflow:    'hidden',
  },
  ghost: {
    color: '#5A504A',
  },
  input: {
    flex:         1,
    background:   'transparent',
    border:       'none',
    outline:      'none',
    color:        '#E8DDD0',
    fontFamily:   "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:     '13px',
    padding:      0,
    width:        '100%',
    caretColor:   '#C4844A',
  },
  spinner: {
    color:     '#C4844A',
    fontSize:  '14px',
    flexShrink: 0,
    animation: 'spin 1s linear infinite',
  },
  // ── Recovery panel ──────────────────────────────────────────────────────────
  recovery: {
    flex:        1,
    padding:     '4px 0',
    fontFamily:  '-apple-system, system-ui, sans-serif',
    fontSize:    '12px',
  },
  recoveryRow: {
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  recoveryDismiss: {
    background:  'transparent',
    border:      'none',
    color:       '#5A504A',
    cursor:      'pointer',
    fontSize:    '12px',
    padding:     '0 2px',
    lineHeight:  1,
  },
  recoveryTitle: {
    color:       '#E8DDD0',
    fontWeight:  600,
    marginBottom: '4px',
  },
  recoveryLine: {
    display:    'flex',
    gap:        '6px',
    alignItems: 'center',
    marginBottom: '2px',
  },
  recoveryLabel: {
    color:      '#8A7D70',
    minWidth:   '58px',
  },
  recoveryCmd: {
    background:   'rgba(196,132,74,0.1)',
    border:       '1px solid rgba(196,132,74,0.25)',
    borderRadius: '4px',
    color:        '#C4844A',
    fontFamily:   "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:     '11px',
    padding:      '1px 6px',
    cursor:       'pointer',
  },
  copiedBadge: {
    color:   '#7A9E7E',
    marginLeft: '4px',
  },
  recoveryError: {
    fontFamily:  "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:    '11px',
    color:       '#C46060',
    marginBottom: '4px',
    wordBreak:   'break-all' as const,
  },
  recoveryHint: {
    color:       '#5A504A',
    fontSize:    '11px',
    marginTop:   '4px',
  },
  recoveryQuery: {
    marginTop:  '6px',
    display:    'flex',
    gap:        '4px',
    alignItems: 'center',
  },
  recoveryQueryLabel: {
    color: '#5A504A',
  },
  recoveryQueryText: {
    color:      '#8A7D70',
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:   '12px',
  },
}
