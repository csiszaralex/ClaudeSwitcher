/**
 * Vite imports the renderer's CSS as a side effect (`import './styles.css'`). With
 * `noUncheckedSideEffectImports` the type checker accepts this only if the module has a
 * declaration. It exports no value: the style takes effect by being loaded.
 */
declare module '*.css'
