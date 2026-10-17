import type { SVGProps } from 'react'

/** Roam's route mark; the component name is retained for existing internal imports. */
export default function TrekIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 48 48" aria-hidden {...props}><path d="M11 35C11 18 37 30 37 13" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><circle cx="11" cy="35" r="5" fill="currentColor"/><circle cx="37" cy="13" r="5" fill="currentColor"/></svg>
}
