/**
 * The IO-free part of core: the renderer (a browser environment) imports this entry point.
 *
 * The main `index.ts` also pulls in Node modules (fs, child_process), which the renderer bundle
 * cannot compile. Only a module that imports no `node:` module may be exported here.
 */
export * from './decision.js'
export * from './decision-response.js'
export * from './guards.js'
export * from './hook-contract.js'
export * from './protocol.js'
export * from './rule-text.js'
export * from './subagent.js'
export * from './tool-detail.js'
export * from './tool-names.js'
