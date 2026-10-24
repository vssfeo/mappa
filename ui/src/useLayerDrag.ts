/** Pointer-based layer reordering for the Layers panel. */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { moveLayerId } from './layerOrder.ts'

interface DropTarget {
  id: string
  after: boolean
}

interface LayerDrag {
  dragId: string | null
  dropTarget: DropTarget | null
  start: (event: ReactPointerEvent<HTMLElement>, id: string) => void
}

/**
 * `idsTopFirst` is the visual order from top to bottom. The callback receives
 * the new visual order after a successful drop.
 */
export function useLayerDrag(
  idsTopFirst: string[],
  onReorder: (idsTopFirst: string[]) => void,
): LayerDrag {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragRef = useRef<{
    id: string
    startY: number
    active: boolean
  } | null>(null)
  const targetRef = useRef<DropTarget | null>(null)

  const start = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { id, startY: event.clientY, active: false }
    targetRef.current = null

    const move = (native: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.id !== id) return
      if (!drag.active) {
        if (Math.abs(native.clientY - drag.startY) < 4) return
        drag.active = true
        setDragId(id)
        document.body.classList.add('is-layer-dragging')
      }
      const element = document
        .elementFromPoint(native.clientX, native.clientY)
        ?.closest<HTMLElement>('[data-layer-id]')
      const targetId = element?.dataset.layerId
      if (!element || !targetId || targetId === id) {
        targetRef.current = null
        setDropTarget(null)
        return
      }
      const rect = element.getBoundingClientRect()
      const target = {
        id: targetId,
        after: native.clientY > rect.top + rect.height / 2,
      }
      targetRef.current = target
      setDropTarget(target)
    }

    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      const drag = dragRef.current
      const target = targetRef.current
      dragRef.current = null
      targetRef.current = null
      document.body.classList.remove('is-layer-dragging')
      setDragId(null)
      setDropTarget(null)
      if (!drag?.active || !target) return

      const next = moveLayerId(
        idsTopFirst,
        drag.id,
        target.id,
        target.after,
      )
      if (next.join('\n') !== idsTopFirst.join('\n')) onReorder(next)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  return { dragId, dropTarget, start }
}
