/** Pure ordering helpers for the drag-and-drop layer list. */

/** Moves `draggedId` before or after `targetId` in a top-first id list. */
export function moveLayerId(
  idsTopFirst: string[],
  draggedId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (draggedId === targetId) return idsTopFirst
  const next = [...idsTopFirst]
  const from = next.indexOf(draggedId)
  if (from < 0) return idsTopFirst
  next.splice(from, 1)
  let to = next.indexOf(targetId)
  if (to < 0) return idsTopFirst
  if (after) to += 1
  next.splice(to, 0, draggedId)
  return next
}
