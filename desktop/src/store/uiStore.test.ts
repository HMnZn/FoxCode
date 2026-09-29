import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INSPECTOR_MIN_WIDTH,
  MAIN_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUi,
} from '@/store/uiStore'

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
}

describe('uiStore 三栏宽度', () => {
  beforeEach(() => {
    setWindowWidth(1500)
    useUi.setState({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH, inspectorWidth: null, inspectorOpen: true })
  })

  afterEach(() => {
    setWindowWidth(1500)
    useUi.setState({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH, inspectorWidth: null, inspectorOpen: true })
  })

  it('侧栏默认 320，左右拖到自己夹在上下限里', () => {
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
    useUi.getState().setSidebarWidth(9999)
    expect(useUi.getState().sidebarWidth).toBeLessThanOrEqual(460)
    useUi.getState().setSidebarWidth(10)
    expect(useUi.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('右栏拖到极限也会给中列留下 MAIN_MIN_WIDTH', () => {
    useUi.getState().setInspectorWidth(9999)
    const { inspectorWidth, sidebarWidth } = useUi.getState()
    expect(inspectorWidth).toBe(1500 - sidebarWidth - MAIN_MIN_WIDTH)
    useUi.getState().setInspectorWidth(10)
    expect(useUi.getState().inspectorWidth).toBe(INSPECTOR_MIN_WIDTH)
  })

  it('传 null 表示「跟着内容自动」，拖一下就固定下来', () => {
    expect(useUi.getState().inspectorWidth).toBe(null)
    useUi.getState().setInspectorWidth(600)
    expect(useUi.getState().inspectorWidth).toBe(600)
    useUi.getState().setInspectorWidth(null)
    expect(useUi.getState().inspectorWidth).toBe(null)
  })

  it('窗口变窄时重新夹一遍，中列不会被挤到零', () => {
    useUi.getState().setInspectorWidth(700)
    useUi.getState().setSidebarWidth(400)
    setWindowWidth(1100)
    useUi.getState().clampPaneWidths()
    const { sidebarWidth, inspectorWidth } = useUi.getState()
    expect(inspectorWidth).toBeLessThan(700)
    expect(sidebarWidth + (inspectorWidth ?? 0)).toBeLessThanOrEqual(1100 - MAIN_MIN_WIDTH)
  })

  it('窗口够宽时 clampPaneWidths 不动用户的选择', () => {
    useUi.getState().setInspectorWidth(640)
    useUi.getState().setSidebarWidth(300)
    useUi.getState().clampPaneWidths()
    expect(useUi.getState().inspectorWidth).toBe(640)
    expect(useUi.getState().sidebarWidth).toBe(300)
  })
})
