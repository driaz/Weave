import type { ReactNode } from 'react'

type BrandDropRailProps = {
  children: ReactNode
}

export function BrandDropRail({ children }: BrandDropRailProps) {
  return (
    <div
      className="flex flex-col items-center"
      style={{
        position: 'absolute',
        left: 12,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 44,
        background: 'var(--w-card)',
        borderRadius: 'var(--w-radius-pill)',
        boxShadow: 'var(--w-shadow-lift)',
        border: '1px solid var(--w-line)',
        padding: '10px 0',
        gap: 14,
        zIndex: 20,
      }}
    >
      {children}
    </div>
  )
}
