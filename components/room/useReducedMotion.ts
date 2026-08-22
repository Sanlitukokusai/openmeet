'use client'

import { useEffect, useState } from 'react'

/**
 * `prefers-reduced-motion: reduce` を尊重する（ui-ux-pro-max §7 reduced-motion）。
 * 発言中タイルの「呼吸」演出（animate-pulse）はこれが true のときは静止リングに落とす。
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])

  return reduced
}
