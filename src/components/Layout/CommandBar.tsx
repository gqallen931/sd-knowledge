import { useState, useEffect, useRef } from 'react'
import { SHORTCUTS, EXTRA_PAGES } from '../../shortcuts'

interface CommandBarProps {
  open: boolean
  onClose: () => void
  onNavigate: (path: string) => void
  onOpen?: () => void
}

/** 页面清单与数字键提示都从 shortcuts.ts 派生，键位与 App.tsx 的全局监听天然一致 */
const commands = [
  ...SHORTCUTS.map((s) => ({ label: s.label, type: '页面', icon: s.icon, path: s.path, hint: s.key })),
  ...EXTRA_PAGES.map((s) => ({ label: s.label, type: '页面', icon: s.icon, path: s.path, hint: '—' })),
]

export default function CommandBar({ open, onClose, onNavigate, onOpen }: CommandBarProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const filtered = query
    ? commands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      onNavigate(filtered[selectedIndex].path)
    }
  }

  if (!open) {
    return null
  }
  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0" style={{ background: 'rgba(0,0,0,0.3)', zIndex: 200, animation: 'fade-in 0.15s' }}
        onClick={onClose} />

      {/* Command Panel */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2"
        style={{
          width: '560px',
          zIndex: 201,
          animation: 'slide-up 0.2s ease-out',
        }}>
        {/* Input */}
        <div className="flex items-center gap-3 px-5"
          style={{
            height: '52px',
            borderRadius: '14px 14px 0 0',
            background: 'var(--glass)',
            backdropFilter: 'blur(20px)',
            border: '1px solid var(--card-border)',
            borderBottom: 'none',
          }}>
          <span style={{ color: 'var(--primary)', fontSize: '18px' }}>⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
            onKeyDown={handleKey}
            placeholder="输入页面名称，快速跳转..."
            className="flex-1 bg-transparent outline-none"
            style={{ color: 'var(--text)', fontSize: '15px' }}
          />
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>ESC 关闭</span>
        </div>

        {/* Results */}
        <div style={{
          maxHeight: '300px', overflowY: 'auto',
          borderRadius: '0 0 14px 14px',
          background: 'var(--glass)',
          backdropFilter: 'blur(20px)',
          border: '1px solid var(--card-border)',
          borderTop: 'none',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
              无匹配结果
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <div key={cmd.path}
                onClick={() => onNavigate(cmd.path)}
                className="flex items-center gap-3 cursor-pointer"
                style={{
                  padding: '10px 20px',
                  background: i === selectedIndex ? 'var(--primary-light)' : 'transparent',
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span style={{
                  width: '28px', height: '28px', borderRadius: '6px',
                  background: 'var(--card-bg-hover)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '12px', color: 'var(--primary)',
                }}>{cmd.icon}</span>
                <span style={{ fontSize: '13px', color: 'var(--text)' }}>{cmd.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-dim)' }}>{cmd.type}</span>
                <span style={{
                  padding: '2px 8px', borderRadius: '4px',
                  background: 'var(--card-bg)', fontSize: '11px', color: 'var(--text-dim)',
                }}>{cmd.hint}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
