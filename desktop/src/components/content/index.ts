/**
 * Content renderers for the conversation layer.
 *
 * `DiffView.tsx` lives in this folder but is owned by another author; it is
 * re-exported here only for convenience and resolves through its default
 * export, so this barrel stays type-safe whichever way that module is
 * reworked.
 */
export { CodeBlock, InlineCode, TOKEN_CLASS } from './CodeBlock'
export type { CodeBlockProps } from './CodeBlock'

export { Markdown, StreamingMarkdown } from './Markdown'
export type { MarkdownProps } from './Markdown'

export { NoticePart, TextPart, ThinkingPart } from './ContentParts'
export type {
  NoticePartProps,
  NoticeTone,
  TextPartProps,
  ThinkingPartProps,
} from './ContentParts'

export { default as DiffView } from './DiffView'
