/**
 * FoxCode Studio UI primitives — the hand-rolled shadcn-style base layer.
 *
 * Every module here is dependency-light on purpose: `react`, `clsx`/`tailwind-merge`
 * (via `@/lib/cn`), `lucide-react` icons, and `zustand` (only in `Toaster`).
 * Components style themselves with the design-token utilities declared in
 * `src/styles/globals.css` and merge any `className` passed by the caller, so
 * screens compose them without reaching for overrides unless they need to.
 *
 * ```ts
 * import { Button, Dialog, Menu, useToasts } from '@/components/ui'
 * ```
 */

/* Button */
export { Button } from './Button'
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button'

/* IconButton */
export { IconButton } from './IconButton'
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton'

/* Chip */
export { Chip, StatusDot, chipIconSize } from './Chip'
export type { ChipProps, ChipSize, ChipTone, StatusDotProps, StatusDotTone } from './Chip'

/* Kbd */
export { Kbd, KbdCombo, detectPlatform } from './Kbd'
export type { KbdComboProps, KbdPlatform, KbdProps, KbdSize } from './Kbd'

/* Tooltip */
export { Tooltip } from './Tooltip'
export type { TooltipProps, TooltipSide } from './Tooltip'

/* SegmentedControl */
export { SegmentedControl } from './SegmentedControl'
export type { SegmentedControlProps, SegmentedOption, SegmentedSize } from './SegmentedControl'

/* Switch */
export { Switch } from './Switch'
export type { SwitchProps } from './Switch'

/* Field */
export { FieldLabel, TextArea, TextInput } from './Field'
export type { FieldLabelProps, FieldSize, TextAreaProps, TextInputProps } from './Field'

/* Select */
export { Select } from './Select'
export type { SelectOption, SelectProps, SelectSize } from './Select'

/* Dialog */
export { ConfirmDialog, Dialog } from './Dialog'
export type { ConfirmDialogProps, DialogProps, DialogSize } from './Dialog'

/* Menu */
export { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu'
export type { MenuAlign, MenuItemProps, MenuItemTone, MenuProps } from './Menu'

/* Tabs */
export { TabPanel, Tabs } from './Tabs'
export type { TabItem, TabPanelProps, TabSize, TabVariant, TabsProps } from './Tabs'

/* Spinner */
export { ShimmerBar, Spinner } from './Spinner'
export type { ShimmerBarProps, SpinnerProps, SpinnerSize, SpinnerTone } from './Spinner'

/* ProgressBar */
export { ProgressBar, TokenBar } from './ProgressBar'
export type { ProgressBarProps, ProgressSize, ProgressTone, TokenBarProps, TokenSegment } from './ProgressBar'

/* EmptyState */
export { EmptyState } from './EmptyState'
export type { EmptyStateProps } from './EmptyState'

/* Toaster */
export { MAX_VISIBLE, Toaster, toast, useToasts } from './Toaster'
export type { Toast, ToastAction, ToastInput, ToastStore, ToastTone, ToasterProps } from './Toaster'
