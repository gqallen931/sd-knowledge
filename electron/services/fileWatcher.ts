import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database'

export class FileWatcher {
  private interval: NodeJS.Timeout | null = null
  private checkIntervalMs = 30 * 60 * 1000

  constructor(private db: DatabaseService) {}

  start() {
    this.interval = setInterval(() => {
      this.checkReferences()
    }, this.checkIntervalMs)

    setTimeout(() => this.checkReferences(), 5000)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async checkReferences() {
    try {
      const refs = this.db.prepare(`
        SELECT id, file_name, original_path
        FROM documents
        WHERE storage_type = 'reference'
      `).all() as any[]

      for (const ref of refs) {
        if (!ref.original_path) continue
        const exists = fs.existsSync(ref.original_path)
        const wasAvailable = await this.db.prepare('SELECT is_available FROM documents WHERE id = ?').get(ref.id) as any

        this.db.prepare(`
          UPDATE documents SET is_available = ?, last_checked = CURRENT_TIMESTAMP WHERE id = ?
        `).run(exists ? 1 : 0, ref.id)

        if (wasAvailable?.is_available === 1 && !exists) {
          this.db.prepare(`
            INSERT INTO audit_logs (actor_type, actor_name, action, resource_type, resource_id, details, status)
            VALUES ('system', 'filewatcher', 'update', 'document', ?, ?, 'warning')
          `).run(String(ref.id), `Reference file unavailable: ${ref.file_name} at ${ref.original_path}`)
        }
      }
    } catch (e) {
      console.error('FileWatcher check error:', e)
    }
  }
}
