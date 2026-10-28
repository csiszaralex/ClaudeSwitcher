/**
 * A renderer CSS-ét a Vite mellékhatásként importálja (`import './styles.css'`). A
 * `noUncheckedSideEffectImports` mellett a típusellenőrző ezt csak akkor fogadja el, ha a
 * modulnak van deklarációja. Értéket nem exportál: a stílus a betöltéssel érvényesül.
 */
declare module '*.css'
