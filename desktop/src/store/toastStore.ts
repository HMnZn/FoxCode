/**
 * Toast facade.
 *
 * The primitives kit already owns a toast store (`@/components/ui/Toaster`), so
 * this module simply re-exports it. Importing from here keeps store modules free
 * of component-layer imports while guaranteeing a single store instance — the
 * one `<Toaster />` mounts.
 *
 * Field note: the primitive API uses `duration` (ms, `0` = sticky); the app
 * default is 4500ms.
 */
export { toast, useToasts } from '@/components/ui'
export type { Toast, ToastAction, ToastInput, ToastTone } from '@/components/ui'
