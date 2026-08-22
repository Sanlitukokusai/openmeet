// 2026-08-16 iOS Safari 実機フィードバック①②③の配線を構造的に固定するガード。
//
// vitest は node 環境（jsdom 無し）なので、レンダリングではなくソースを機械的に検査する
// （tests/room/video-attrs.test.ts / room-wiring-guards.test.ts と同じ割り切り）。
// ここで守るのは「直したはずの 3 点が、次の改修でうっかり元へ戻らない」こと：
//
//   ① 全画面要素の高さは **dvh**（100vh / inset-0 の暗黙高さに戻さない）
//      —— iOS Safari の浮動ツールバーは env(safe-area-inset-bottom) に**算入されない**ので、
//         vh 系だと下端のコントロールがツールバーの裏に隠れて物理的に押せなくなる。
//   ② 画中画のドラッグ追従は **ref 直駆**（pointermove で setState しない）
//      —— 毎フレーム再レンダーするとカクつく。left/top は静止座標専用、追従は transform。
//   ③ prejoin のプレビューは**本物の管線**（getUserMedia 直叩きに戻さない）
//      —— 背景効果を「入室後に反映」へ戻すと、削除した但し書きも復活してしまう。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/** コメントを落としてから走査する（既存の構造ガード群と同じ作法）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const roomExperience = stripComments(readSource('../../components/room/RoomExperience.tsx'))
const chatPanel = stripComments(readSource('../../components/room/ChatPanel.tsx'))
const participantsPanel = stripComments(readSource('../../components/room/ParticipantsPanel.tsx'))
const localPreviewTile = stripComments(readSource('../../components/room/LocalPreviewTile.tsx'))
const prejoinView = stripComments(readSource('../../components/join/PrejoinView.tsx'))
const joinEntryView = stripComments(readSource('../../components/join/JoinEntryView.tsx'))
const devicePreviewVideo = stripComments(readSource('../../components/join/DevicePreviewVideo.tsx'))
const globalsCss = readSource('../../app/globals.css')

// ============================================================
// ① dvh 化（iOS Safari のツールバー対策）
// ============================================================

describe('① 全画面要素の高さは dvh（100vh / inset-0 の暗黙高さに戻さない）', () => {
  it('room のレイアウトルートは h-dvh', () => {
    const rootClass = roomExperience.match(/const rootClass = '([^']+)'/)?.[1]
    expect(rootClass, 'RoomExperience.tsx の rootClass が見つからない').toBeTruthy()
    expect(rootClass).toContain('h-dvh')
    expect(rootClass).not.toMatch(/\bh-screen\b/)
  })

  it.each([
    ['ChatPanel', chatPanel],
    ['ParticipantsPanel', participantsPanel],
  ])('%s のモバイル全画面ドロワーは fixed + h-dvh（inset-0 の暗黙高さを使わない）', (_name, source) => {
    const className = source.match(/className="(fixed[^"]*)"/)?.[1]
    expect(className, 'ドロワーの className が見つからない').toBeTruthy()
    expect(className).toContain('h-dvh')
    expect(className).toContain('inset-x-0')
    expect(className).toContain('top-0')
    // `inset-0` は上下左右 0＝高さがビューポート依存の暗黙値になる。これが①の元凶。
    expect(className).not.toMatch(/\binset-0\b/)
  })

  it.each([
    ['ChatPanel', chatPanel],
    ['ParticipantsPanel', participantsPanel],
  ])('%s はデスクトップで h-dvh を打ち消す（md:static のフレックス子要素がはみ出さない）', (_name, source) => {
    const className = source.match(/className="(fixed[^"]*)"/)?.[1]
    expect(className).toContain('md:static')
    expect(className).toContain('md:h-auto')
  })

  it('prejoin / join エントリーのページ容器は min-h-dvh（min-h-screen を残さない）', () => {
    for (const [name, source] of [
      ['PrejoinView', prejoinView],
      ['JoinEntryView', joinEntryView],
    ] as const) {
      expect(source, `${name} に min-h-dvh が無い`).toContain('min-h-dvh')
      expect(source, `${name} に min-h-screen が残っている`).not.toMatch(/\bmin-h-screen\b/)
    }
  })

  it('prejoin は下端のコントロールがツールバーより上までスクロールできる余白を持つ', () => {
    expect(prejoinView).toContain('pb-scroll-safe')
    // 高さを固定して中身を閉じ込めると、そもそもスクロールで逃がせない。
    expect(prejoinView).not.toMatch(/className="[^"]*\boverflow-hidden\b[^"]*min-h-dvh/)
    expect(prejoinView).not.toMatch(/min-h-dvh[^"]*\boverflow-hidden\b/)
  })

  it('pb-scroll-safe は「ツールバー相当の固定余白 + 安全区」で定義されている', () => {
    const rule = globalsCss.match(/\.pb-scroll-safe\s*\{[^}]*\}/)?.[0]
    expect(rule, 'app/globals.css に .pb-scroll-safe が無い').toBeTruthy()
    expect(rule).toContain('env(safe-area-inset-bottom')
    // 安全区だけでは足りない（ツールバーは安全区に算入されない）——固定ぶんが要る
    expect(rule).toMatch(/calc\(\s*\d/)
  })

  it('コントロールドックの下端オフセットは既存の bottom-dock-safe のまま（推測的な追加オフセットを入れない）', () => {
    const controlBar = stripComments(readSource('../../components/room/ControlBar.tsx'))
    expect(controlBar).toContain('bottom-dock-safe')
    expect(globalsCss).toMatch(/\.bottom-dock-safe\s*\{[^}]*env\(safe-area-inset-bottom/)
  })
})

// ============================================================
// ② 画中画：ref 直駆のドラッグ ＋ 縦向き（3:4）
// ============================================================

describe('② 画中画のドラッグ追従は ref 直駆（pointermove で再レンダーしない）', () => {
  const pointerMove = localPreviewTile.match(
    /function handlePointerMove\(event: PointerEvent<HTMLDivElement>\) \{[\s\S]*?\n  \}/,
  )?.[0]

  it('handlePointerMove が存在する', () => {
    expect(pointerMove, 'LocalPreviewTile.tsx に handlePointerMove が見つからない').toBeTruthy()
  })

  it('handlePointerMove は state セッターを呼ばない（1 フレーム 1 再レンダーの元凶）', () => {
    expect(pointerMove).not.toMatch(/\bset[A-Z]\w*\(/)
  })

  it('handlePointerMove は DOM の transform を直接書く', () => {
    expect(pointerMove).toMatch(/\.style\.transform\s*=/)
    expect(pointerMove).toContain('translate3d')
  })

  it('React が管理する style プロパティに transform / transition を入れない（手書き値が消される）', () => {
    const styleObject = localPreviewTile.match(/const mobilePositionStyle[\s\S]*?: undefined/)?.[0]
    expect(styleObject, 'mobilePositionStyle が見つからない').toBeTruthy()
    expect(styleObject).toContain('left:')
    expect(styleObject).toContain('top:')
    expect(styleObject).not.toMatch(/\btransform:/)
    expect(styleObject).not.toMatch(/\btransition:/)
  })

  it('ドラッグ中のコンテナは touch-action 無効 ＋ will-change: transform', () => {
    expect(localPreviewTile).toContain('touch-none')
    expect(localPreviewTile).toContain('will-change-transform')
  })

  it('松手時にだけ静止座標を state へ落とす（吸着先の保存も 1 回だけ）', () => {
    const endDrag = localPreviewTile.match(/function endDrag\(event: PointerEvent<HTMLDivElement>\) \{[\s\S]*?\n  \}/)?.[0]
    expect(endDrag).toBeTruthy()
    expect(endDrag).toMatch(/setRestPoint\(/)
    expect(endDrag).toMatch(/savePipCorner\(/)
  })

  it('リサイズ時の再計算はドラッグ中を避ける（iOS はツールバー開閉でも resize を投げる）', () => {
    const recompute = localPreviewTile.match(/function recompute\(\) \{[\s\S]*?\n    \}/)?.[0]
    expect(recompute).toBeTruthy()
    expect(recompute).toMatch(/dragRef\.current/)
  })
})

describe('② 自撮り窓はモバイルのみ縦向き 3:4（デスクトップは 16:9 のまま）', () => {
  it('画中画は pip-drag.ts の寸法クラス定数を使う（数値の事実源をひとつに保つ）', () => {
    expect(localPreviewTile).toContain('PIP_MOBILE_SIZE_CLASS')
    expect(localPreviewTile).toContain('PIP_DESKTOP_SIZE_CLASS')
    // 内側のボックスに aspect-video が残っていると外側の 3:4 と競合する
    expect(localPreviewTile).not.toMatch(/className="relative aspect-video/)
  })

  it('prejoin のプレビュー容器もモバイル 3:4 / デスクトップ 16:9', () => {
    expect(devicePreviewVideo).toContain('aspect-[3/4]')
    expect(devicePreviewVideo).toContain('md:aspect-video')
    expect(devicePreviewVideo).toContain('object-cover')
  })
})

// ============================================================
// ③ prejoin のリアルタイム背景プレビュー
// ============================================================

describe('③ prejoin は本物の処理管線でプレビューする', () => {
  it('素の getUserMedia 直叩きには戻らない（背景効果が乗らない経路）', () => {
    expect(prejoinView).not.toContain('navigator.mediaDevices')
  })

  it('lib/media は動的 import（livekit-client を prejoin の初期 chunk に入れない）', () => {
    expect(prejoinView).toMatch(/await import\(['"]@\/lib\/media['"]\)/)
    // 静的 import は禁止。types / devices（provider 非依存）は従来どおり静的でよい。
    expect(prejoinView).not.toMatch(/^import .*from '@\/lib\/media'$/m)
  })

  it('選択の永続化は setEffect 成功後だけ（失敗したら選択を進めない）', () => {
    const handler = prejoinView.match(
      /async function handleSelectBackground\(selection: BackgroundSelection\): Promise<boolean> \{[\s\S]*?\n  \}/,
    )?.[0]
    expect(handler, 'handleSelectBackground が見つからない').toBeTruthy()
    expect(handler).toMatch(/await session\.setEffect\(effect\)[\s\S]*commitBackgroundSelection\(selection\)/)
    expect(handler).toMatch(/return false/) // 失敗時は false＝ピッカー側で選択が巻き戻る
    expect(handler).toMatch(/addToast/) // 黙って失敗しない
  })

  it('カメラ OFF（セッション無し）でも選択は保存できる（旧来の「保存だけ」に落ちる）', () => {
    const handler = prejoinView.match(
      /async function handleSelectBackground\(selection: BackgroundSelection\): Promise<boolean> \{[\s\S]*?\n  \}/,
    )?.[0]
    expect(handler).toMatch(/if \(!session\) \{[\s\S]*commitBackgroundSelection\(selection\)[\s\S]*return true/)
  })

  it('プレビューは離脱時に必ず dispose する（カメラを握ったままにしない）', () => {
    expect(prejoinView).toMatch(/function disposePreviewSession\(\)/)
    // effect の cleanup と、入室遷移の直前の 2 か所から呼ぶ
    expect(prejoinView).toMatch(/cancelled = true\s*\n\s*disposePreviewSession\(\)/)
    expect(prejoinView).toMatch(/disposePreviewSession\(\)\s*\n\s*router\.push\(`\/room\//)
  })

  it('カメラ切替はセッション作り直しではなく setDeviceId を通す', () => {
    expect(prejoinView).toMatch(/session\s*\n?\s*\.setDeviceId\(selectedVideoId\)/)
  })

  it('モデル取得中は本物の loading を出す（無反応に見せない）', () => {
    expect(prejoinView).toMatch(/setPreviewPhase\('applying'\)/)
    expect(devicePreviewVideo).toContain('isBusy')
    expect(devicePreviewVideo).toContain('Spinner')
  })

  it('「入室後に反映されます」の但し書きは残っていない（事実と食い違うため削除済み）', () => {
    // コメントは落として**実際の文案だけ**を見る（削除の経緯を書いた注記まで禁止したいわけではない）。
    const uiText = stripComments(readSource('../../lib/ui-text.ts'))
    expect(uiText).not.toContain('入室後に反映')
    expect(uiText).not.toContain('入会后生效')
    expect(prejoinView).not.toContain('takesEffectAfterJoinNote')
  })
})
