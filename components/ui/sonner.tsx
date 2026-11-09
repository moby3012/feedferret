'use client'

import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { Toaster as Sonner, ToasterProps } from 'sonner'

/**
 * Sonner pauses a toast's timer while it is "expanded", which it derives from
 * mouseenter/mousemove on the toaster — and only leaves that state on
 * mouseleave. After a TAP the browser synthesises exactly those mouse events
 * (also when the toast appears under a lingering "pointer"), but never a
 * mouseleave, so on touch devices the Undo toast stayed forever. Swallow
 * mouse-hover events inside the toaster when they come from touch: either the
 * primary input cannot hover at all, or the last pointer interaction was a
 * touch a moment ago.
 */
const TOUCH_COMPAT_MOUSE_WINDOW_MS = 1500
const HOVER_EVENTS = ['mouseover', 'mouseout', 'mousemove'] as const

function useIgnoreTouchCompatibilityHover() {
  useEffect(() => {
    let lastTouchAt = -Infinity
    const markTouch = (event: PointerEvent) => {
      if (event.pointerType === 'touch') lastTouchAt = Date.now()
      else lastTouchAt = -Infinity
    }
    const swallow = (event: Event) => {
      // React derives mouseenter/leave from mouseout/over *pairs*, so a move
      // from outside into the toaster must be caught on either end.
      const inToaster = (node: EventTarget | null) =>
        node instanceof Element && node.closest('[data-sonner-toaster]') !== null
      if (!inToaster(event.target) && !inToaster((event as MouseEvent).relatedTarget)) return
      const touchOnlyDevice = window.matchMedia('(hover: none)').matches
      if (touchOnlyDevice || Date.now() - lastTouchAt < TOUCH_COMPAT_MOUSE_WINDOW_MS) {
        event.stopPropagation()
      }
    }
    window.addEventListener('pointerdown', markTouch, true)
    window.addEventListener('pointerup', markTouch, true)
    // `window` capture runs before React's own listeners (which sit on the document).
    HOVER_EVENTS.forEach((type) => window.addEventListener(type, swallow, true))
    return () => {
      window.removeEventListener('pointerdown', markTouch, true)
      window.removeEventListener('pointerup', markTouch, true)
      HOVER_EVENTS.forEach((type) => window.removeEventListener(type, swallow, true))
    }
  }, [])
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  useIgnoreTouchCompatibilityHover()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
