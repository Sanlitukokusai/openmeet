/**
 * HeroUI の `Avatar` はデフォルトで `name` をそのまま表示する（内部の既定
 * `getInitials` は先頭文字抽出ではなく `safeText` = 文字列をそのまま返すだけ）。
 * カメラオフの参加者タイルは丸いアバターにフルネームを渡すと、長い名前や
 * 日本語・中国語の名前（スペースなし）で文字が縦に折り返されて潰れる
 * （実機ブラウザ確認で発見）。ここで簡易的にイニシャルへ丸める。
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return ''

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    const first = [...words[0]][0] ?? ''
    const second = [...words[1]][0] ?? ''
    return (first + second).toUpperCase()
  }

  // 単語が 1 つ：漢字・かな・ハングル等は 1 文字で十分視認できるため 1 文字に丸める。
  return ([...trimmed][0] ?? '').toUpperCase()
}
