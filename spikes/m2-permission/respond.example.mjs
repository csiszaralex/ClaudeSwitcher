// M2 spike, 2. kör — a `custom` mód válasza. Kérésenként frissen töltődik be.
//
// K1  AskUserQuestion  → allow + updatedInput.answers (az Agent SDK formátuma: kulcs a kérdés
//                         szövege, érték az opció label-je). Mindig az ELSŐ opciót választja.
// K2/K3 ExitPlanMode   → az ELSŐ tervet elutasítja visszajelzéssel (K3), a MÁSODIKAT
//                         jóváhagyja (K2). Számláló a plan-count.txt-ben.
// K4  Bash             → allow + egy ÁTÍRT szabály (nem a Claude Code javaslata), projekt-szinten.
// K5  Bash, gépszint   → csak ha USER_LEVEL = true. A globális ~/.claude/settings.json-be ír!
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const USER_LEVEL = false

// Terv-jóváhagyás kerülőútjai (K2b/K2c). Az első körben a sima `allow`-t a Claude Code
// figyelmen kívül hagyta, és a jóváhagyó ablak megmaradt.
//   'setMode' — PermissionRequest: allow + setMode default a sessionre
//   'pretool' — PreToolUse: permissionDecision allow (a jóváhagyó ablak ELŐTT fut)
const PLAN_STRATEGY = 'pretool'

export function preToolUse(body) {
  if (PLAN_STRATEGY !== 'pretool' || body.tool_name !== 'ExitPlanMode') return undefined
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Approved from ClaudeSwitcher (spike K2c).',
    },
  }
}

const PLAN_COUNTER = 'P:/08_Apps/cs-spike/plan-count.txt'

const allow = (extra = {}) => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', ...extra } },
})

export default function respond(body) {
  const { tool_name: tool, tool_input: input } = body

  if (tool === 'AskUserQuestion') {
    const answers = {}
    for (const q of input.questions ?? []) answers[q.question] = q.options?.[0]?.label
    return allow({ updatedInput: { ...input, answers } })
  }

  if (tool === 'ExitPlanMode' && PLAN_STRATEGY === 'setMode') {
    return allow({ updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
  }
  if (tool === 'ExitPlanMode' && PLAN_STRATEGY === 'pretool') return undefined

  if (tool === 'ExitPlanMode') {
    const seen = existsSync(PLAN_COUNTER) ? Number(readFileSync(PLAN_COUNTER, 'utf8')) : 0
    writeFileSync(PLAN_COUNTER, String(seen + 1))
    if (seen === 0) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'A ClaudeSwitcher elutasította a tervet. Visszajelzés: a fájl neve legyen spike-k3.txt, a tartalma pedig "terv-visszajelzés".',
          },
        },
      }
    }
    return allow()
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const destination = USER_LEVEL ? 'userSettings' : 'localSettings'
    const ruleContent = USER_LEVEL ? 'echo cs-spike-userlevel-probe *' : 'echo edited-by-claudeswitcher *'
    return allow({
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: tool, ruleContent }], behavior: 'allow', destination },
      ],
    })
  }

  // Minden más: nincs döntés, a natív prompt marad.
  return undefined
}


