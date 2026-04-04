import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { sanitizeForContext } from './ContextSanitizer.ts'
import type { Block, BlockId, SuggestedCommand } from '../types/index.ts'

const BLOCK_CAP = 200

interface BlockStore {
  blocks:        Block[]
  activeBlockId: BlockId | null
  suggestion:    SuggestedCommand | null
  cwdHistory:    string[]
  currentCwd:    string
  instanceId:    string  // UUID — isolates multi-window context (spec §14)

  startBlock:       (command: string, source: 'nl' | 'direct', nlQuery?: string) => BlockId
  appendOutput:     (id: BlockId, chunk: string) => void
  finishBlock:      (id: BlockId, exitCode: number) => void
  setSuggestion:    (s: SuggestedCommand | null) => void
  updateCwd:        (path: string) => void
  getContextBlocks: () => Block[]
}

export const useBlockStore = create<BlockStore>((set, get) => ({
  blocks:        [],
  activeBlockId: null,
  suggestion:    null,
  cwdHistory:    [],
  currentCwd:    '',
  instanceId:    nanoid(),

  startBlock(command, source, nlQuery) {
    const id: BlockId = nanoid()
    const block: Block = {
      id,
      command,
      nlQuery,
      output:         '',
      exitCode:       null,
      startedAt:      Date.now(),
      finishedAt:     null,
      contextFlagged: false,
      flagReasons:    [],
      source,
    }

    set(state => {
      const blocks = state.blocks.length >= BLOCK_CAP
        // Drop oldest when at cap (spec §14)
        ? [...state.blocks.slice(1), block]
        : [...state.blocks, block]
      return { blocks, activeBlockId: id }
    })

    return id
  },

  appendOutput(id, chunk) {
    // Sanitizer runs on every chunk — flags injection patterns.
    // Visible output in TerminalBlock is always the unsanitized original (spec §14).
    const { text, flagged, reasons } = sanitizeForContext(chunk)

    // text (sanitized) is not stored — used only to derive flagging status.
    // The model never sees b.output directly (spec §14).
    void text

    set(state => ({
      blocks: state.blocks.map(b => {
        if (b.id !== id) return b
        return {
          ...b,
          output:         b.output + chunk,  // raw — shown to user
          contextFlagged: b.contextFlagged || flagged,
          flagReasons:    flagged
            ? [...b.flagReasons, ...reasons]
            : b.flagReasons,
        }
      }),
    }))
  },

  finishBlock(id, exitCode) {
    set(state => ({
      blocks: state.blocks.map(b =>
        b.id === id
          ? { ...b, exitCode, finishedAt: Date.now() }
          : b
      ),
      activeBlockId: state.activeBlockId === id ? null : state.activeBlockId,
    }))
  },

  setSuggestion(s) {
    set({ suggestion: s })
  },

  updateCwd(path) {
    set(state => ({
      currentCwd: path,
      cwdHistory: state.cwdHistory.includes(path)
        ? state.cwdHistory
        : [...state.cwdHistory, path],
    }))
  },

  getContextBlocks() {
    // Finished, non-flagged blocks, oldest to newest (spec §14)
    return get().blocks.filter(
      b => b.finishedAt !== null && !b.contextFlagged
    )
  },
}))
