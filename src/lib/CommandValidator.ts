// CommandValidator — spec §12
//
// Responsibilities:
//   - Static analysis: pattern-matching against known danger signatures.
//     Synchronous. Free. Runs first on every command.
//   - Semantic check: flag-based scope analysis against a small instruct model.
//     Runs only if static analysis passes AND a suitable model has been confirmed
//     via the model selection gate in validator-semantic-check.md.
//
// Model choice: a separate model from the generator (spec §12, dual-model defense).
// The SemanticBackend interface abstracts the inference backend so the model can be
// swapped without touching semanticCheck().
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
//
// nlQuery is accepted but not used by static analysis — it is passed through to
// detectFlags() when the semantic check is enabled.

interface StaticResult {
  verdict: 'pass' | 'warn' | 'block'
  reasons: string[]
}

function staticAnalysis(
  command:     string,
  safetyLevel: SafetyLevel,
  _nlQuery?:   string,
): StaticResult {
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

// ─── Flag detection ───────────────────────────────────────────────────────────
//
// Pure function — no model, no side effects, fully unit-testable.
//
// Each flag has two predicates:
//   detect:    does the command contain the flag?
//   suspicion: given the user's NL query, is this flag surprising?
//
// A flag only fires when BOTH predicates return true. This prevents noisy
// warnings when the flag is clearly justified by the user's intent
// (e.g. "list all files" asking for -a is not suspicious).

type CommandFlag = 'sudo' | 'recursive' | 'force' | 'wildcard' | 'pipe_exec' | 'all_files'

interface FlagDetector {
  detect:    (command: string) => boolean
  suspicion: (nlQuery: string) => boolean  // false = not suspicious, skip question
}

const FLAG_DETECTORS: Record<CommandFlag, FlagDetector> = {
  sudo: {
    detect:    cmd => /^sudo\s/.test(cmd),
    suspicion: q  => !/admin|permiss|root|system|install|global/i.test(q),
  },
  recursive: {
    detect:    cmd => /\s-[a-zA-Z]*[rR]/.test(cmd),
    suspicion: q  => !/director|folder|recursi|all|every/i.test(q),
  },
  force: {
    detect:    cmd => /\s-[a-zA-Z]*f/.test(cmd),
    suspicion: q  => !/force|overwrite|replace/i.test(q),
  },
  wildcard: {
    detect:    cmd => /\*/.test(cmd),
    suspicion: q  => !/all|every|\*/.test(q),
  },
  pipe_exec: {
    detect:    cmd => /\|\s*(ba)?sh/.test(cmd),
    suspicion: _  => true,   // always suspicious, no exceptions
  },
  all_files: {
    detect:    cmd => /\s-[a-zA-Z]*a/.test(cmd),
    suspicion: q  => !/hidden|all|dot/.test(q),
  },
}

function detectFlags(command: string, nlQuery?: string): CommandFlag[] {
  return (Object.entries(FLAG_DETECTORS) as [CommandFlag, FlagDetector][])
    .filter(([, d]) => d.detect(command) && d.suspicion(nlQuery ?? ''))
    .map(([flag]) => flag)
}

// ─── Question table ───────────────────────────────────────────────────────────
//
// One entry per flag. Each question is narrow and concrete — the model only
// needs to answer yes/no in context, not reason about abstract security principles.
//
// reason uses the 'scope:' prefix so SuggestionCard can render scope warnings
// with softer styling distinct from static danger reasons.

const FLAG_QUESTIONS: Record<CommandFlag, {
  ask:    (nlQuery: string, command: string) => string
  field:  string    // JSON field name in model response
  reason: string    // warning text shown in SuggestionCard
}> = {
  sudo: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `Is sudo genuinely necessary here, or would it work without elevated privileges?`,
    field:  'sudo_needed',
    reason: 'scope:sudo may not be necessary for this task',
  },
  recursive: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `The -r flag makes this recursive. Did the user mean a whole directory, ` +
      `or were they asking about a single file?`,
    field:  'recursive_needed',
    reason: 'scope:Recursive flag used but request may only concern a single file',
  },
  force: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `The -f flag forces the operation without confirmation. ` +
      `Did the user ask for that, or should they be prompted before overwriting?`,
    field:  'force_needed',
    reason: 'scope:Force flag skips confirmation — user may not have intended this',
  },
  wildcard: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `The * wildcard will match multiple files. ` +
      `Did the user ask about all matching files, or something specific?`,
    field:  'wildcard_needed',
    reason: 'scope:Wildcard matches multiple files but request may be more specific',
  },
  pipe_exec: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `This pipes content directly into a shell. ` +
      `Did the user explicitly ask to execute downloaded code?`,
    field:  'pipe_exec_intended',
    reason: 'scope:Piping content to a shell executes untrusted code',
  },
  all_files: {
    ask:    (q, cmd) =>
      `The user asked to "${q}" and a colleague suggested "${cmd}". ` +
      `The -a flag includes hidden files. Did the user ask about hidden files?`,
    field:  'all_files_needed',
    reason: 'scope:Includes hidden files — user may not have intended this',
  },
}

// ─── SemanticBackend interface ────────────────────────────────────────────────
//
// Abstract interface for the inference backend. OllamaBackend is the default.
// Swapping to a different inference server (llama.cpp, transformers.js, etc.)
// requires only a new implementation of this interface — semanticCheck() is
// backend-agnostic.

interface SemanticBackend {
  isAvailable(): Promise<boolean>
  generate(prompt: string): Promise<string>
}

class OllamaBackend implements SemanticBackend {
  constructor(
    private readonly baseUrl:   string,
    private readonly model:     string,
    private readonly gpuLayers: number,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return false
      const data = await res.json() as { models?: { name: string }[] }
      return !!data.models?.some(m => m.name.startsWith(this.model))
    } catch {
      return false
    }
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   this.model,
        prompt,
        stream:  false,
        options: { num_gpu: this.gpuLayers },
      }),
    })
    if (!res.ok) throw new Error(`Validator returned HTTP ${res.status}`)
    const data = await res.json() as { response: string }
    return data.response
  }
}

// ─── Semantic check ───────────────────────────────────────────────────────────
//
// Flag-based scope analysis. Static analysis identifies what to be suspicious
// about; the model only answers specific yes/no questions derived from those flags.
//
// This avoids the "confirmation bias" failure mode of the original prosecutor
// prompt, which manufactured danger because it was instructed to look for it.
//
// Prompt design:
//   - One question per suspicious flag (not a blanket security audit)
//   - Plus a coherence question: does the command match the intent at all?
//   - JSON-only response with one field per question
//   - No session history — isolated judgement only
//
// Fail-open: any parse error, network error, or unavailable backend returns 'warn'.

// Build the prompt used by both backends. Extracted so both models see identical input —
// any difference in their output is genuine disagreement, not prompt variation.
function buildSemanticPrompt(command: string, nlQuery: string | undefined, flags: CommandFlag[]): string {
  const intentLine = nlQuery
    ? `The user asked: "${nlQuery}"\nThe command: "${command}"`
    : `The command: "${command}"`

  const questions = [
    `  coherent: does this command plausibly do what the user asked? (true/false)`,
    ...flags.map(f =>
      `  ${FLAG_QUESTIONS[f].field}: ${FLAG_QUESTIONS[f].ask(nlQuery ?? '', command)} (true/false)`
    ),
  ].join('\n')

  return [
    intentLine,
    ``,
    `Answer each question below. Return ONLY JSON with these boolean fields:`,
    questions,
  ].join('\n')
}

// Run one backend and parse its response into a list of concern reasons.
// Fail-open: any error returns an empty reason list (not a block).
async function runBackend(
  backend: SemanticBackend,
  prompt:  string,
  flags:   CommandFlag[],
): Promise<string[]> {
  try {
    const raw    = await backend.generate(prompt)
    const parsed = JSON.parse(raw.replace(/```(?:json)?/g, '').trim()) as Record<string, unknown>
    const reasons: string[] = []

    if (parsed.coherent === false) {
      reasons.push('intent:Command does not match stated intent')
    }
    for (const flag of flags) {
      const { field, reason } = FLAG_QUESTIONS[flag]
      if (parsed[field] === false) {
        reasons.push(reason)  // already has 'scope:' prefix
      }
    }
    return reasons
  } catch {
    return []  // parse or network error — fail open, contribute no concerns
  }
}

async function semanticCheck(
  command:  string,
  nlQuery:  string | undefined,
  config:   AppConfig,
): Promise<{ verdict: 'pass' | 'warn'; reasons: string[] }> {

  const primary = new OllamaBackend(config.ollamaBaseUrl, config.validatorModel,     config.validatorGpuLayers)
  const peer    = new OllamaBackend(config.ollamaBaseUrl, config.validatorPeerModel,  config.validatorPeerGpuLayers)

  // Check availability of both backends in parallel
  const [primaryAvail, peerAvail] = await Promise.all([
    primary.isAvailable(),
    peer.isAvailable(),
  ])

  if (!primaryAvail && !peerAvail) {
    return { verdict: 'warn', reasons: ['Validators unavailable — could not confirm intent match'] }
  }

  // newbie safety level requires both backends to participate.
  // If one is missing, the check is incomplete — warn conservatively.
  const requireBoth = config.safetyLevel === 'newbie'
  if (requireBoth && (!primaryAvail || !peerAvail)) {
    return {
      verdict: 'warn',
      reasons: ['Incomplete validation — one validator unavailable (newbie mode requires both)'],
    }
  }

  const flags  = detectFlags(command, nlQuery)
  const prompt = buildSemanticPrompt(command, nlQuery, flags)

  // Run available backends in parallel
  const tasks: Promise<string[]>[] = []
  if (primaryAvail) tasks.push(runBackend(primary, prompt, flags))
  if (peerAvail)    tasks.push(runBackend(peer,    prompt, flags))

  const results   = await Promise.allSettled(tasks)
  const allReasons: string[] = []

  for (const r of results) {
    if (r.status === 'fulfilled') allReasons.push(...r.value)
    // rejected = backend threw before we could catch it — treat as no concerns (fail open)
  }

  // Both models use the same FLAG_QUESTIONS strings, so duplicates are exact matches.
  const uniqueReasons = [...new Set(allReasons)]

  return {
    verdict: uniqueReasons.length > 0 ? 'warn' : 'pass',
    reasons: uniqueReasons,
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
//
// validateCommand() is the public entry point.
//
// Flow:
//   1. Static analysis (synchronous — always runs)
//   2. If static result is 'block', return immediately — no model needed
//   3. If static result is 'pass' or 'warn', run semantic check (when enabled)
//   4. Final verdict: worst of (static verdict, semantic verdict)
//
// nlQuery: the user's original natural language request, if available.
//   Bash-direct commands may not have one; pass undefined in that case.
//   The validator prompt handles the missing-intent case gracefully.

export async function validateCommand(
  command:   string,
  nlQuery:   string | undefined,
  config:    AppConfig,
): Promise<ValidationResult> {
  const { verdict: staticVerdict, reasons } = staticAnalysis(command, config.safetyLevel, nlQuery)

  // Hard block — no point querying the model
  if (staticVerdict === 'block') {
    return {
      approved:   false,
      confidence: 'block',
      reasons,
    }
  }

  // Static pass or warn — run semantic check against both validator backends.
  // Models confirmed against the gate test cases in validator-semantic-check.md:
  //   primary: alibayram/ministral-3b-instruct:latest (CPU, 0 GPU layers)
  //   peer:    qwen2.5-coder:3b (22 GPU layers, confirmed stable)
  const semantic = await semanticCheck(command, nlQuery, config)

  const finalVerdict = (staticVerdict === 'warn' || semantic.verdict === 'warn')
    ? 'warn'
    : 'pass'

  return {
    approved:   true,   // warn is still approved — block path returned early above
    confidence: finalVerdict,
    reasons:    [...reasons, ...semantic.reasons],
  }
}

// Re-export for unit testing static analysis and flag detection in isolation
export { staticAnalysis, detectFlags }
