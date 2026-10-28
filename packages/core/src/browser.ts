/**
 * A core IO-mentes része — a renderer (böngészős környezet) ezt importálja.
 *
 * A fő `index.ts` Node-modulokat is behúz (fs, child_process), amit a renderer csomagja nem
 * tud lefordítani. Ide csak olyan modul kerülhet, ami semmilyen `node:` modult nem importál.
 */
export * from './decision.js'
export * from './decision-response.js'
export * from './guards.js'
export * from './hook-contract.js'
export * from './rule-text.js'
export * from './subagent.js'
export * from './tool-detail.js'
export * from './tool-names.js'
