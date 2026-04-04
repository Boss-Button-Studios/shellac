// ContextSanitizer — spec §9
// Written in full here; unit-tested in Phase 2.

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above)\s+instructions?/i,
  /system\s*:/i,
  /you\s+are\s+(now\s+)?a/i,
  /new\s+instructions?\s*:/i,
  /\bforget\s+(everything|all)\b/i,
  /\[INST\]|\[\/INST\]/,
  /<\|system\|>|<\|user\|>/,
]

// OSC sequences, null bytes, DCS sequences — strip from context, not from display
const DANGEROUS_SEQUENCES: RegExp[] = [/\x1b\]/, /\x00/, /\x1bP/]

// Non-ASCII chars that visually resemble ASCII — homograph attack vector
const NON_ASCII_PATTERN = /[^\x00-\x7F]/

export interface SanitizeResult {
  text:    string
  flagged: boolean
  reasons: string[]
}

export function sanitizeForContext(raw: string): SanitizeResult {
  const reasons: string[] = []
  let text = raw

  for (const p of DANGEROUS_SEQUENCES) {
    if (p.test(text)) {
      reasons.push(`Stripped control sequence: ${p.source}`)
      text = text.replace(new RegExp(p.source, 'g'), '')
    }
  }

  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) reasons.push(`Injection pattern: ${p.source}`)
  }

  if (NON_ASCII_PATTERN.test(text)) {
    reasons.push('Non-ASCII characters detected (potential homograph)')
  }

  return { text, flagged: reasons.length > 0, reasons }
}

// Wraps sanitized command+exit for use in model prompts.
// stdout never enters this path by default (spec §10).
export function wrapForContext(command: string, exitCode: number): string {
  return `<untrusted_history>\n[command]: ${command}\n[exit_code]: ${exitCode}\n</untrusted_history>`
}
