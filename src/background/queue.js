/**
 * 串行任务队列（FIFO）
 *
 * 把「点一下图标」当成一次任务提交，而不是一次发送。于是用户可以在上一篇
 * 还在摘要时继续点别的标签页，任务按点击顺序依次执行，互不打断。
 *
 * 为什么是串行（concurrency 固定为 1）：
 *  - Gemini Nano 的 session 只有一份，并发调用会互相挤占，还容易把 offscreen
 *    的推理流水线打满，反而更慢；
 *  - Telegram 侧对同一 Bot 的下发也有频率限制，串行天然有序、好排查。
 *
 * 本模块不碰 chrome.*，纯 JS，可直接在 node 里测。
 *
 * task 结构：
 *   { id?, url?, title?, run: () => Promise<any>, onDone?(res), onFail?(err) }
 */

export const QUEUE_REJECT = {
  DUPLICATE: 'duplicate',   // 同一个 URL 已经在队列里
  FULL: 'full',             // 队列已达上限
  INVALID: 'invalid',       // 任务结构不合法
};

export function createTaskQueue({ maxPending = 20, onStateChange, onIdle, keyOf } = {}) {
  /** @type {Array<object>} 等待执行的任务 */
  const waiting = [];
  /** 正在执行的任务（串行，最多一个） */
  let current = null;

  const key = typeof keyOf === 'function' ? keyOf : (t) => t?.url || '';

  function state() {
    return {
      waiting: waiting.length,
      running: current ? 1 : 0,
      total: waiting.length + (current ? 1 : 0),
    };
  }

  function emit() {
    try {
      onStateChange?.(state());
    } catch {
      /* 状态回调出错不该影响队列本身 */
    }
  }

  function sameAs(a, b) {
    const ka = key(a);
    return Boolean(ka) && ka === key(b);
  }

  /**
   * 入队。返回 { accepted, reason, position }
   * 重复 / 队列满都不会抛错，交由调用方决定怎么提示用户。
   */
  function add(task) {
    if (!task || typeof task.run !== 'function') {
      return { accepted: false, reason: QUEUE_REJECT.INVALID };
    }
    if (key(task) && (waiting.some((t) => sameAs(t, task)) || (current && sameAs(current, task)))) {
      return { accepted: false, reason: QUEUE_REJECT.DUPLICATE };
    }
    if (waiting.length + (current ? 1 : 0) >= maxPending) {
      return { accepted: false, reason: QUEUE_REJECT.FULL };
    }

    waiting.push(task);
    emit();
    kick();
    return { accepted: true, position: waiting.length + (current ? 1 : 0) };
  }

  function kick() {
    if (current || waiting.length === 0) return;

    const task = waiting.shift();
    current = task;
    emit();

    // 用微任务兜住 task.run() 的同步抛错，保证队列一定会往下走
    Promise.resolve()
      .then(() => task.run())
      .then(
        (res) => safe(() => task.onDone?.(res)),
        (err) => safe(() => task.onFail?.(err))
      )
      .then(() => {
        current = null;
        emit();
        if (waiting.length > 0) {
          kick();
        } else {
          safe(() => onIdle?.());
        }
      });
  }

  function safe(fn) {
    try {
      fn();
    } catch {
      /* noop */
    }
  }

  return { add, state, get size() { return state().total; } };
}
