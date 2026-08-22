/**
 * WP-3：LiveKitProvider 纯逻辑层单测（规格书 §3.4）
 *
 * 只测 `lib/media/providers/livekit/mapping.ts` —— 它不引 livekit-client 运行时，
 * 因此可以在 vitest 的 node 环境直接跑（引了运行时会拉起 webrtc-adapter 并访问
 * 浏览器全局，node 下必炸）。本文件也**不 import `lib/supabase.ts`**（其 server-only 会抛错）。
 */
import { describe, expect, it } from 'vitest';

import {
  LK_DISCONNECT_REASON,
  LiveKitMediaError,
  classifyDisconnect,
  classifyError,
  collectStatsSnapshot,
  computeConnectionStats,
  disconnectReasonText,
  emptyConnectionStats,
  isServerInitiatedDisconnect,
  mapConnectionQuality,
  sortSpeakerIds,
  toRemoteParticipant,
  type ParticipantLike,
  type PublicationLike,
  type RtcStatLike,
  type StatsSnapshot,
} from '@/lib/media/providers/livekit/mapping';

// ------------------------------------------------------------
// 构造假对象的小工具（结构与 livekit-client 的 Participant / TrackPublication 一致）
// ------------------------------------------------------------
function pub(source: string, isMuted = false): PublicationLike {
  return { source, isMuted };
}

function participant(overrides: Partial<ParticipantLike> = {}): ParticipantLike {
  return {
    identity: 'guest_abc',
    name: 'Alice',
    isSpeaking: false,
    connectionQuality: 'good',
    trackPublications: new Map<string, PublicationLike>(),
    ...overrides,
  };
}

describe('mapConnectionQuality', () => {
  it('四档原样映射', () => {
    expect(mapConnectionQuality('excellent')).toBe('excellent');
    expect(mapConnectionQuality('good')).toBe('good');
    expect(mapConnectionQuality('poor')).toBe('poor');
    expect(mapConnectionQuality('lost')).toBe('lost');
  });

  it("livekit 的 'unknown'（尚无质量上报）归到中性的 good，避免 UI 一进会就误报故障", () => {
    expect(mapConnectionQuality('unknown')).toBe('good');
    expect(mapConnectionQuality(undefined)).toBe('good');
    expect(mapConnectionQuality('some-future-value')).toBe('good');
  });
});

describe('toRemoteParticipant', () => {
  it('从 publication 的存在性 + isMuted 推导 audio/videoEnabled', () => {
    const snapshot = toRemoteParticipant(
      participant({
        trackPublications: new Map([
          ['t1', pub('microphone', false)],
          ['t2', pub('camera', false)],
        ]),
      }),
    );
    expect(snapshot.audioEnabled).toBe(true);
    expect(snapshot.videoEnabled).toBe(true);
  });

  it('muted 的 publication 算作关闭', () => {
    const snapshot = toRemoteParticipant(
      participant({
        trackPublications: new Map([
          ['t1', pub('microphone', true)],
          ['t2', pub('camera', true)],
        ]),
      }),
    );
    expect(snapshot.audioEnabled).toBe(false);
    expect(snapshot.videoEnabled).toBe(false);
  });

  it('没有发布过对应 track 时算作关闭（纯旁听者）', () => {
    const snapshot = toRemoteParticipant(participant());
    expect(snapshot.audioEnabled).toBe(false);
    expect(snapshot.videoEnabled).toBe(false);
  });

  it('屏幕共享等其它 source 不影响摄像头/麦克风判定', () => {
    const snapshot = toRemoteParticipant(
      participant({
        trackPublications: new Map([['t1', pub('screen_share', false)]]),
      }),
    );
    expect(snapshot.videoEnabled).toBe(false);
    expect(snapshot.audioEnabled).toBe(false);
  });

  it('id 取 identity；name 缺失或为空时回退到 identity', () => {
    expect(toRemoteParticipant(participant({ identity: 'host_1' })).id).toBe('host_1');
    expect(toRemoteParticipant(participant({ name: undefined })).name).toBe('guest_abc');
    expect(toRemoteParticipant(participant({ name: '' })).name).toBe('guest_abc');
    expect(toRemoteParticipant(participant({ name: 'Bob' })).name).toBe('Bob');
  });

  it('透传 isSpeaking 与质量映射', () => {
    const snapshot = toRemoteParticipant(
      participant({ isSpeaking: true, connectionQuality: 'poor' }),
    );
    expect(snapshot.isSpeaking).toBe(true);
    expect(snapshot.quality).toBe('poor');
  });
});

describe('sortSpeakerIds', () => {
  it('按 audioLevel 降序', () => {
    expect(
      sortSpeakerIds([
        { identity: 'a', audioLevel: 0.2 },
        { identity: 'b', audioLevel: 0.9 },
        { identity: 'c', audioLevel: 0.5 },
      ]),
    ).toEqual(['b', 'c', 'a']);
  });

  it('缺 audioLevel 视为 0，且排序稳定（同音量保持原顺序）', () => {
    expect(
      sortSpeakerIds([
        { identity: 'a' },
        { identity: 'b', audioLevel: 0 },
        { identity: 'c', audioLevel: 0.1 },
      ]),
    ).toEqual(['c', 'a', 'b']);
  });

  it('空列表返回空数组，且不修改入参', () => {
    const input = [{ identity: 'a', audioLevel: 0.1 }];
    expect(sortSpeakerIds([])).toEqual([]);
    sortSpeakerIds(input);
    expect(input).toEqual([{ identity: 'a', audioLevel: 0.1 }]);
  });
});

describe('classifyError', () => {
  it('NotAllowedError → PERMISSION_DENIED', () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    expect(classifyError(err).code).toBe('PERMISSION_DENIED');
  });

  it('旧浏览器/LiveKit 的权限失败别名同样归入 PERMISSION_DENIED', () => {
    expect(classifyError({ name: 'PermissionDeniedError', message: '' }).code).toBe(
      'PERMISSION_DENIED',
    );
    expect(classifyError({ name: 'PermissionDenied', message: '' }).code).toBe('PERMISSION_DENIED');
    // 非安全上下文（§7.5 必须 HTTPS）
    expect(classifyError({ name: 'SecurityError', message: '' }).code).toBe('PERMISSION_DENIED');
  });

  it('NotFound / Overconstrained / NotReadable / DeviceInUse → DEVICE_NOT_FOUND', () => {
    for (const name of [
      'NotFoundError',
      'DevicesNotFoundError',
      'NotFound',
      'OverconstrainedError',
      'NotReadableError',
      'DeviceInUse',
      'DeviceUnsupportedError',
    ]) {
      expect(classifyError({ name, message: '' }).code, name).toBe('DEVICE_NOT_FOUND');
    }
  });

  it('没有 name 时按 message 兜底判定设备类错误', () => {
    expect(classifyError(new Error('Requested device not found')).code).toBe('DEVICE_NOT_FOUND');
    expect(classifyError(new Error('Permission denied by system')).code).toBe('PERMISSION_DENIED');
  });

  it('HTTP 401 / 403 → TOKEN_INVALID', () => {
    expect(classifyError({ name: 'ConnectionError', message: 'unauthorized', status: 401 }).code).toBe(
      'TOKEN_INVALID',
    );
    expect(classifyError({ name: 'ConnectionError', message: '', status: 403 }).code).toBe(
      'TOKEN_INVALID',
    );
  });

  it('服务端的 "permissions denied"（token 授权不足）不能被误判成摄像头权限被拒', () => {
    const err = { name: 'ConnectionError', message: 'permissions denied', status: 401 };
    expect(classifyError(err).code).toBe('TOKEN_INVALID');
  });

  it('message 提到 token / jwt → TOKEN_INVALID', () => {
    expect(classifyError(new Error('invalid token')).code).toBe('TOKEN_INVALID');
    expect(classifyError(new Error('jwt expired')).code).toBe('TOKEN_INVALID');
  });

  it('ConnectionError / 连接类文案 → CONNECT_FAILED', () => {
    expect(classifyError({ name: 'ConnectionError', message: 'server unreachable' }).code).toBe(
      'CONNECT_FAILED',
    );
    expect(classifyError(new Error('could not establish pc connection')).code).toBe(
      'CONNECT_FAILED',
    );
    expect(classifyError(new Error('websocket closed')).code).toBe('CONNECT_FAILED');
  });

  it('房间满员（服务端第二道防线，§12.8）→ ROOM_FULL', () => {
    expect(classifyError(new Error('room is full')).code).toBe('ROOM_FULL');
    expect(classifyError(new Error('exceeds room limit')).code).toBe('ROOM_FULL');
  });

  it('无法识别时用调用点给的 fallback，默认 UNKNOWN', () => {
    expect(classifyError(new Error('something odd')).code).toBe('UNKNOWN');
    expect(classifyError(new Error('something odd'), 'CONNECT_FAILED').code).toBe('CONNECT_FAILED');
    expect(classifyError(null).code).toBe('UNKNOWN');
    expect(classifyError(undefined, 'DEVICE_NOT_FOUND').code).toBe('DEVICE_NOT_FOUND');
  });

  it('保留原始 message 与 cause，message 为空时给默认文案', () => {
    const raw = new Error('boom');
    const mapped = classifyError(raw);
    expect(mapped.message).toBe('boom');
    expect(mapped.cause).toBe(raw);
    expect(classifyError({ name: 'NotFoundError', message: '' }).message).toBe(
      'camera/microphone not available',
    );
  });

  it('字符串异常也能分类', () => {
    expect(classifyError('invalid token').code).toBe('TOKEN_INVALID');
  });

  it('已分类过的 LiveKitMediaError 原样返回，不二次包装', () => {
    const original = new LiveKitMediaError('ROOM_FULL', 'room is full');
    expect(classifyError(original, 'CONNECT_FAILED')).toBe(original);
  });

  it('产出的既是 MediaError 又是真 Error（可 throw、堆栈完整）', () => {
    const mapped = classifyError(new Error('x'));
    expect(mapped).toBeInstanceOf(Error);
    expect(mapped.name).toBe('LiveKitMediaError');
    expect(() => {
      throw mapped;
    }).toThrow('x');
  });
});

describe('断开原因', () => {
  it('DisconnectReason → 稳定文本', () => {
    expect(disconnectReasonText(LK_DISCONNECT_REASON.CLIENT_INITIATED)).toBe('client_initiated');
    expect(disconnectReasonText(LK_DISCONNECT_REASON.ROOM_DELETED)).toBe('room_deleted');
    expect(disconnectReasonText(LK_DISCONNECT_REASON.PARTICIPANT_REMOVED)).toBe(
      'participant_removed',
    );
    expect(disconnectReasonText(undefined)).toBe('unknown_reason');
    expect(disconnectReasonText(999)).toBe('reason_999');
  });

  it('只有服务端主动断开才算 DISCONNECTED_BY_SERVER', () => {
    for (const reason of [
      LK_DISCONNECT_REASON.SERVER_SHUTDOWN,
      LK_DISCONNECT_REASON.PARTICIPANT_REMOVED,
      LK_DISCONNECT_REASON.ROOM_DELETED,
      LK_DISCONNECT_REASON.ROOM_CLOSED,
      LK_DISCONNECT_REASON.DUPLICATE_IDENTITY,
      LK_DISCONNECT_REASON.CONNECTION_TIMEOUT,
    ]) {
      expect(isServerInitiatedDisconnect(reason), String(reason)).toBe(true);
    }
    for (const reason of [
      LK_DISCONNECT_REASON.CLIENT_INITIATED,
      LK_DISCONNECT_REASON.SIGNAL_CLOSE,
      LK_DISCONNECT_REASON.MEDIA_FAILURE,
      LK_DISCONNECT_REASON.MIGRATION,
      LK_DISCONNECT_REASON.JOIN_FAILURE,
      LK_DISCONNECT_REASON.UNKNOWN_REASON,
    ]) {
      expect(isServerInitiatedDisconnect(reason), String(reason)).toBe(false);
    }
    expect(isServerInitiatedDisconnect(undefined)).toBe(false);
  });

  it('classifyDisconnect 只对服务端断开产出 MediaError', () => {
    const err = classifyDisconnect(LK_DISCONNECT_REASON.PARTICIPANT_REMOVED);
    expect(err?.code).toBe('DISCONNECTED_BY_SERVER');
    expect(err?.message).toContain('participant_removed');
    expect(classifyDisconnect(LK_DISCONNECT_REASON.CLIENT_INITIATED)).toBeUndefined();
    expect(classifyDisconnect(undefined)).toBeUndefined();
  });
});

describe('collectStatsSnapshot', () => {
  it('从 candidate-pair 的 currentRoundTripTime 取 RTT（秒 → 毫秒）', () => {
    const snapshot = collectStatsSnapshot(
      [
        { id: 'cp1', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.042 },
      ] satisfies RtcStatLike[],
      1_000,
    );
    expect(snapshot.rttMs).toBeCloseTo(42, 5);
  });

  it('忽略未成功的候选对，多条时取最差（最大）的一条', () => {
    const snapshot = collectStatsSnapshot(
      [
        { id: 'cp0', type: 'candidate-pair', state: 'failed', currentRoundTripTime: 5 },
        { id: 'cp1', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.02 },
        { id: 'cp2', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.08 },
      ],
      1_000,
    );
    expect(snapshot.rttMs).toBeCloseTo(80, 5);
  });

  it('没有候选对时退回 remote-inbound-rtp.roundTripTime', () => {
    const snapshot = collectStatsSnapshot(
      [{ id: 'ri1', type: 'remote-inbound-rtp', roundTripTime: 0.15, packetsLost: 3 }],
      1_000,
    );
    expect(snapshot.rttMs).toBeCloseTo(150, 5);
    expect(snapshot.packetsLost).toBe(3);
  });

  it('按 stat.id 去重，避免多路 track 的同一条 transport 级数据被重复累加', () => {
    const duplicated: RtcStatLike[] = [
      { id: 'in1', type: 'inbound-rtp', bytesReceived: 1000, packetsReceived: 10, packetsLost: 1 },
      { id: 'in1', type: 'inbound-rtp', bytesReceived: 1000, packetsReceived: 10, packetsLost: 1 },
      { id: 'in2', type: 'inbound-rtp', bytesReceived: 500, packetsReceived: 5, packetsLost: 0 },
    ];
    const snapshot = collectStatsSnapshot(duplicated, 1_000);
    expect(snapshot.bytesReceived).toBe(1500);
    expect(snapshot.packetsReceived).toBe(15);
    expect(snapshot.packetsLost).toBe(1);
  });

  it('分别累加上下行，时间戳取最新的一条', () => {
    const snapshot = collectStatsSnapshot(
      [
        { id: 'in1', type: 'inbound-rtp', bytesReceived: 100, timestamp: 5_000 },
        { id: 'out1', type: 'outbound-rtp', bytesSent: 200, packetsSent: 20, timestamp: 7_000 },
        { id: 'x', type: 'codec' },
      ],
      1_000,
    );
    expect(snapshot.bytesReceived).toBe(100);
    expect(snapshot.bytesSent).toBe(200);
    expect(snapshot.packetsSent).toBe(20);
    expect(snapshot.atMs).toBe(7_000);
  });

  it('没有 timestamp 时用调用方传入的 now', () => {
    expect(collectStatsSnapshot([], 12_345).atMs).toBe(12_345);
  });

  it('负的 packetsLost（RFC 3550 允许）钳到 0', () => {
    const snapshot = collectStatsSnapshot(
      [{ id: 'in1', type: 'inbound-rtp', packetsLost: -5, packetsReceived: 100 }],
      1_000,
    );
    expect(snapshot.packetsLost).toBe(0);
  });

  it('空输入产出全 0 快照', () => {
    const snapshot = collectStatsSnapshot([], 1_000);
    expect(snapshot).toEqual({
      atMs: 1_000,
      rttMs: 0,
      bytesReceived: 0,
      bytesSent: 0,
      packetsReceived: 0,
      packetsSent: 0,
      packetsLost: 0,
    });
  });
});

describe('computeConnectionStats', () => {
  const base: StatsSnapshot = {
    atMs: 1_000,
    rttMs: 0,
    bytesReceived: 0,
    bytesSent: 0,
    packetsReceived: 0,
    packetsSent: 0,
    packetsLost: 0,
  };

  it('首次采样没有基线 → 码率给 0（不估算、不伪造）', () => {
    const stats = computeConnectionStats({
      ...base,
      atMs: 2_000,
      rttMs: 33.4,
      bytesReceived: 999_999,
      bytesSent: 888_888,
    });
    expect(stats.inboundKbps).toBe(0);
    expect(stats.outboundKbps).toBe(0);
    expect(stats.rttMs).toBe(33);
  });

  it('相邻两次采样求差算瞬时码率', () => {
    const prev = { ...base, atMs: 1_000 };
    const cur = { ...base, atMs: 2_000, bytesReceived: 125_000, bytesSent: 62_500 };
    const stats = computeConnectionStats(cur, prev);
    expect(stats.inboundKbps).toBe(1000);
    expect(stats.outboundKbps).toBe(500);
  });

  it('丢包率优先用窗口增量', () => {
    const prev = { ...base, atMs: 1_000, packetsReceived: 1_000, packetsLost: 100 };
    const cur = { ...base, atMs: 2_000, packetsReceived: 1_990, packetsLost: 110 };
    // 增量：丢 10 / 总 1000 = 1%（若用累计值会算成 ~5.2%）
    expect(computeConnectionStats(cur, prev).packetLossPct).toBe(1);
  });

  it('没有基线时丢包率退回累计值', () => {
    const stats = computeConnectionStats({
      ...base,
      packetsReceived: 950,
      packetsLost: 50,
    });
    expect(stats.packetLossPct).toBe(5);
  });

  it('重连后计数器归零（增量为负）时不产出负数或离谱值', () => {
    const prev = { ...base, atMs: 1_000, bytesReceived: 1_000_000, packetsLost: 500 };
    const cur = { ...base, atMs: 2_000, bytesReceived: 1_000, packetsReceived: 10, packetsLost: 0 };
    const stats = computeConnectionStats(cur, prev);
    expect(stats.inboundKbps).toBe(0);
    expect(stats.packetLossPct).toBeGreaterThanOrEqual(0);
    expect(stats.packetLossPct).toBeLessThanOrEqual(100);
  });

  it('时间戳没有前进时不算码率（除零保护）', () => {
    const prev = { ...base, atMs: 2_000 };
    const cur = { ...base, atMs: 2_000, bytesReceived: 500_000 };
    expect(computeConnectionStats(cur, prev).inboundKbps).toBe(0);
  });

  it('全 0 输入 → 全 0 输出，且与 emptyConnectionStats 一致', () => {
    expect(computeConnectionStats(base)).toEqual(emptyConnectionStats());
    expect(emptyConnectionStats()).toEqual({
      rttMs: 0,
      packetLossPct: 0,
      outboundKbps: 0,
      inboundKbps: 0,
    });
  });
});
