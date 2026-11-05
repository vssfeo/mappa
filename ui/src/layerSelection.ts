/** Range selection shared by the layer list. */
export function rangeSelection(
  order: string[],
  anchor: string | null,
  target: string,
): string[] {
  const targetIndex = order.indexOf(target)
  if (targetIndex < 0) return [target]
  const anchorIndex = anchor ? order.indexOf(anchor) : -1
  if (anchorIndex < 0) return [target]
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return order.slice(start, end + 1)
}
