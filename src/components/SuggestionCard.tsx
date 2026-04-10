// SuggestionCard — spec §17 SuggestionCard
//
// Shown after translate() or looksLikeBash() produces a SuggestedCommand.
// Runs validateCommand() + explainCommand() in parallel on mount.
// Command is editable — if the user changes it and the previous result was
// warn or block, re-validates before allowing confirmation.
//
// Visual states:
//   pass  → normal border
//   warn  → amber border + reason shown
//   block → red border + Run button disabled
//
// "Run" becomes "Run anyway" when explanation.reversible === false.
//
// Unicode confusable: non-ASCII characters in the command are highlighted
// amber to surface homograph attacks before the user confirms (spec §9).

import { useEffect, useRef, useState, useCallback } from 'react'
import { validateCommand } from '../lib/CommandValidator.ts'
import { explainCommand }   from '../lib/CommandExplainer.ts'
import type {
  SuggestedCommand, ValidationResult, CommandExplanation, AppConfig
} from '../types/index.ts'

// Characters that are NOT standard 7-bit ASCII — potential confusables
const NON_ASCII = /[^\x00-\x7F]/g

// ScopeState tracks the async semantic check result.
// 'pending' while the model hasn't responded yet.
// 'clear'   when no scope concerns were found.
// 'warn'    when the model flagged an over-scoped flag (sudo, recursive, etc.).
// This is separate from the static danger verdict — scope warnings are advisory.
// Used once the model selection gate in validator-semantic-check.md is passed.
export type ScopeState =
  | { status: 'pending' }
  | { status: 'clear' }
  | { status: 'warn'; reason: string }

interface Props {
  suggestion:  SuggestedCommand & { nlQuery?: string }
  config:      AppConfig
  onConfirm:   (command: string, nlQuery?: string) => void
  onDismiss:   () => void
}

export default function SuggestionCard({ suggestion, config, onConfirm, onDismiss }: Props) {
  const [command,     setCommand]     = useState(suggestion.command)
  const [validation,  setValidation]  = useState<ValidationResult | null>(null)
  const [explanation, setExplanation] = useState<CommandExplanation | null>(null)
  const [validating,  setValidating]  = useState(true)
  const [explaining,  setExplaining]  = useState(config.explainCommands !== 'off')
  // Track whether the user has edited the command since the last validation
  const [editedSinceValidate, setEditedSinceValidate] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── Focus the textarea on mount ────────────────────────────────────────────
  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  // ── Initial parallel validation + explanation ──────────────────────────────
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setValidating(true)
      setExplaining(config.explainCommands !== 'off')

      const tasks: [Promise<ValidationResult>, Promise<CommandExplanation | null>] = [
        validateCommand(suggestion.command, suggestion.nlQuery, config),
        config.explainCommands !== 'off'
          ? explainCommand(suggestion.command, config)
          : Promise.resolve(null),
      ]

      const [vr, er] = await Promise.allSettled(tasks)

      if (cancelled) return

      if (vr.status === 'fulfilled') {
        setValidation(vr.value)
      } else {
        // Validator threw — fail open (never block the user)
        setValidation({ approved: true, confidence: 'warn', reasons: ['Validator error'] })
      }
      setValidating(false)

      if (er.status === 'fulfilled') {
        setExplanation(er.value)
      }
      setExplaining(false)
    }

    run()
    return () => { cancelled = true }
  // Only run once on mount — command edits re-validate separately
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Re-validate when command changes and previous result was warn/block ────
  // We debounce by only re-running when the user stops typing (on blur or Enter)
  const revalidate = useCallback(async (cmd: string) => {
    if (!editedSinceValidate) return
    setValidating(true)
    try {
      const result = await validateCommand(cmd, suggestion.nlQuery, config)
      setValidation(result)
    } catch {
      setValidation({ approved: true, confidence: 'warn', reasons: ['Validator error'] })
    } finally {
      setValidating(false)
      setEditedSinceValidate(false)
    }
  }, [editedSinceValidate, suggestion.nlQuery, config])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
    }
    // Enter without Shift in the textarea confirms (Shift+Enter = newline in textarea)
    if (e.key === 'Enter' && !e.shiftKey && e.target === textareaRef.current) {
      e.preventDefault()
      if (canRun) handleRun()
    }
  }, [onDismiss])  // canRun/handleRun defined below — use callback ref pattern

  const canRun = !validating && validation?.confidence !== 'block'

  const handleRun = () => {
    if (!canRun) return
    onConfirm(command, suggestion.nlQuery)
  }

  // ── Command display with confusable highlight ──────────────────────────────
  // Split command string into ASCII and non-ASCII segments. Non-ASCII chars
  // are rendered amber to surface potential homograph attacks.
  const commandSegments = highlightConfusables(command)

  // ── Border color driven by validation state ────────────────────────────────
  const borderColor =
    validation?.confidence === 'block' ? '#C46060' :
    validation?.confidence === 'warn'  ? '#D4855A' :
    'rgba(200,170,140,0.14)'

  // ── Run button label ───────────────────────────────────────────────────────
  const runLabel = explanation?.reversible === false ? 'Run anyway' : 'Run'

  return (
    <div
      style={{ ...styles.card, borderColor }}
      onKeyDown={handleKeyDown}
    >
      {/* Source badge + dismiss row */}
      <div style={styles.topRow}>
        <span style={styles.sourceBadge}>
          {suggestion.source === 'direct' ? 'direct' : 'local model'}
        </span>
        {suggestion.nlQuery && (
          <span style={styles.nlQuery}>{suggestion.nlQuery}</span>
        )}
        <button style={styles.dismissBtn} onClick={onDismiss} title="Dismiss (Escape)">
          ✕
        </button>
      </div>

      {/* Editable command */}
      <div style={styles.commandArea}>
        {/* Read-only highlighted view — visible only when non-ASCII chars exist */}
        {commandSegments.hasConfusable ? (
          <div style={styles.confusableWarning}>
            <span style={styles.confusableLabel}>⚠ Non-ASCII characters detected</span>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={command}
          onChange={e => {
            setCommand(e.target.value)
            // Mark as edited if the previous validation was warn or block
            if (validation?.confidence === 'warn' || validation?.confidence === 'block') {
              setEditedSinceValidate(true)
            }
          }}
          onBlur={() => {
            if (editedSinceValidate) revalidate(command)
          }}
          style={styles.textarea}
          rows={1}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />

        {/* Confusable character overlay — shown below textarea */}
        {commandSegments.hasConfusable && (
          <div style={styles.commandPreview} aria-hidden="true">
            {commandSegments.parts.map((seg, i) =>
              seg.isAscii
                ? <span key={i}>{seg.text}</span>
                : <span key={i} style={styles.confusableChar}>{seg.text}</span>
            )}
          </div>
        )}
      </div>

      {/* Validation result */}
      <ValidationRow
        validation={validation}
        validating={validating}
      />

      {/* Explanation — lazy, shown when available */}
      {config.explainCommands !== 'off' && (
        <ExplanationRow
          explanation={explanation}
          explaining={explaining}
        />
      )}

      {/* Action buttons */}
      <div style={styles.actions}>
        <button
          style={{
            ...styles.runBtn,
            ...(canRun ? {} : styles.runBtnDisabled),
            ...(validation?.confidence === 'warn' ? styles.runBtnWarn : {}),
          }}
          onClick={handleRun}
          disabled={!canRun}
          title={canRun ? undefined : 'Blocked — edit the command to proceed'}
        >
          {validating ? '…' : runLabel}
        </button>
        <button style={styles.dismissBtnSecondary} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

// ── ValidationRow ─────────────────────────────────────────────────────────────

function ValidationRow({
  validation,
  validating,
}: {
  validation: ValidationResult | null
  validating: boolean
}) {
  if (validating) {
    return <div style={styles.validationRow}><span style={styles.muted}>Checking…</span></div>
  }
  if (!validation || validation.confidence === 'pass') return null

  const isBlock = validation.confidence === 'block'

  // Split reasons by prefix:
  //   no prefix  → static analysis danger (strong colour)
  //   'intent:'  → coherence mismatch from semantic check (muted italic)
  //   'scope:'   → over-scoped flag from semantic check (muted italic)
  const staticReasons = validation.reasons.filter(r => !r.startsWith('intent:') && !r.startsWith('scope:'))
  const intentReasons = validation.reasons
    .filter(r => r.startsWith('intent:'))
    .map(r => r.slice('intent:'.length))
  const scopeReasons  = validation.reasons
    .filter(r => r.startsWith('scope:'))
    .map(r => r.slice('scope:'.length))

  return (
    <div style={styles.validationRow}>
      {/* Static danger reasons — strong colour, shown for block/warn */}
      {(isBlock || staticReasons.length > 0) && (
        <div style={{ color: isBlock ? '#C46060' : '#D4855A' }}>
          <span>{isBlock ? '✕ Blocked' : '⚠ Caution'}</span>
          {staticReasons.slice(0, 2).map((r, i) => (
            <span key={i} style={styles.validationReason}>{r}</span>
          ))}
        </div>
      )}
      {/* Intent/scope reasons from semantic check — muted, softer framing */}
      {intentReasons.slice(0, 1).map((r, i) => (
        <div key={`intent-${i}`} style={styles.intentReason}>
          ↳ May not match your intent: {r}
        </div>
      ))}
      {scopeReasons.slice(0, 2).map((r, i) => (
        <div key={`scope-${i}`} style={styles.intentReason}>
          ↳ {r}
        </div>
      ))}
    </div>
  )
}

// ── ExplanationRow ────────────────────────────────────────────────────────────

function ExplanationRow({
  explanation,
  explaining,
}: {
  explanation: CommandExplanation | null
  explaining: boolean
}) {
  if (explaining) {
    return <div style={styles.explainRow}><span style={styles.muted}>Explaining…</span></div>
  }
  if (!explanation || !explanation.summary) return null

  return (
    <div style={styles.explainRow}>
      <div style={styles.explainSummary}>{explanation.summary}</div>
      {explanation.reversible === false && (
        <div style={styles.irreversible}>Cannot be undone.</div>
      )}
      {explanation.reversible === null && (
        <div style={styles.reversibleUnknown}>Reversibility unknown</div>
      )}
      {explanation.requiresSudo && (
        <div style={styles.sudoWarning}>Requires elevated privileges</div>
      )}
      {explanation.confidence === 'low' && (
        <div style={styles.lowConfidence}>I&apos;m not certain — review carefully</div>
      )}
      {explanation.effects.length > 0 && (
        <ul style={styles.effectsList}>
          {explanation.effects.slice(0, 4).map((e, i) => (
            <li key={i} style={styles.effectItem}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Confusable segment helper ─────────────────────────────────────────────────
//
// Splits a string into ASCII-safe and non-ASCII segments for rendering.

interface Segment { text: string; isAscii: boolean }

function highlightConfusables(cmd: string): { parts: Segment[]; hasConfusable: boolean } {
  const parts: Segment[] = []
  let hasConfusable = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  NON_ASCII.lastIndex = 0  // reset global regex
  // eslint-disable-next-line no-cond-assign
  while ((match = NON_ASCII.exec(cmd)) !== null) {
    hasConfusable = true
    if (match.index > lastIndex) {
      parts.push({ text: cmd.slice(lastIndex, match.index), isAscii: true })
    }
    parts.push({ text: match[0], isAscii: false })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < cmd.length) {
    parts.push({ text: cmd.slice(lastIndex), isAscii: true })
  }
  if (parts.length === 0) parts.push({ text: cmd, isAscii: true })

  return { parts, hasConfusable }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  card: {
    background:   '#252018',
    border:       '1px solid rgba(200,170,140,0.14)',
    borderRadius: '8px',
    padding:      '10px 12px',
    marginBottom: '8px',
    transition:   'border-color 180ms ease-out',
  },
  topRow: {
    display:     'flex',
    alignItems:  'center',
    gap:         '8px',
    marginBottom: '8px',
  },
  sourceBadge: {
    background:   'rgba(196,132,74,0.12)',
    border:       '1px solid rgba(196,132,74,0.25)',
    borderRadius: '4px',
    color:        '#C4844A',
    fontSize:     '10px',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    padding:      '1px 5px',
    fontWeight:   600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    flexShrink:   0,
  },
  nlQuery: {
    flex:       1,
    color:      '#5A504A',
    fontSize:   '11px',
    fontFamily: '-apple-system, system-ui, sans-serif',
    overflow:   'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dismissBtn: {
    background:  'transparent',
    border:      'none',
    color:       '#5A504A',
    cursor:      'pointer',
    fontSize:    '12px',
    padding:     '2px 4px',
    flexShrink:  0,
    lineHeight:  1,
  },
  commandArea: {
    marginBottom: '8px',
  },
  textarea: {
    width:        '100%',
    background:   'rgba(28,24,20,0.6)',
    border:       '1px solid rgba(200,170,140,0.09)',
    borderRadius: '5px',
    color:        '#E8DDD0',
    fontFamily:   "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:     '13px',
    padding:      '6px 8px',
    resize:       'none',
    outline:      'none',
    boxSizing:    'border-box' as const,
    lineHeight:   '1.5',
  },
  confusableWarning: {
    marginBottom: '4px',
  },
  confusableLabel: {
    color:     '#D4855A',
    fontSize:  '11px',
    fontFamily: '-apple-system, system-ui, sans-serif',
  },
  commandPreview: {
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:   '13px',
    color:      '#E8DDD0',
    marginTop:  '4px',
    padding:    '2px 8px',
  },
  confusableChar: {
    color:           '#D4855A',
    textDecoration:  'underline',
    textDecorationStyle: 'wavy' as const,
  },
  validationRow: {
    display:      'flex',
    flexDirection: 'column' as const,
    gap:          '2px',
    marginBottom: '6px',
    fontSize:     '11px',
    fontFamily:   '-apple-system, system-ui, sans-serif',
  },
  validationReason: {
    color:       '#8A7D70',
    paddingLeft: '12px',
  },
  intentReason: {
    color:       '#8A7D70',
    fontSize:    '11px',
    fontStyle:   'italic',
    marginTop:   '2px',
  },
  explainRow: {
    marginBottom: '8px',
    fontSize:     '12px',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    color:        '#8A7D70',
  },
  explainSummary: {
    color:        '#C8BDB0',
    marginBottom: '4px',
  },
  irreversible: {
    color:      '#D4855A',
    fontWeight: 600,
    marginBottom: '2px',
  },
  reversibleUnknown: {
    color:        '#5A504A',
    fontStyle:    'italic',
    marginBottom: '2px',
  },
  sudoWarning: {
    color:        '#D4855A',
    marginBottom: '2px',
  },
  lowConfidence: {
    fontStyle:    'italic',
    color:        '#8A7D70',
    marginBottom: '2px',
  },
  effectsList: {
    margin:      '4px 0 0 0',
    paddingLeft: '16px',
    color:       '#8A7D70',
  },
  effectItem: {
    marginBottom: '1px',
  },
  actions: {
    display:    'flex',
    gap:        '8px',
    alignItems: 'center',
  },
  runBtn: {
    background:   '#C4844A',
    border:       'none',
    borderRadius: '5px',
    color:        '#1C1814',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '12px',
    fontWeight:   700,
    padding:      '5px 14px',
    cursor:       'pointer',
  },
  runBtnDisabled: {
    background: '#3A3028',
    color:      '#5A504A',
    cursor:     'not-allowed',
  },
  runBtnWarn: {
    background: 'rgba(212,133,90,0.15)',
    border:     '1px solid #D4855A',
    color:      '#D4855A',
  },
  dismissBtnSecondary: {
    background:   'transparent',
    border:       '1px solid rgba(200,170,140,0.14)',
    borderRadius: '5px',
    color:        '#8A7D70',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    fontSize:     '12px',
    padding:      '5px 12px',
    cursor:       'pointer',
  },
  muted: {
    color:     '#5A504A',
    fontFamily: '-apple-system, system-ui, sans-serif',
    fontSize:  '11px',
  },
}
