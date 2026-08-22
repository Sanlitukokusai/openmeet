/**
 * 抽象层事件的最小类型安全发射器（规格书 §3.2 的 `on` / `off`）。
 *
 * 为什么不直接用 livekit 的 TypedEmitter：
 *   - 它是 livekit-client 的运行时依赖，会把浏览器全局拖进纯逻辑层；
 *   - 抽象层的事件表（MediaProviderEvents）与 provider 无关，换 Agora 时要原样复用。
 *
 * 行为约定：
 *   - 同一个 (event, cb) 重复 `on` 只登记一次（Set 语义），`off` 一次即清除；
 *   - `emit` 前先快照监听器列表 → 回调里 on/off 不会影响本轮派发，也不会踩迭代器；
 *   - 单个回调抛错不打断其他回调（媒体层不能因为某个 UI 监听器炸了就整条链路停摆）。
 */
type AnyListener = (...args: unknown[]) => void;

/**
 * 约束写成 `Record<keyof E, ...>` 而不是 `Record<string, ...>`：
 * 后者要求事件表带索引签名，而 MediaProviderEvents 是普通 interface（没有），会编译不过。
 */
export class TypedEventEmitter<E extends Record<keyof E, (...args: never[]) => void>> {
  private readonly listeners = new Map<keyof E, Set<AnyListener>>();

  on<K extends keyof E>(event: K, cb: E[K]): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<AnyListener>();
      this.listeners.set(event, set);
    }
    set.add(cb as unknown as AnyListener);
  }

  off<K extends keyof E>(event: K, cb: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(cb as unknown as AnyListener);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        cb(...(args as unknown[]));
      } catch (err) {
        // 监听器自身的异常不该反噬媒体层。
        // 格式串保持字面量常量（semgrep format-injection 规则），事件名作独立参数传入。
        console.error('[media] event listener threw:', String(event), err);
      }
    }
  }

  listenerCount<K extends keyof E>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
