/**
 * 极简 IndexedDB 桩：只实现 src/background/history.js 用到的那一小撮 API。
 *
 * node 里没有 indexedDB（v22 仍未内置），用它把「记录 → 命中 → 跳过」整条链路跑起来，
 * 免得去重逻辑只能靠手点浏览器验证。
 */

export function installFakeIndexedDB() {
  const databases = new Map();

  const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  function makeStoreHandle(data, tx) {
    const run = (fn) => {
      const r = makeRequest();
      if (tx) tx.pending += 1;
      queueMicrotask(() => {
        let failed = null;
        try {
          r.result = fn();
        } catch (err) {
          failed = err;
          r.error = err;
        }
        if (!failed && r.onsuccess) r.onsuccess({ target: r });
        if (failed && r.onerror) r.onerror({ target: r });
        if (tx) {
          tx.pending -= 1;
          tx.settle();
        }
      });
      return r;
    };

    return {
      name: data.name,
      get: (k) => run(() => (data.map.has(k) ? structuredClone(data.map.get(k)) : undefined)),
      put: (v) => run(() => {
        const k = v[data.keyPath];
        data.map.set(k, structuredClone(v));
        return k;
      }),
      delete: (k) => run(() => data.map.delete(k)),
      clear: () => run(() => data.map.clear()),
      getAll: () => run(() => [...data.map.values()].map((v) => structuredClone(v))),
      count: () => run(() => data.map.size),
    };
  }

  function makeDB(record) {
    return {
      objectStoreNames: { contains: (n) => record.stores.has(n) },
      createObjectStore: (name, { keyPath } = {}) => {
        record.stores.set(name, { name, keyPath: keyPath || 'id', map: new Map() });
        return { name, createIndex() {} };
      },
      transaction: (name, mode = 'readonly') => {
        if (!record.stores.has(name)) throw new Error(`NotFoundError: no store ${name}`);
        const tx = {
          mode,
          pending: 0,
          done: false,
          oncomplete: null,
          onerror: null,
          onabort: null,
          // 等到「没有进行中的请求」才收尾，并且延迟一个微任务，
          // 让 onsuccess 里继续发起的请求（先 get 再 put）来得及把 pending 顶回去
          settle() {
            if (this.pending > 0 || this.done) return;
            queueMicrotask(() => {
              if (this.pending > 0 || this.done) return;
              this.done = true;
              if (this.oncomplete) this.oncomplete({ target: this });
            });
          },
          objectStore: (n) => {
            const d = record.stores.get(n);
            if (!d) throw new Error(`NotFoundError: no store ${n}`);
            return makeStoreHandle(d, tx);
          },
          abort() {
            this.done = true;
            if (this.onabort) this.onabort({ target: this });
          },
        };
        return tx;
      },
      close() {},
    };
  }

  globalThis.indexedDB = {
    open(name, version) {
      const r = makeRequest();
      queueMicrotask(() => {
        let record = databases.get(name);
        const fresh = !record;
        if (!record) {
          record = { version: 0, stores: new Map() };
          databases.set(name, record);
        }
        r.result = makeDB(record);
        const target = version || 1;
        if (fresh || target > record.version) {
          const oldVersion = record.version;
          record.version = target;
          if (r.onupgradeneeded) r.onupgradeneeded({ target: r, oldVersion, newVersion: target });
        }
        if (r.onsuccess) r.onsuccess({ target: r });
      });
      return r;
    },
  };

  return {
    /** 直接窥视库内容，便于断言 */
    dump(name = 'paperplane-history') {
      const record = databases.get(name);
      if (!record) return {};
      const out = {};
      for (const [storeName, data] of record.stores) out[storeName] = [...data.map.values()];
      return out;
    },
    reset() {
      databases.clear();
      delete globalThis.indexedDB;
    },
  };
}
