// ContextBudget — spec §10
//
// Key architectural decision (non-negotiable per spec):
//   fitBlocks() uses command + exitCode ONLY.
//   block.output (stdout) never enters the model context by default.
//
// This is a deliberate, default-on defense against indirect prompt injection
// via terminal output. A malicious program's stdout cannot poison the model
// unless the user explicitly clicks "Help me fix this" on that block, which
// opts a single block's output into context.

import type { Block, BlockId } from '../types/index.ts'
import { wrapForContext } from './ContextSanitizer.ts'

export class ContextBudget {
  constructor(private readonly ceiling: number) {}

  // Estimate token count at 4 characters per token — cheap, good enough.
  // Ollama models vary, but 1 token ≈ 4 chars is a safe over-estimate
  // that prevents us from blowing the actual context window.
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  // Build an ordered context window from blocks.
  //
  // Rules (spec §10):
  //   - Exclude contextFlagged blocks (injection risk detected by sanitizer)
  //   - Exclude active blocks (finishedAt === null — output is incomplete)
  //   - Include command + exitCode only for each block
  //   - Exception: if includeOutputForBlockId is set, include stdout for that
  //     one block (capped at 1000 chars). This is the "Help me fix this" path.
  //   - Trim oldest blocks first when over budget
  //   - Return oldest-to-newest order so the model reads history chronologically
  fitBlocks(blocks: Block[], includeOutputForBlockId?: BlockId): Block[] {
    let budget = this.ceiling
    const fitted: Block[] = []

    // Walk newest-to-oldest so we can drop from the oldest end when over budget
    for (const block of [...blocks].reverse()) {
      // Never include context-flagged blocks — injection pattern detected
      if (block.contextFlagged) continue

      // Never include an active (in-progress) block — output is incomplete
      if (block.finishedAt === null) continue

      let contextStr: string

      if (block.id === includeOutputForBlockId && block.output) {
        // "Help me fix this" path — include stdout for this one block only.
        // Output is capped at 1000 chars and was already validated by sanitizer.
        contextStr = [
          '<untrusted_history>',
          `[command]: ${block.command}`,
          `[exit_code]: ${block.exitCode}`,
          `[output]: ${block.output.slice(0, 1000)}`,
          '</untrusted_history>',
        ].join('\n')
      } else {
        // Normal path — command and exit code only (spec §10)
        contextStr = wrapForContext(block.command, block.exitCode ?? -1)
      }

      const cost = this.estimateTokens(contextStr)

      // Once we exceed the budget, stop — older blocks are cheaper to drop
      // than newer ones (newer = more relevant to current task)
      if (cost > budget) break

      budget -= cost
      // unshift preserves oldest-to-newest order in the result
      fitted.unshift(block)
    }

    return fitted
  }
}
