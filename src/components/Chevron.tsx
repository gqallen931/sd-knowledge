/**
 * 展开 / 收起标识图（Deskforge A-UI 的 chevron）。
 *
 * 与参照稿 `task-dashboard.html` 的 `.wb-nav__chevron / .wb-ws__chevron / .wb-group__chevron`
 * 同一份图形：24×24 线性 chevron，`currentColor` 描边，收起时整体 rotate(-90deg)。
 */
export default function Chevron({ open = true, className = '' }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={`chevron${open ? '' : ' is-closed'}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
