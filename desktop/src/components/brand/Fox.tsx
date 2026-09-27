import { useId } from 'react'
import { cn } from '@/lib/cn'

/* ------------------------------------------------------------------ *
 * 灵狐 — the FoxCode brand mark.
 *
 * One head geometry is shared by everything: the small mark (title bar,
 * sidebar, empty states) and the sitting mascot on the welcome screen.
 * `brand` paints it with the fox palette; `outline` is a single-colour
 * stroke that works as a watermark or on top of a coloured surface.
 * ------------------------------------------------------------------ */

const FOX_HI = 'var(--color-fox-hi)'
const FOX = 'var(--color-fox)'
const FOX_LO = 'var(--color-fox-lo)'
const CREAM = 'var(--color-fox-cream)'
const DARK = 'var(--color-fox-dark)'

export type FoxTone = 'brand' | 'outline'
export type FoxEyes = 'dot' | 'happy'

interface HeadProps {
  tone: FoxTone
  fillId: string
  eyes: FoxEyes
  /** Eye glints and the mouth only survive above ~22px. */
  detailed: boolean
}

function Head({ tone, fillId, eyes, detailed }: HeadProps) {
  const outline = tone === 'outline'
  const fur = outline ? 'none' : `url(#${fillId})`
  const ink = outline ? 'currentColor' : DARK
  const cream = outline ? 'none' : CREAM

  return (
    <g transform="translate(0 1.5)">
      {/* ears */}
      <g
        fill={fur}
        stroke={outline ? 'currentColor' : fur}
        strokeWidth={outline ? 1.7 : 2.2}
        strokeLinejoin="round"
      >
        <path d="M7.5 13.6 4.8 5 14.9 8.7Z" />
        <path d="M24.5 13.6 27.2 5 18.1 8.7Z" />
      </g>
      {outline ? null : (
        <g fill={CREAM} opacity={0.72}>
          <path d="M9.4 12.3 7.7 7.3 13.2 9.6Z" />
          <path d="M22.6 12.3 24.3 7.3 18.8 9.6Z" />
        </g>
      )}

      {/* cheek fur */}
      <g
        fill={fur}
        stroke={outline ? 'currentColor' : fur}
        strokeWidth={outline ? 1.7 : 1.8}
        strokeLinejoin="round"
      >
        <path d="M7.3 20.2 3.5 17.8 7.7 15.1Z" />
        <path d="M24.7 20.2 28.5 17.8 24.3 15.1Z" />
      </g>

      {/* skull */}
      <path
        d="M16 25.6c-6 0-10-3.9-10-9.4 0-4.5 4.5-7.9 10-7.9s10 3.4 10 7.9c0 5.5-4 9.4-10 9.4Z"
        fill={fur}
        stroke={outline ? 'currentColor' : undefined}
        strokeWidth={outline ? 1.7 : undefined}
        strokeLinejoin="round"
      />

      {/* muzzle */}
      <path
        d="M16 25.5c-2.6 0-4.4-1.5-4.4-3.4 0-1.3 1.4-2.2 4.4-2.2s4.4.9 4.4 2.2c0 1.9-1.8 3.4-4.4 3.4Z"
        fill={cream}
        stroke={outline ? 'currentColor' : undefined}
        strokeWidth={outline ? 1.5 : undefined}
        strokeLinejoin="round"
      />

      {/* eyes */}
      {eyes === 'happy' ? (
        <g fill="none" stroke={ink} strokeWidth={1.15} strokeLinecap="round">
          <path d="M10.9 16.4q1.3-1.6 2.6 0" />
          <path d="M18.5 16.4q1.3-1.6 2.6 0" />
        </g>
      ) : (
        <>
          <ellipse cx={12.2} cy={15.6} rx={1.4} ry={1.65} fill={ink} />
          <ellipse cx={19.8} cy={15.6} rx={1.4} ry={1.65} fill={ink} />
          {detailed ? (
            <g fill={CREAM} opacity={0.85}>
              <circle cx={12.75} cy={14.9} r={0.5} />
              <circle cx={20.35} cy={14.9} r={0.5} />
            </g>
          ) : null}
        </>
      )}

      {/* nose + mouth */}
      <path
        d="M16 19.9c.3 0 .58.13.77.36l.44.55c.34.43.03 1.09-.52 1.09h-1.38c-.55 0-.86-.66-.52-1.09l.44-.55c.19-.23.47-.36.77-.36Z"
        fill={ink}
      />
      {detailed ? (
        <g fill="none" stroke={ink} strokeWidth={0.9} strokeLinecap="round">
          <path d="M16 21.95v.55" />
          <path d="M16 22.5q-0.95.8-1.9.02" />
          <path d="M16 22.5q0.95.8 1.9.02" />
        </g>
      ) : null}
    </g>
  )
}

function FurGradient({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="6" y1="3" x2="26" y2="27" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stopColor={FOX_HI} />
      <stop offset="55%" stopColor={FOX} />
      <stop offset="100%" stopColor={FOX_LO} />
    </linearGradient>
  )
}

export interface FoxMarkProps {
  size?: number
  tone?: FoxTone
  eyes?: FoxEyes
  className?: string
  /** Provide only when the mark stands alone; otherwise it is decorative. */
  label?: string
}

export function FoxMark({
  size = 20,
  tone = 'brand',
  eyes = 'dot',
  className,
  label,
}: FoxMarkProps) {
  const fillId = `fox-fur-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={cn('shrink-0 overflow-visible', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <FurGradient id={fillId} />
      </defs>
      <Head tone={tone} fillId={fillId} eyes={eyes} detailed={size >= 22} />
    </svg>
  )
}

export interface FoxMascotProps {
  size?: number
  className?: string
  label?: string
}

/** Sitting fox: the welcome screen and empty states. */
export function FoxMascot({ size = 112, className, label }: FoxMascotProps) {
  const seed = useId().replace(/[^a-zA-Z0-9]/g, '')
  const furId = `fox-fur-${seed}`
  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <FurGradient id={furId} />
      </defs>
      <g transform="translate(-2 1)">
        <ellipse cx={48} cy={87.5} rx={25} ry={4} fill={DARK} opacity={0.11} />

        {/* tail — behind the body, cream tip */}
        <path
          d="M60 79c10.5 1.4 17.5-4.6 16.6-12.8-.6-5.8-4.6-9.4-9.6-9.2"
          fill="none"
          stroke={`url(#${furId})`}
          strokeWidth={10.5}
          strokeLinecap="round"
        />
        <circle cx={67} cy={57} r={4.4} fill={CREAM} />

        {/* body */}
        <path
          d="M48 85c-10.6 0-18.4-6.2-18.4-15 0-8.2 6-14.4 14.6-16.3h7.6c8.6 1.9 14.6 8.1 14.6 16.3C66.4 78.8 58.6 85 48 85Z"
          fill={`url(#${furId})`}
        />
        <ellipse cx={48} cy={72.5} rx={9} ry={10} fill={CREAM} opacity={0.85} />

        {/* paws */}
        <ellipse cx={40.6} cy={83.4} rx={6.4} ry={3.8} fill={CREAM} />
        <ellipse cx={55.4} cy={83.4} rx={6.4} ry={3.8} fill={CREAM} />
        <path
          d="M48 80.8v5.6"
          stroke={FOX_LO}
          strokeWidth={1.1}
          strokeLinecap="round"
          opacity={0.45}
        />

        <g transform="translate(11.2 0.2) scale(2.3)">
          <Head tone="brand" fillId={furId} eyes="happy" detailed />
        </g>
      </g>
    </svg>
  )
}
