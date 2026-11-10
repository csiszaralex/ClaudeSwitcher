// Permission spike, round two: the response of the `custom` mode. Loaded fresh for every request.
//
// K1  AskUserQuestion  → allow + updatedInput.answers (the Agent SDK format: the key is the question
//                         text, the value the option's label). Always picks the FIRST option.
// K2/K3 ExitPlanMode   → denies the FIRST plan with feedback (K3), approves the SECOND (K2).
//                         The counter is in plan-count.txt.
// K4  Bash             → allow + a REWRITTEN rule (not Claude Code's suggestion), at project level.
// K5  Bash, user level → only when USER_LEVEL = true. Writes to the global ~/.claude/settings.json!
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const USER_LEVEL = false

// Workarounds for approving a plan (K2b/K2c). In the first round Claude Code ignored a plain
// `allow`, and the approval dialog stayed.
//   'setMode': PermissionRequest: allow + setMode default for the session
//   'pretool': PreToolUse: permissionDecision allow (runs BEFORE the approval dialog)
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
            message: 'ClaudeSwitcher denied the plan. Feedback: name the file spike-k3.txt, and make its content "terv-visszajelzés".',
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

  // Anything else: no decision, the native prompt stays.
  return undefined
}
