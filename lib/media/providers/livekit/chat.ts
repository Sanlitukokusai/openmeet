/**
 * 会议内文字聊天的**纯逻辑层**（2026-08-07 FR-4）。
 *
 * 与 mapping.ts 同样的纪律：这里不引 livekit-client 运行时（连 `import type` 都不引，
 * 本文件只依赖抽象层的 `ChatMessage`），不碰 window/document，可以在 vitest 的 node
 * 环境直接单测（tests/media/chat.test.ts）。provider 侧只负责「从 SDK 拿到原始消息 →
 * 交给这里做规范化 → emit」。
 *
 * 为什么收到的消息要当 `unknown` 校验：
 *   聊天走的是可靠 DataChannel，包体由**对端浏览器**构造。SDK 只保证 protobuf 能解开，
 *   不保证字段有意义——空正文、缺 id、时间戳为 0、正文 10 MB 都是对端一改代码就能发出来的。
 *   UI 拿到就直接渲染，所以边界必须卡在进入 store 之前。
 */
import { MAX_CHAT_TEXT_LENGTH, type ChatMessage } from '../../types';

/** 发送前校验的结果。UI 侧应在调用 provider 之前就用同一个函数拦一次（不让用户白等一次 RTT）。 */
export type OutgoingChatText =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_long' };

/**
 * 发送端文本规范化：
 * - 先 trim（含全角空格 —— `String.prototype.trim` 覆盖 U+3000）；
 * - 空串拒绝（`empty`）：Enter 连按不该往会议里灌空气泡；
 * - 超过 500 字拒绝（`too_long`）：这里**不截断**——发送方应当明确知道自己的话被截了，
 *   静默截断比报错更糟。
 */
export function normalizeOutgoingChatText(raw: string): OutgoingChatText {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CHAT_TEXT_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, text };
}

/** 收到消息时可确定的发送者信息（provider 从 RemoteParticipant 上取）。 */
export interface ChatSender {
  identity: string;
  name?: string;
}

/** 原始消息缺字段时用的兜底值（由 provider 在调用点生成，保持本函数是纯函数）。 */
export interface ChatMessageFallback {
  id: string;
  timestamp: number;
}

function readString(target: Record<string, unknown>, key: string): string | undefined {
  const value = target[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 远端原始消息体（`unknown`）→ 抽象层 `ChatMessage`；无法救的消息返回 `null`（静默丢弃）。
 *
 * 容错规则：
 * - 非对象 / 正文非字符串 / 正文 trim 后为空 → `null`（丢弃，不打断整条消息流）；
 * - 发送者 identity 为空 → `null`（无法归属的消息不显示，避免出现「幽灵发言人」）；
 * - 正文超长 → **截断**到 500 字（与发送端的"拒绝"不同：对端可能是别的版本/别的实现，
 *   把它的话整条吞掉，用户只会觉得"消息丢了"；截断至少能看到内容，UI 也不会被撑爆）；
 * - id / timestamp 缺失或不合法 → 用调用方给的兜底值。
 */
export function toChatMessage(
  raw: unknown,
  sender: ChatSender,
  fallback: ChatMessageFallback,
): ChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const rawText = readString(record, 'message');
  if (rawText === undefined) return null;
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;

  const senderIdentity = sender.identity.trim();
  if (senderIdentity.length === 0) return null;

  const rawId = readString(record, 'id')?.trim();
  const rawTimestamp = record.timestamp;
  const timestamp =
    typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? rawTimestamp
      : fallback.timestamp;

  const name = sender.name?.trim();

  return {
    id: rawId && rawId.length > 0 ? rawId : fallback.id,
    senderIdentity,
    senderName: name && name.length > 0 ? name : senderIdentity,
    text: trimmed.length > MAX_CHAT_TEXT_LENGTH ? trimmed.slice(0, MAX_CHAT_TEXT_LENGTH) : trimmed,
    timestamp,
  };
}
