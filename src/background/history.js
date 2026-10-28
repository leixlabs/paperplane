/**
 * 本地发送历史 —— 去重用的「已发地址」数据库。
 *
 * 为什么用 IndexedDB 而不是 chrome.storage.local：
 *  - storage.local 是整块 KV，每条消息都要把整个 map 读出来再写回去，条目一多就卡；
 *  - IndexedDB 按 key 直接命中（get(key) 走 B-tree），几千条也是 O(log n)；
 *  - 两者都能在 Service Worker 与设置有页面共享，但只有 IDB 有真正的「表 + 索引」。
 *
 * 三条硬约束：
 *  1. 任何异常都不能阻塞发送。查询失败按「没发过」处理，写入失败只 warn。
 *  2. 数据库不存在（极旧浏览器 / 被清理）时自动建库，无需迁移脚本。
 *  3. 本模块可在 node 测试里跑（用 tests/fake-idb.mjs 提供的假 IDB）。
 */
import { normalizeUrl } from '../lib/url.js';

const DB_NAME = 'paperplane-history';
const DB_VERSION = 1;
const STORE = 'sent';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 记录形状 { key, url, title, chatId, messageId, firstSentAt, lastSentAt, count } */

let dbPromise = null;

function warn(...args) {
  try { console.warn('[paperplane/history]', ...args); } catch { /* 无 console 也不该炸 */ }
}

function idbAvailable() {
  try { return Boolean(globalThis.indexedDB); } catch { return false; }
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
  });
}

function openDB() {
  if (!idbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('lastSentAt', 'lastSentAt');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('本地数据库被其他页面占用，请关闭设置页后重试'));
  }).catch((err) => {
    dbPromise = null; // 下次调用重新尝试，不把一次失败永久缓存
    throw err;
  });

  return dbPromise;
}

/**
 * 在事务里跑一段同步/异步的 store 操作。
 * @returns {Promise<{supported:boolean, value:any}>} supported=false 表示环境没有 IndexedDB
 */
async function withStore(mode, work) {
  const db = await openDB();
  if (!db) return { supported: false, value: null };

  const tx = db.transaction(STORE, mode);
  const store = tx.objectStore(STORE);
  const done = txDone(tx); // 必须在发起请求前挂上，否则事务可能已结束

  let value;
  try {
    value = await work(store);
  } catch (err) {
    done.catch(() => {}); // abort 会让 done 拒绝；先挂个空 catch，别留未处理拒绝
    try { tx.abort(); } catch { /* 事务可能已结束 */ }
    throw err;
  }
  await done;
  return { supported: true, value };
}

/**
 * 查这个地址是否已经发过。
 * @param {string} rawUrl
 * @param {{keepDays?: number}} [opts] keepDays>0 时只认最近 N 天内的记录，0 = 永久有效
 * @returns {Promise<object|null>} 命中返回记录，否则 null
 */
export async function findSent(rawUrl, { keepDays = 0 } = {}) {
  const key = normalizeUrl(rawUrl);
  if (!key) return null;

  try {
    const { supported, value } = await withStore('readonly', (store) => req(store.get(key)));
    if (!supported || !value) return null;
    if (keepDays > 0 && Date.now() - (value.lastSentAt || 0) > keepDays * DAY_MS) return null;
    return value;
  } catch (err) {
    // 读不到历史就当作没发过：宁可重复发一条，也不要「点了没反应」
    warn('查询发送历史失败，本次按未发送处理：', err?.message || err);
    return null;
  }
}

/**
 * 记一条「已发送」。同一地址重复记录会累加 count 并刷新 lastSentAt。
 * @returns {Promise<boolean>} 是否写入成功（失败不影响发送结果）
 */
export async function recordSent({ url, title = '', chatId = '', messageId = null } = {}) {
  const key = normalizeUrl(url);
  if (!key) return false;

  const now = Date.now();
  try {
    const { supported } = await withStore('readwrite', async (store) => {
      const prev = await req(store.get(key));
      store.put({
        key,
        url: String(url || '').slice(0, 2000),
        title: String(title || '').slice(0, 200),
        chatId: String(chatId || ''),
        messageId: messageId ?? null,
        firstSentAt: prev?.firstSentAt || now,
        lastSentAt: now,
        count: (prev?.count || 0) + 1,
      });
    });
    return supported;
  } catch (err) {
    warn('写入发送历史失败（不影响本次发送）：', err?.message || err);
    return false;
  }
}

/**
 * 历史概览，给设置页展示。
 * @returns {Promise<{supported:boolean, count:number, lastSentAt:number, error?:string}>}
 */
export async function stats() {
  try {
    const { supported, value } = await withStore('readonly', (store) => req(store.getAll()));
    if (!supported) return { supported: false, count: 0, lastSentAt: 0 };

    const records = value || [];
    let lastSentAt = 0;
    for (const r of records) {
      if ((r?.lastSentAt || 0) > lastSentAt) lastSentAt = r.lastSentAt;
    }
    return { supported: true, count: records.length, lastSentAt };
  } catch (err) {
    warn('读取历史统计失败：', err?.message || err);
    return { supported: true, count: 0, lastSentAt: 0, error: String(err?.message || err) };
  }
}

/**
 * 清空全部历史（清空后发过的地址会重新被视为未发送）。
 * @returns {Promise<boolean>}
 */
export async function clearAll() {
  try {
    const { supported } = await withStore('readwrite', (store) => req(store.clear()));
    return supported;
  } catch (err) {
    warn('清空历史失败：', err?.message || err);
    return false;
  }
}

/** 仅供测试：丢掉缓存的数据库连接，下次调用重新 open */
export function _resetConnection() {
  dbPromise = null;
}
