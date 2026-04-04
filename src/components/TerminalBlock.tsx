import { useState, useMemo } from 'react'
import AnsiToHtml from 'ansi-to-html'
import type { Block } from '../types/index.ts'

// ansi-to-html MUST be instantiated with escapeXML: true — non-negotiable (spec §3)
const ansiConverter = new AnsiToHtml({ escapeXML: true })

const OUTPUT_LINE_LIMIT = 100

interface Props {
  block: Block
}

export default function TerminalBlock({ block }: Props) {
  const [expanded, setExpanded] = useState(false)

  const elapsed = block.finishedAt !== null
    ? ((block.finishedAt - block.startedAt) / 1000).toFixed(1) + 's'
    : null

  const exitSuccess = block.exitCode === 0

  // Convert ANSI output to HTML — escapeXML: true prevents XSS
  const outputLines = useMemo(() => {
    if (!block.output) return []
    return block.output.split('\n')
  }, [block.output])

  const visibleLines  = expanded ? outputLines : outputLines.slice(0, OUTPUT_LINE_LIMIT)
  const truncated     = outputLines.length > OUTPUT_LINE_LIMIT && !expanded
  const renderedHtml  = useMemo(
    () => ansiConverter.toHtml(visibleLines.join('\n')),
    [visibleLines]
  )

  const copyCommand = () => {
    navigator.clipboard.writeText(block.command)
  }

  return (
    <div style={styles.block}>
      {/* NL query label — dim, above header */}
      {block.nlQuery && (
        <div style={styles.nlLabel}>{block.nlQuery}</div>
      )}

      {/* Header: $ command  exit-badge  elapsed */}
      <div style={styles.header} onClick={copyCommand} title="Click to copy command">
        <span style={styles.prompt}>$</span>
        <span style={styles.command}>{block.command}</span>
        <div style={styles.headerMeta}>
          {block.exitCode !== null && (
            <span style={{
              ...styles.exitBadge,
              background: exitSuccess ? 'rgba(122,158,126,0.15)' : 'rgba(196,96,96,0.15)',
              color:      exitSuccess ? '#7A9E7E'                 : '#C46060',
            }}>
              {exitSuccess ? '✓' : '✗'} {block.exitCode}
            </span>
          )}
          {elapsed && <span style={styles.elapsed}>{elapsed}</span>}
        </div>
      </div>

      {/* Output */}
      {block.output && (
        <div style={styles.outputWrapper}>
          <div
            style={styles.output}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
          {truncated && (
            <button style={styles.expandBtn} onClick={() => setExpanded(true)}>
              Show all {outputLines.length} lines
            </button>
          )}
        </div>
      )}

      {/* "Help me fix this" — stub, wired in Phase 4 */}
      {block.exitCode !== null && block.exitCode !== 0 && (
        <button style={styles.helpBtn} disabled>
          Help me fix this
        </button>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  block: {
    borderBottom: '1px solid rgba(200,170,140,0.09)',
    marginBottom: '2px',
  },
  nlLabel: {
    padding:    '4px 12px 0',
    fontSize:   '11px',
    color:      '#5A504A',
    fontFamily: '-apple-system, system-ui, sans-serif',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    gap:            '8px',
    padding:        '6px 12px',
    background:     '#262018',
    cursor:         'pointer',
    userSelect:     'none',
    fontFamily:     "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    fontSize:       '13px',
  },
  prompt: {
    color:      '#C4844A',
    flexShrink: 0,
  },
  command: {
    color:    '#E8DDD0',
    flex:     1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerMeta: {
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    flexShrink: 0,
  },
  exitBadge: {
    borderRadius: '4px',
    padding:      '1px 6px',
    fontSize:     '11px',
    fontWeight:   600,
    fontFamily:   '-apple-system, system-ui, sans-serif',
  },
  elapsed: {
    fontSize: '11px',
    color:    '#5A504A',
    fontFamily: '-apple-system, system-ui, sans-serif',
  },
  outputWrapper: {
    borderLeft:  '2px solid rgba(196,132,74,0.14)',
    marginLeft:  '12px',
    background:  '#1E1A16',
  },
  output: {
    padding:    '6px 10px',
    fontSize:   '12px',
    fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
    color:      '#E8DDD0',
    whiteSpace: 'pre-wrap',
    wordBreak:  'break-all',
    lineHeight: 1.5,
  },
  expandBtn: {
    display:     'block',
    width:       '100%',
    background:  'transparent',
    border:      'none',
    borderTop:   '1px solid rgba(200,170,140,0.09)',
    color:       '#8A7D70',
    fontSize:    '11px',
    padding:     '4px',
    cursor:      'pointer',
    fontFamily:  '-apple-system, system-ui, sans-serif',
    textAlign:   'center',
  },
  helpBtn: {
    display:      'block',
    background:   'transparent',
    border:       '1px solid rgba(200,170,140,0.14)',
    borderRadius: '4px',
    color:        '#8A7D70',
    fontSize:     '11px',
    padding:      '3px 8px',
    margin:       '4px 12px 6px',
    cursor:       'not-allowed',
    fontFamily:   '-apple-system, system-ui, sans-serif',
    opacity:      0.6,
  },
}
