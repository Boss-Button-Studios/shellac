// CommandValidator — spec §12
//
// Responsibilities:
//   - Static analysis: pattern-matching against known danger signatures.
//     Synchronous. Free. Runs first on every command.
//   - Semantic check: mistral:7b evaluates intent vs. command. Runs only
//     if static analysis passes.
//
// Model choice: mistral:7b (not the generator qwen2.5-coder:7b).
// Different architecture, different training lineage. A jailbreak that fools
// the generator cannot automatically fool the validator (spec §12).
//
// Fail-open: if the semantic check errors for any reason, we return 'warn'
// rather than blocking. A broken validator must never block the user's terminal.

import type { ValidationResult, AppConfig, SafetyLevel } from '../types/index.ts'

// ─── Static pattern tables ────────────────────────────────────────────────────
//
// DANGER_ALWAYS: blocked at every safety level — no config overrides these.
//   These patterns have no safe use case a neophyte or even pro user would
//   need from a suggestion (fork bomb, full-disk overwrite, root-level wipe).
//
// DANGER_BY_LEVEL: patterns that are blocked at some safety levels but only
//   warned at 'pro', where the user is assumed to know what they're doing.
//
// WARN_BY_LEVEL: patterns that produce a warning at some levels but pass at
//   others. The user sees the card with a caution badge but can still run.

const DANGER_ALWAYS: RegExp[] = [
  /\brm\s+-[rf]{1,2}f?\s+\/(?!\w)/,   // rm -rf / or rm -f / (root wipe)
  /\bmkfs\b/,                           // format a filesystem
  /\bdd\b.*of=\/dev/,                   // dd writing to a raw device
  /:\(\)\{.*\}/,                        // fork bomb  :(){ :|:& };:
]

const DANGER_BY_LEVEL: Record<SafetyLevel, RegExp[]> = {
  // newbie: any sudo+destructive or piped-download-execute
  newbie: [
    /sudo\s+(rm|dd|mkfs)/,
    /curl[^|]*\|\s*(ba)?sh/,
    /wget[^|]*\|\s*(ba)?sh/,
    /\brm\s+-rf?\b/,
  ],
  // balanced: pipe-exec and sudo-destructive still blocked; bare rm -rf warned not blocked
  balanced: [
    /curl[^|]*\|\s*(ba)?sh/,
    /wget[^|]*\|\s*(ba)?sh/,
    /sudo\s+(rm|dd|mkfs)/,
  ],
  // pro: nothing is auto-blocked beyond DANGER_ALWAYS
  pro: [],
}

const WARN_BY_LEVEL: Record<SafetyLevel, RegExp[]> = {
  newbie:   [/\bsudo\b/, /\bchmod\b/, /\bgit\s+(reset|rebase|push\s+-f)/],
  balanced: [/\brm\s+-rf?\b/, /\bsudo\b/, /\bgit\s+reset\s+--hard/],
  pro:      [/\brm\s+-rf\s+\//, /curl[^|]*\|\s*(ba)?sh/, /wget[^|]*\|\s*(ba)?sh/],
}

// ─── Static analysis ──────────────────────────────────────────────────────────
//
// Returns the most severe verdict (block > warn > pass) along with the matching
// reason. Does not call any model.

interface StaticResult {
  verdict: 'pass' | 'warn' | 'block'
  reasons: string[]
}

function staticAnalysis(command: string, safetyLevel: SafetyLevel): StaticResult {
  const reasons: string[] = []

  // Always-blocked regardless of level
  for (const pattern of DANGER_ALWAYS) {
    if (pattern.test(command)) {
      reasons.push(`Always-blocked pattern: ${pattern.source}`)
    }
  }
  if (reasons.length > 0) return { verdict: 'block', reasons }

  // Level-specific blocks
  for (const pattern of DANGER_BY_LEVEL[safetyLevel]) {
    if (pattern.test(command)) {
      reasons.push(`Blocked at ${safetyLevel}: ${pattern.source}`)
    }
  }
  if (reasons.length > 0) return { verdict: 'block', reasons }

  // Level-specific warnings
  for (const pattern of WARN_BY_LEVEL[safetyLevel]) {
    if (pattern.test(command)) {
      reasons.push(`Warning at ${safetyLevel}: ${pattern.source}`)
    }
  }
  if (reasons.length > 0) return { verdict: 'warn', reasons }

  return { verdict: 'pass', reasons: [] }
}

// ─── ValidatorProvider ────────────────────────────────────────────────────────
//
// Thin fetch wrapper targeting mistral:7b on the local Ollama daemon.
// No npm client — raw fetch() is more auditable (spec §2).

class ValidatorProvider {
  async isAvailable(config: AppConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return false
      const data  = await res.json() as { models?: { name: string }[] }
      return !!data.models?.some(m => m.name.startsWith(config.validatorModel))
    } catch {
      return false
    }
  }

  async generate(prompt: string, config: AppConfig): Promise<string> {
    const res = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  config.validatorModel,
        prompt,
        stream: false,
        format: 'json',
      }),
    })

    if (!res.ok) {
      throw new Error(`Validator returned HTTP ${res.status}`)
    }

    const data = await res.json() as { response: string }
    return data.response
  }
}

// ─── Semantic check ───────────────────────────────────────────────────────────
//
// Sends command + intent (if available) to mistral:7b framed as a pessimistic
// security auditor. Returns 'warn' if the model says the command is incoherent
// with the intent, or on any failure (fail-open — spec §12).
//
// Prompt design:
//   - Frames the model as a suspicious auditor
//   - Asks a binary coherence question (not "is this safe?")
//   - No session history — isolated judgement only
//   - JSON-only response: {"coherent": bool, "reason": "..."}

async function semanticCheck(
  command:   string,
  nlQuery:   string | undefined,
  config:    AppConfig,
): Promise<{ verdict: 'pass' | 'warn'; reason: string }> {
  const provider = new ValidatorProvider()

  // If validator is unreachable, fail open with warn
  if (!(await provider.isAvailable(config))) {
    return { verdict: 'warn', reason: 'Validator unavailable — could not confirm intent match' }
  }

  // Build the pessimist prompt (spec §12)
  const intentLine = nlQuery
    ? `User intent: ${nlQuery}`
    : 'User intent: (not provided — evaluate the command in isolation)'

  const prompt = [
    'You are a suspicious security auditor for a terminal emulator.',
    'Assume the proposed command might be a trick. Look for why it could be dangerous.',
    'Does this command plausibly fulfill the stated user intent?',
    'Return ONLY JSON: {"coherent": true|false, "reason": "<one sentence>"}',
    '',
    intentLine,
    `Proposed command: ${command}`,
  ].join('\n')

  try {
    const raw     = await provider.generate(prompt, config)
    const cleaned = raw.replace(/```(?:json)?/g, '').trim()
    const parsed  = JSON.parse(cleaned) as Record<string, unknown>

    if (parsed.coherent === false) {
      const reason = typeof parsed.reason === 'string'
        ? parsed.reason
        : 'Semantic check failed: command does not match stated intent'
      return { verdict: 'warn', reason }
    }

    return { verdict: 'pass', reason: '' }

  } catch {
    // Any parse or network failure → fail open
    return { verdict: 'warn', reason: 'Validator error — proceeding with caution' }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
//
// validateCommand() is the public entry point.
//
// Flow:
//   1. Static analysis (synchronous — always runs)
//   2. If static result is 'block', return immediately — no model needed
//   3. If static result is 'pass', run semantic check against mistral:7b
//   4. If static result is 'warn', also run semantic check to confirm severity
//   5. Final verdict: worst of (static verdict, semantic verdict)
//
// nlQuery: the user's original natural language request, if available.
//   Bash-direct commands may not have one; pass undefined in that case.
//   The validator prompt handles the missing-intent case gracefully.

export async function validateCommand(
  command:   string,
  nlQuery:   string | undefined,
  config:    AppConfig,
): Promise<ValidationResult> {
  const { verdict: staticVerdict, reasons } = staticAnalysis(command, config.safetyLevel)

  // Hard block — no point querying the model
  if (staticVerdict === 'block') {
    return {
      approved:   false,
      confidence: 'block',
      reasons,
    }
  }

  // Static pass or warn — run semantic check to confirm
  const semantic = await semanticCheck(command, nlQuery, config)

  // Combine: worst-of-two verdict wins
  const finalVerdict = (staticVerdict === 'warn' || semantic.verdict === 'warn')
    ? 'warn'
    : 'pass'

  const allReasons = [
    ...reasons,
    ...(semantic.reason ? [semantic.reason] : []),
  ]

  return {
    approved:   true,   // warn is still approved — block path returned early above
    confidence: finalVerdict,
    reasons:    allReasons,
  }
}

// Re-export for unit testing static analysis in isolation
export { staticAnalysis }
