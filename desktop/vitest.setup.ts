/**
 * jsdom gaps that the FoxCode renderer relies on.
 *
 * Everything here is a browser API jsdom does not implement but which the UI
 * touches during render (viewport queries, virtualised-list measurement,
 * scroll pinning, clipboard writes).
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// `globals: false` means Testing Library cannot register its own auto-cleanup:
// without this, every `render()` leaves its tree mounted and the next test sees
// two of everything.
afterEach(() => {
  cleanup()
})

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof window.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = ResizeObserverStub as unknown as typeof window.ResizeObserver
}

// The settings rail uses a scroll-spy observer; jsdom has no implementation, and
// the page guards on its absence, but the stub keeps the effect covered too.
if (typeof window.IntersectionObserver !== 'function') {
  class IntersectionObserverStub {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: ReadonlyArray<number> = []
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  window.IntersectionObserver = IntersectionObserverStub as unknown as typeof window.IntersectionObserver
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}

if (typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function scrollTo(): void {}
}

if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () => Promise.resolve(),
      readText: () => Promise.resolve(''),
    },
  })
}
