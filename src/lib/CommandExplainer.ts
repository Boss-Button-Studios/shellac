// CommandExplainer — spec §13
//
// Responsibilities:
//   - explainCommand(): pre-run. Called in parallel with validateCommand() after
//     translate() returns. Produces a human-readable breakdown of what the command
//     will do before the user confirms.
//   - explainResult(): post-run. Called when a block finishes. Summarises what
//     happened and suggests next steps. Optionally includes stdout (Help path only).
//
// Model: qwen2.5-coder:7b (generator model). Isolated prompts — no session history.
// Fail gracefully: on any error, return a conservative default rather than throwing.
//   - explainCommand default: confidence 'low', reversible false (safest assumption)
//   - explainResult default: non-empty summary, empty nextSteps
//
// Stdout policy:
//   - explainResult() takes includeOutput flag (spec §13 "Help path").
//   - stdout enters the prompt ONLY when the user explicitly clicked "Help me fix this".
//   - This is the only path in Shellac where stdout reaches a model context.

import type { CommandExplanation, CommandResult, AppConfig } from '../types/index.ts'

// ─── Provider ─────────────────────────────────────────────────────────────────
//
// Thin fetch wrapper targeting the generator model (qwen2.5-coder:7b).
// Same pattern as ValidatorProvider — raw fetch(), no npm client.

class ExplainerProvider {
  async isAvailable(config: AppConfig): Promise<boolean> {
    try {
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return false
      const data = await res.json() as { models?: { name: string }[] }
      return !!data.models?.some(m => m.name.startsWith(config.generatorModel))
    } catch {
      return false
    }
  }

  async generate(prompt: string, config: AppConfig): Promise<string> {
    const res = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  config.generatorModel,
        prompt,
        stream: false,
      }),
    })

    if (!res.ok) {
      throw new Error(`Explainer returned HTTP ${res.status}`)
    }

    const data = await res.json() as { response: string }
    return data.response
  }
}

// ─── Response parsers ─────────────────────────────────────────────────────────
//
// The model sometimes wraps JSON in fences even when asked not to.
// Strip fences, then parse. Return null on any failure — callers use defaults.

function stripFences(raw: string): string {
  return raw.replace(/```(?:json)?/g, '').trim()
}

function parseExplanationResponse(raw: string): CommandExplanation | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>

    return {
      summary:       typeof parsed.summary      === 'string'  ? parsed.summary      : '',
      effects:       Array.isArray(parsed.effects)
                       ? (parsed.effects as unknown[]).filter(e => typeof e === 'string') as string[]
                       : [],
      reversible:    typeof parsed.reversible   === 'boolean' ? parsed.reversible   : false,
      requiresSudo:  typeof parsed.requiresSudo === 'boolean' ? parsed.requiresSudo : false,
      confidence:    parsed.confidence === 'high' ? 'high' : 'low',
    }
  } catch {
    return null
  }
}

function parseResultResponse(raw: string): CommandResult | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>

    const nextSteps = Array.isArray(parsed.nextSteps)
      ? (parsed.nextSteps as unknown[])
          .filter(s => typeof s === 'string')
          .slice(0, 3) as string[]   // spec §13: max 3 items
      : []

    return {
      summary:     typeof parsed.summary     === 'string' ? parsed.summary     : '',
      exitMeaning: typeof parsed.exitMeaning === 'string' ? parsed.exitMeaning : '',
      nextSteps,
    }
  } catch {
    return null
  }
}

// ─── Default values ───────────────────────────────────────────────────────────
//
// Used when Ollama is unavailable or returns unparseable output.
// Conservative defaults: reversible false, confidence low (spec §13).

const EXPLAIN_DEFAULT: CommandExplanation = {
  summary:      'Unable to explain this command (Ollama unavailable).',
  effects:      [],
  reversible:   false,     // safest assumption — warn user
  requiresSudo: false,
  confidence:   'low',
}

function resultDefault(command: string, exitCode: number, error?: string): CommandResult {
  const succeeded = exitCode === 0
  return {
    summary:     error
                   ? `The command encountered an error: ${error.slice(0, 200)}`
                   : succeeded
                     ? `${command} completed successfully.`
                     : `${command} exited with code ${exitCode}.`,
    exitMeaning: succeeded ? 'Success' : `Non-zero exit (${exitCode})`,
    nextSteps:   [],
  }
}

// ─── explainCommand ───────────────────────────────────────────────────────────
//
// Pre-run explanation. Prompt asks for:
//   - summary: one plain-English sentence about what the command does
//   - effects: list of system effects (files created, network calls, etc.)
//   - reversible: whether the effects can be undone
//   - requiresSudo: whether elevated privileges are needed
//   - confidence: 'high' (common command) or 'low' (unusual or complex)
//
// No session history — isolated judgement only (spec §13).

export async function explainCommand(
  command: string,
  config:  AppConfig,
): Promise<CommandExplanation> {
  const provider = new ExplainerProvider()

  if (!(await provider.isAvailable(config))) {
    return EXPLAIN_DEFAULT
  }

  const prompt = [
    'You are a shell command documentation assistant.',
    'Explain the following shell command to a non-technical user.',
    'Return ONLY JSON with these fields:',
    '  summary: one plain-English sentence describing what the command does',
    '  effects: array of strings, each describing one concrete system effect',
    '  reversible: boolean — true only if ALL effects can be fully undone',
    '  requiresSudo: boolean — true if sudo or root privileges are needed',
    '  confidence: "high" if this is a standard command, "low" if complex or unusual',
    '',
    'Important: reversible must be false if any files are deleted, overwritten, or sent over a network.',
    '',
    `Command: ${command}`,
  ].join('\n')

  try {
    const raw    = await provider.generate(prompt, config)
    const result = parseExplanationResponse(raw)
    return result ?? EXPLAIN_DEFAULT
  } catch {
    return EXPLAIN_DEFAULT
  }
}

// ─── explainResult ────────────────────────────────────────────────────────────
//
// Post-run explanation. Called when a block finishes.
//
// Parameters:
//   command     — the shell command that ran
//   output      — the captured stdout/stderr (may be empty string)
//   exitCode    — the process exit code
//   config      — app config
//   includeOutput — true only when called from the "Help me fix this" button
//
// When includeOutput is true, the output is included in the prompt (capped at
// 2000 chars to stay within budget). This is the only model context path where
// stdout appears (spec §13).
//
// The prompt asks two questions simultaneously on failure:
//   1. What went wrong?
//   2. Did the user possibly mean something other than what they typed?
// This covers genuine shell errors AND mis-routed NL input.

export async function explainResult(
  command:       string,
  output:        string,
  exitCode:      number,
  config:        AppConfig,
  includeOutput: boolean = false,
): Promise<CommandResult> {
  const provider = new ExplainerProvider()

  if (!(await provider.isAvailable(config))) {
    return resultDefault(command, exitCode)
  }

  const succeeded = exitCode === 0

  // Only include output when the user explicitly requested Help
  const outputSection = (includeOutput && output)
    ? `\nCommand output (first 2000 chars):\n${output.slice(0, 2000)}`
    : ''

  // Failure prompt adds extra diagnostic questions (spec §13)
  const failureInstructions = succeeded ? '' : [
    '   - In nextSteps: first suggest what likely went wrong, then how to fix it.',
    '   - Consider: did the user possibly mean a different command than what they typed?',
    '     If so, include a corrected command suggestion in nextSteps.',
  ].join('\n')

  const prompt = [
    'You are a shell assistant explaining a completed command to a non-technical user.',
    'Return ONLY JSON with these fields:',
    '  summary: one plain-English sentence describing what happened',
    '  exitMeaning: one sentence explaining what the exit code means in this context',
    '  nextSteps: array of up to 3 strings — what the user should do next',
    failureInstructions,
    '',
    `Command: ${command}`,
    `Exit code: ${exitCode} (${succeeded ? 'success' : 'failure'})`,
    outputSection,
  ].filter(Boolean).join('\n')

  try {
    const raw    = await provider.generate(prompt, config)
    const result = parseResultResponse(raw)
    return result ?? resultDefault(command, exitCode)
  } catch {
    return resultDefault(command, exitCode)
  }
}
