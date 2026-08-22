/**
 * WP-3：抽象层事件发射器单测（`on` / `off` 是 §3.2 接口的一部分）。
 * 同样只碰纯逻辑文件，不引 livekit-client 运行时、不引 lib/supabase.ts。
 */
import { describe, expect, it, vi } from 'vitest';

import { TypedEventEmitter } from '@/lib/media/providers/livekit/emitter';
import type { MediaProviderEvents } from '@/lib/media/types';

function makeEmitter() {
  return new TypedEventEmitter<MediaProviderEvents>();
}

describe('TypedEventEmitter', () => {
  it('emit 会带上完整参数调用监听器', () => {
    const emitter = makeEmitter();
    const onLeft = vi.fn();
    emitter.on('participantLeft', onLeft);
    emitter.emit('participantLeft', 'guest_1');
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(onLeft).toHaveBeenCalledWith('guest_1');
  });

  it('同一个回调重复 on 只登记一次', () => {
    const emitter = makeEmitter();
    const cb = vi.fn();
    emitter.on('reconnecting', cb);
    emitter.on('reconnecting', cb);
    expect(emitter.listenerCount('reconnecting')).toBe(1);
    emitter.emit('reconnecting');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('off 之后不再收到事件（UI 卸载时的清理路径）', () => {
    const emitter = makeEmitter();
    const cb = vi.fn();
    emitter.on('connected', cb);
    emitter.off('connected', cb);
    emitter.emit('connected');
    expect(cb).not.toHaveBeenCalled();
    expect(emitter.listenerCount('connected')).toBe(0);
  });

  it('off 未注册过的回调不报错', () => {
    const emitter = makeEmitter();
    expect(() => emitter.off('connected', vi.fn())).not.toThrow();
  });

  it('没有监听器时 emit 是安全的空操作', () => {
    const emitter = makeEmitter();
    expect(() => emitter.emit('disconnected', 'room_deleted')).not.toThrow();
  });

  it('回调中 on/off 不影响本轮派发（派发前已快照，也不会踩迭代器）', () => {
    const emitter = makeEmitter();
    const later = vi.fn();
    const first = vi.fn(() => {
      emitter.off('connected', second);
      emitter.on('connected', later);
    });
    const second = vi.fn();
    emitter.on('connected', first);
    emitter.on('connected', second);

    emitter.emit('connected');
    expect(second).toHaveBeenCalledTimes(1); // 本轮仍会被调用
    expect(later).not.toHaveBeenCalled(); // 本轮新加的不参与

    emitter.emit('connected');
    expect(second).toHaveBeenCalledTimes(1); // 下一轮才生效
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('单个监听器抛错不影响其他监听器（媒体层不能被 UI 回调拖垮）', () => {
    const emitter = makeEmitter();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(() => {
      throw new Error('ui blew up');
    });
    const ok = vi.fn();
    emitter.on('reconnected', boom);
    emitter.on('reconnected', ok);

    expect(() => emitter.emit('reconnected')).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('不同事件之间互不串扰', () => {
    const emitter = makeEmitter();
    const onError = vi.fn();
    const onJoined = vi.fn();
    emitter.on('error', onError);
    emitter.on('participantJoined', onJoined);
    emitter.emit('error', { code: 'UNKNOWN', message: 'x' });
    expect(onError).toHaveBeenCalledWith({ code: 'UNKNOWN', message: 'x' });
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('removeAll 清空全部订阅', () => {
    const emitter = makeEmitter();
    const cb = vi.fn();
    emitter.on('connected', cb);
    emitter.on('reconnecting', cb);
    emitter.removeAll();
    emitter.emit('connected');
    emitter.emit('reconnecting');
    expect(cb).not.toHaveBeenCalled();
  });
});
