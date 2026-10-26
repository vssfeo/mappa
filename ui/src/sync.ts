/** Client for `mappa serve` project sync. */

export interface SyncEnvelope {
  name: string
  savedAt: string
  updatedAt: number
  version: number
  project: Record<string, unknown>
}

export interface SyncConflict {
  conflict: SyncEnvelope
}

const base = (url: string): string => url.trim().replace(/\/+$/, '')

const endpoint = (url: string, name: string, token: string): string => {
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${base(url)}/api/sync/${encodeURIComponent(name)}${suffix}`
}

const parseError = async (response: Response): Promise<string> => {
  try {
    const data = (await response.json()) as { error?: string }
    return data.error ?? `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

/** Sends the project; a 409 returns the newer server copy. */
export async function pushProject(
  url: string,
  token: string,
  name: string,
  project: Record<string, unknown>,
  force = false,
): Promise<SyncEnvelope | SyncConflict> {
  const baseTarget = endpoint(url, name, token)
  const target = force ? `${baseTarget}${baseTarget.includes('?') ? '&' : '?'}force=1` : baseTarget
  const response = await fetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project),
  })
  if (response.status === 409) {
    return { conflict: (await response.json()) as SyncEnvelope }
  }
  if (!response.ok) {
    throw new Error(await parseError(response))
  }
  return (await response.json()) as SyncEnvelope
}

/** Fetches the stored project, or null when it does not exist. */
export async function pullProject(
  url: string,
  token: string,
  name: string,
): Promise<SyncEnvelope | null> {
  const response = await fetch(endpoint(url, name, token))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await parseError(response))
  return (await response.json()) as SyncEnvelope
}

export interface SyncSummary {
  name: string
  savedAt: string
  updatedAt: number
  version: number
}

/** Lists project summaries on the server. */
export async function listProjects(
  url: string,
  token: string,
): Promise<SyncSummary[]> {
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ''
  const response = await fetch(`${base(url)}/api/sync${suffix}`)
  if (!response.ok) throw new Error(await parseError(response))
  const data = (await response.json()) as { projects?: SyncSummary[] }
  return data.projects ?? []
}

/** Exposed for tests. */
export const syncEndpoint = endpoint
