import type { LucideIcon } from 'lucide-react'

export interface Command {
  id: string
  label: string
  group: string
  hint?: string
  keywords?: string[]
  icon: LucideIcon
  action: () => void
}
