// レイアウト分岐切替の去抖（2026-08-14 第 2 波・回転で映像が真っ黒になる件の対策その 2）。
//
// 端末回転の最中、`(max-width:767px) and (min-height:450px)` は短時間に何度も反転しうる。
// その都度 VideoGrid の分岐を確定させると映像タイルの再レンダーが連打されるので、
// 「delayMs のあいだ落ち着いていた値」だけを採用する。
//
// タイマーは注入できるようにしてあるので、node 環境の vitest から時間を完全に支配できる。
import { describe, expect, it } from 'vitest'
import { createLayoutFlipDebouncer, LAYOUT_FLIP_DEBOUNCE_MS } from '@/components/room/layout-flip'

/** 手動で進められる偽タイマー。ハンドルは連番、cancel は登録抹消。 */
function fakeTimers() {
  const pending = new Map<number, () => void>()
  let seq = 0
  return {
    schedule: (fn: () => void) => {
      seq += 1
      pending.set(seq, fn)
      return seq
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number)
    },
    /** 保留中のコールバックを全部発火する（＝delayMs 経過を表す）。 */
    flush() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const cb of callbacks) cb()
    },
    get size() {
      return pending.size
    },
  }
}

function setup(initial: boolean) {
  const timers = fakeTimers()
  const commits: boolean[] = []
  const debouncer = createLayoutFlipDebouncer({
    initial,
    commit: (value) => commits.push(value),
    schedule: timers.schedule,
    clear: timers.clear,
  })
  return { timers, commits, debouncer }
}

describe('createLayoutFlipDebouncer', () => {
  it('初期値は即座に確定していて、commit は呼ばれない（呼び出し側が既に知っている）', () => {
    const { commits, debouncer } = setup(true)
    expect(debouncer.current()).toBe(true)
    expect(commits).toEqual([])
  })

  it('値が変わっても、delayMs 経過するまで確定しない', () => {
    const { timers, commits, debouncer } = setup(false)
    debouncer.request(true)
    expect(commits).toEqual([])
    expect(debouncer.current()).toBe(false)
    timers.flush()
    expect(commits).toEqual([true])
    expect(debouncer.current()).toBe(true)
  })

  it('★ 回転の揺れ（false→true→false）は 1 回も確定させない', () => {
    const { timers, commits, debouncer } = setup(false)
    debouncer.request(true) // 回転しはじめ
    debouncer.request(false) // 途中で元の向きに戻った
    expect(timers.size).toBe(0) // 保留は破棄されている
    timers.flush()
    expect(commits).toEqual([])
    expect(debouncer.current()).toBe(false)
  })

  it('★ 連続反転（5 往復）でも、最後に落ち着いた値だけが 1 回確定する', () => {
    const { timers, commits, debouncer } = setup(false)
    for (let i = 0; i < 5; i += 1) {
      debouncer.request(true)
      debouncer.request(false)
    }
    debouncer.request(true) // ここで落ち着いた
    timers.flush()
    expect(commits).toEqual([true])
  })

  it('確定前に同じ向きの要求が重なってもタイマーは引き直さない（永久に確定しない事故の防止）', () => {
    const { timers, commits, debouncer } = setup(false)
    debouncer.request(true)
    const firstHandleCount = timers.size
    debouncer.request(true)
    expect(timers.size).toBe(firstHandleCount) // 張り直していない
    timers.flush()
    expect(commits).toEqual([true])
  })

  it('確定後に元へ戻す要求は、改めて delayMs 待ってから確定する', () => {
    const { timers, commits, debouncer } = setup(false)
    debouncer.request(true)
    timers.flush()
    debouncer.request(false)
    expect(commits).toEqual([true])
    timers.flush()
    expect(commits).toEqual([true, false])
    expect(debouncer.current()).toBe(false)
  })

  it('cancel 後は確定しない（アンマウント後に setState が走らない）', () => {
    const { timers, commits, debouncer } = setup(false)
    debouncer.request(true)
    debouncer.cancel()
    timers.flush()
    expect(commits).toEqual([])
  })

  it('cancel は保留が無くても安全（冪等）', () => {
    const { debouncer } = setup(true)
    expect(() => {
      debouncer.cancel()
      debouncer.cancel()
    }).not.toThrow()
  })

  it('既定の待ち時間は 150ms（回転アニメーション中のクエリ反転を吸収できる最小値）', () => {
    expect(LAYOUT_FLIP_DEBOUNCE_MS).toBe(150)
  })

  it('delayMs は schedule にそのまま渡る', () => {
    const delays: number[] = []
    const debouncer = createLayoutFlipDebouncer({
      initial: false,
      delayMs: 42,
      commit: () => {},
      schedule: (_fn, ms) => {
        delays.push(ms)
        return 1
      },
      clear: () => {},
    })
    debouncer.request(true)
    expect(delays).toEqual([42])
  })
})
