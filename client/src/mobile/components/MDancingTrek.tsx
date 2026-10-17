export type TrekScene =
  | 'idle'
  | 'chat'
  | 'transport'
  | 'bookings'
  | 'guide'
  | 'packing'
  | 'files'
  | 'notes'
  | 'links'
  | 'polls'
  | 'journey'
  | 'collections'
  | 'dashboard'
  | 'atlas'
  | 'notifications'
  | 'costs'
  | 'search'
  | 'tasks'

export type TrekMood = 'default' | 'happy' | 'sad' | 'sleepy' | 'confused' | 'error'

/** A route illustration for loading and empty states. */
export default function MDancingTrek({size=96,scene='idle',mood='default',className=''}:{size?:number;scene?:TrekScene;mood?:TrekMood;className?:string}) {
  return <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-hidden="true" className={className} data-scene={scene} data-mood={mood}>
    <circle cx="48" cy="48" r="40" fill="currentColor" opacity=".06"/>
    <path d="M25 68C25 34 71 58 71 26" stroke="currentColor" strokeWidth="7" strokeLinecap="round"/>
    <circle cx="25" cy="68" r="7" fill="currentColor"/><circle cx="71" cy="26" r="7" fill="currentColor"/>
    <circle cx="48" cy="48" r="4" fill="currentColor" opacity=".35"/>
  </svg>
}
