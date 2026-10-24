/** Runs workspace-mutating operations one after another. */

let tail: Promise<unknown> = Promise.resolve()

export const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const result = tail.then(task, task)
  tail = result.catch(() => undefined)
  return result
}
