/**
 * A daemon WebSocket üzeneteinek (`state`, `tick`) protokollverziója. A daemon minden üzenetbe
 * beírja, a renderer minden más értéket eldob.
 *
 * Ma a daemon és a renderer egy Electron csomagban szállnak, tehát mindig egyeznek. A verzió azért
 * kell, hogy egy üzenetalak-változás ne csendben, mezőnként essen szét, ha a daemont egyszer külön
 * processzbe emelnék (spec §4: a modulhatár megvan hozzá). Ha az üzenet alakja összeférhetetlenül
 * változik, ezt kell növelni.
 */
export const DAEMON_PROTOCOL = 1
