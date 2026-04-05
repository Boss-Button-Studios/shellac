// Phase 2 — Ollama integration tests
// Requires Ollama to be running. Uses qwen2.5-coder:1.5b as substitute for
// qwen2.5-coder:7b (required model not yet pulled — deferred to Phase 6 installer).
import { translate }                            from '../src/lib/AIBridge.ts'
import { OllamaUnavailableError }               from '../src/types/index.ts'
import type { AppConfig }                       from '../src/types/index.ts'

let pass = 0, fail = 0
function assert(label: string, cond: boolean) {
  if (cond) { console.log('  PASS:', label); pass++ }
  else       { console.error('  FAIL:', label); fail++ }
}

const baseConfig: AppConfig = {
  generatorModel:         'qwen2.5-coder:1.5b',
  validatorModel:         'mistral:7b',
  ollamaBaseUrl:          'http://localhost:11434',
  maxContextTokens:       4000,
  maxOutputCharsPerBlock: 2000,
  shell:                  '/bin/bash',
  theme:                  'system', fontSize: 14,
  sidebarOpen: true, sidebarWidth: 300,
  activeTab: 'explain', explainCommands: 'on',
  autoSwitchToExplain: true, safetyLevel: 'balanced',
}

async function run() {
  console.log('\n── Ollama integration (qwen2.5-coder:1.5b substitute) ──────────')

  // translate("list files") with model available
  try {
    console.log('  Testing translate("list files") ...')
    const result = await translate('list files', [], baseConfig)
    assert('translate: returns SuggestedCommand',  typeof result.command === 'string')
    assert('translate: command non-empty',          result.command.length > 0)
    assert('translate: source is "generator"',      result.source === 'generator')
    assert('translate: confidence is valid',        ['high','medium','low'].includes(result.confidence))
    console.log(`    → command: ${result.command}`)
  } catch (e) {
    console.error('  FAIL: translate threw unexpectedly:', (e as Error).message)
    fail += 4
  }

  // OllamaUnavailableError when model not present
  const badConfig = { ...baseConfig, generatorModel: 'no-such-model:999b' }
  try {
    await translate('list files', [], badConfig)
    console.error('  FAIL: should have thrown OllamaUnavailableError'); fail++
  } catch (e) {
    assert('OllamaUnavailableError when model missing', e instanceof OllamaUnavailableError)
  }

  // OllamaUnavailableError when Ollama completely unreachable
  const deadConfig = { ...baseConfig, ollamaBaseUrl: 'http://localhost:19999' }
  try {
    await translate('list files', [], deadConfig)
    console.error('  FAIL: should have thrown OllamaUnavailableError (unreachable)'); fail++
  } catch (e) {
    assert('OllamaUnavailableError when Ollama unreachable', e instanceof OllamaUnavailableError)
  }

  // Bash passthrough — no Ollama call, returns immediately
  const direct = await translate('ls -la', [], baseConfig)
  assert('bash passthrough source is "direct"',   direct.source === 'direct')
  assert('bash passthrough command unchanged',     direct.command === 'ls -la')

  console.log(`\n─────────────────────────────────────────────────────────────────`)
  console.log(`Results: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
