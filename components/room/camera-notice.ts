/**
 * 「カメラが自分の意思と無関係にオフになった／復旧した」の UI 側判定（2026-08-14）。
 *
 * ============ 背景 ============
 * provider（lib/media/providers/livekit/camera-health.ts）は、ブラウザに殺された
 * カメラトラックを検知して**黙って**取り直す。UI から見えるのは
 * `localStateChanged` の `videoEnabled` が false → true と動くことだけで、
 * それは「ユーザーがボタンを二回押した」のと**イベントとしては見分けが付かない**。
 * 遠隔ミュートを見分けるために meeting-store が micIntent を持っているのと同じ問題なので、
 * 同じ解き方をする：**呼ぶ直前に意図を置き、届いた変化がそれと一致すればローカル由来**。
 *
 * ⚠️ なぜ store ではなくここに置くか
 *   micIntent は「トーストを出すか」という判断が store の責務（setLocalState の戻り値）に
 *   なっているが、カメラ側は判断がもう一段複雑（後述の猶予タイマー）で、しかも
 *   `lib/media/types.ts` は凍結——`LocalState` に「復旧しました」を載せる場所が無い。
 *   そこで store の契約は一切変えず、純関数だけをここに置いて RoomExperience が
 *   ref で意図を持つ形にした（store の既存テストを壊さない、という実利もある）。
 *
 * ============ 猶予タイマーという設計 ============
 * 自己修復は「オフ → （再取得）→ オン」という**二段**で観測される。オフの瞬間に
 * 「カメラが停止しました」と出すと、直後に復旧したときトーストが二枚重なって騒がしい。
 * かといってオフを黙殺すると、復旧に失敗した経路が**無言の黒画面**になる——これは
 * 今回のタスクで最も避けたい状態（鉄則：どの経路の黒画面も無言にしない）。
 *
 * だから：**オフを見たら猶予タイマーを張り、期限内にオンが来たら「復旧しました」、
 * 来なければ「停止しました＋カメラボタンから再開してください」**。
 * どちらに転んでも必ず何か言う、が担保される。
 */

/**
 * カメラ操作の意図の有効期限。マイクの 3 秒（MIC_INTENT_TTL_MS）より長いのは、
 * カメラのオンが `getUserMedia` → エンコーダ初期化 → publish と重く、
 * 端末によっては数秒かかるため（短すぎると自分の操作を「勝手にオフになった」と誤検知する）。
 */
export const CAMERA_INTENT_TTL_MS = 10_000;

/**
 * 入室時の `initialVideo` 用の長い有効期限。connect() の完了待ちがネットワーク次第で
 * 伸びる事情は INITIAL_MIC_INTENT_TTL_MS と同じ。
 */
export const INITIAL_CAMERA_INTENT_TTL_MS = 60_000;

/**
 * 「オフを観測してから、復旧を待つ」猶予。provider 側は
 * `setCameraEnabled(false)` → `setCameraEnabled(true)` を続けて撃つが、
 * 間に `getUserMedia` が挟まるので実測で数秒かかることがある。
 * 短すぎると復旧しているのに「停止しました」と出る（＝嘘）ので、余裕を取る。
 */
export const CAMERA_RECOVERY_GRACE_MS = 8_000;

export interface CameraIntent {
  /** ユーザーが要求した状態（true＝オンにしようとした） */
  enabled: boolean;
  /** この時刻（epoch ms）までに届いた一致する変化はローカル由来とみなす */
  expiresAt: number;
}

export interface CameraChangeEvent {
  /** `local`＝自分の操作 / `auto`＝自分は何もしていないのに変わった */
  source: 'local' | 'auto';
  /** 変化後のカメラ状態 */
  videoEnabled: boolean;
}

/**
 * カメラ状態の変化の由来を判定する（純関数）。変化が無ければ null。
 *
 * micIntent と同じく「一致すればローカル」に倒す＝**誤検知しない側**に倒す。
 * 取りこぼし（本当は自動復旧なのに黙る）は実害が小さいが、
 * 自分で切ったのに「カメラが停止しました」と出るのは明確なバグ。
 */
export function classifyCameraChange(
  prevEnabled: boolean,
  nextEnabled: boolean,
  intent: CameraIntent | null,
  nowMs: number,
): CameraChangeEvent | null {
  if (prevEnabled === nextEnabled) return null;
  const matchesIntent = intent !== null && intent.enabled === nextEnabled && nowMs <= intent.expiresAt;
  return { source: matchesIntent ? 'local' : 'auto', videoEnabled: nextEnabled };
}

/**
 * 猶予タイマーに対して何をするか。
 *  - `idle`      : 何もしない
 *  - `armStopped`: 猶予タイマーを（張り直して）セットする。期限切れ＝「停止しました」
 *  - `recovered` : 猶予中に戻ってきた → タイマー解除 ＋「復旧しました」
 *  - `cancel`    : タイマー解除のみ（ユーザーが自分で操作した＝以後は本人の管理下）
 */
export type CameraNoticePlan = 'idle' | 'armStopped' | 'recovered' | 'cancel';

/**
 * @param change  classifyCameraChange の結果
 * @param pending 猶予タイマーが張られている最中か
 */
export function planCameraNotice(change: CameraChangeEvent | null, pending: boolean): CameraNoticePlan {
  if (!change) return 'idle';
  // 自分で操作したなら、それ以降の面倒は本人が見る。張りっぱなしのタイマーだけ畳む。
  if (change.source === 'local') return pending ? 'cancel' : 'idle';
  if (!change.videoEnabled) return 'armStopped';
  // 勝手にオンになった：猶予中なら復旧、そうでなければ（説明の付かないオン）黙って受け入れる
  return pending ? 'recovered' : 'idle';
}
