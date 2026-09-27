import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { applyTheme, useUi } from '@/store/uiStore'
import '@/styles/globals.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root container is missing from index.html')

// Theme lives on <html> so CSS variables switch without a React re-render.
applyTheme(useUi.getState().theme)
useUi.subscribe((state, previous) => {
  if (state.theme !== previous.theme) applyTheme(state.theme)
})

// Focus rings are keyboard-only (DSH tracks the same thing as input modality).
const noteModality = (mode: 'pointer' | 'keyboard') => {
  document.documentElement.dataset.inputModality = mode
}
document.addEventListener('pointerdown', () => noteModality('pointer'), true)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' || event.metaKey || event.ctrlKey || event.altKey) noteModality('keyboard')
}, true)
noteModality('pointer')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
