import type Database from 'better-sqlite3'

// Node 24's SQLite and Electron's native module open the same on-disk database.
export function openDatabase(file: string): Database.Database {
  try {
    const Native = require('better-sqlite3')
    return new Native(file)
  } catch (nativeError) {
    let DatabaseSync: any
    try { DatabaseSync = require('node:sqlite').DatabaseSync } catch { throw nativeError }
    const raw = new DatabaseSync(file)
    return {
      prepare: (sql: string) => raw.prepare(sql),
      exec: (sql: string) => raw.exec(sql),
      pragma: (sql: string) => raw.exec(`PRAGMA ${sql}`),
      close: () => raw.close(),
      transaction: (fn: Function) => (...args: any[]) => {
        raw.exec('BEGIN IMMEDIATE')
        try { const result = fn(...args); raw.exec('COMMIT'); return result }
        catch (error) { raw.exec('ROLLBACK'); throw error }
      },
    } as unknown as Database.Database
  }
}
