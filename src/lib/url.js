/**
 * URL 归一化：给去重用的「页面指纹」。
 *
 * 目标不是严格的语义等价（那做不到），而是「同一个页面被再次打开时能算出同一个 key」：
 *  - 丢掉 hash（页内锚点不影响内容）
 *  - 丢掉 utm_* / fbclid / spm 这类跟踪参数，它们每次分享都可能不同
 *  - 剩下的查询参数按键排序，同一组参数换个顺序不会被判成两个页面
 *  - 主机名小写、去掉 www.、去掉协议默认端口
 *  - 路径去掉末尾斜杠（/a 与 /a/ 绝大多数站点是同一页）
 *
 * 宁可漏判、不可错杀：只剔除明确无意义的参数，业务参数（?p=2、?id=123）一律保留。
 */

/** 精确匹配即剔除的噪声参数（爬虫 / 分享 / 广告归因） */
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'igshid', 'ttclid',
  'spm', 'spm_id_from', 'scm',
  'ref', 'ref_src', 'ref_url', 'referrer',
  'share_source', 'share_medium', 'share_plat', 'share_tag', 'share_token',
  'from', 'from_source', 'from_spmid',
  'isappinstalled', 'vd_source', 'unique_k', 'timestamp',
]);

/** 前缀匹配即剔除的参数族（utm_source / utm_medium / ga_xxx …） */
const TRACKING_PREFIX = /^(utm_|ga_|pk_|mtm_|hsa_|_hsenc|_hsmi|vero_|icid_)/i;

export function isTrackingParam(key) {
  if (!key) return false;
  const k = String(key).toLowerCase();
  return TRACKING_EXACT.has(k) || TRACKING_PREFIX.test(k);
}

/**
 * 归一化 URL。非 http(s) 或无法解析时原样返回（去重仍能工作，只是不做等价合并）。
 * @param {string} raw
 * @returns {string} 归一化后的 key，空输入返回 ''
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  const input = raw.trim();
  if (!input) return '';

  let u;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const defaultPort =
    (u.protocol === 'http:' && (u.port === '' || u.port === '80')) ||
    (u.protocol === 'https:' && (u.port === '' || u.port === '443'));
  const authority = defaultPort ? host : `${host}:${u.port}`;

  let path = u.pathname.replace(/\/+$/, '');
  if (!path) path = '/';

  const params = [];
  for (const [k, v] of u.searchParams) {
    if (isTrackingParam(k)) continue;
    params.push([k, v]);
  }
  // 稳定排序：key 相同则保持原顺序（sort 在 V8 上是稳定的）
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const query = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  return `${u.protocol}//${authority}${path}${query}`;
}

/** 两个地址是否指向同一页面（按归一化结果比较） */
export function sameAddress(a, b) {
  const ka = normalizeUrl(a);
  return Boolean(ka) && ka === normalizeUrl(b);
}
