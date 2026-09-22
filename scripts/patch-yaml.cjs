'use strict';
/**
 * cordis.patch.yml 的**外科手术式**条目删除 + 安全闸。
 *
 * 背景（P6 的第二个风险面）：官方 0.1.7 起 `profiles/web/cordis.patch.yml` 同时是
 * 「DSH 设置」的权威存储（`dsh-config-editor` 写它），里面可能有用户的关键条目，
 * 例如 `- id: llm-pi-ai`（模型 provider 定义，丢了就等于模型配置消失）。
 *
 * 之前的实现是「拆行 → 过滤 → 重新 join → 整文件写回」：虽然其它条目的文本会被保留，
 * 但仍是**全量重写**——一旦读到的快照落后于 DSH 的并发写入，就会把对方刚写的内容整体覆盖。
 *
 * 现在改为：
 *   1) 只在原文里**定位被删条目的字符区间**并删除该区间，其余字节（注释、空行、
 *      `!!js` 表达式、CRLF、行尾空格）**逐字保留**；
 *   2) 写入前跑 `assertPatchSafe()` 安全闸：结果不允许丢失任何"本不应删除"的顶层条目，
 *      也不允许丢失受保护条目（默认 `llm-pi-ai`，可用 `DSH_PATCH_PROTECTED_IDS` 覆盖），
 *      且结果必须是合法的顶层 YAML 序列；任一不满足则**放弃写入并抛错**。
 *
 * 宁可残留一条补丁（无害），也绝不能吞掉用户的模型配置。
 */

/** 默认必须保住、不允许被本模块删掉的顶层条目 id */
const DEFAULT_PROTECTED_IDS = ['llm-pi-ai'];

/** 顶层条目起始行：`- ` / `-\t`；`- id: x` 视为带 id 的条目 */
const ENTRY_START_RE = /^-\s/;
const ENTRY_ID_RE = /^-\s*id:\s*["']?([^\s"'\r\n]+)/;

/** 按"保留行尾"的方式切分，保证重新拼接后与原文字节一致（含 CRLF） */
function splitKeepEol(content) {
  return String(content).split(/(?<=\n)/);
}

function lineWithoutEol(chunk) {
  return String(chunk).replace(/\r?\n$/, '');
}

/** 列出顶层带 id 的条目 id（缩进的嵌套 `- id:` 不计入） */
function topLevelEntryIds(content) {
  const ids = [];
  for (const chunk of splitKeepEol(content)) {
    const m = ENTRY_ID_RE.exec(chunk);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * 按"条目"粒度删除命中项；未命中的字节原样保留。
 * @param {string} content 原始 patch 文本
 * @param {(block: string) => boolean} matcher 命中判定（block 含该条目完整文本）
 * @returns {{ text: string, removed: number, removedIds: string[] }}
 */
function removePatchEntries(content, matcher) {
  const chunks = splitKeepEol(content);
  const out = [];
  const removedIds = [];
  let removed = 0;
  let i = 0;

  while (i < chunks.length) {
    if (!ENTRY_START_RE.test(chunks[i])) {
      out.push(chunks[i]);
      i += 1;
      continue;
    }
    // 条目续行：缩进行，或条目之间的空行（与既有语义一致）
    const start = i;
    let j = i + 1;
    while (j < chunks.length && !ENTRY_START_RE.test(chunks[j])) {
      const bare = lineWithoutEol(chunks[j]);
      if (bare.trim() === '' || /^\s/.test(bare)) {
        j += 1;
        continue;
      }
      break;
    }
    const block = chunks.slice(start, j).join('');
    i = j;
    if (matcher(block)) {
      removed += 1;
      const m = ENTRY_ID_RE.exec(block);
      if (m) removedIds.push(m[1]);
      continue;
    }
    out.push(block);
  }

  return { text: out.join(''), removed, removedIds };
}

function protectedPatchIds() {
  const raw = process.env.DSH_PATCH_PROTECTED_IDS;
  if (raw === undefined) return DEFAULT_PROTECTED_IDS.slice();
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/** 结果是否像合法的 patch 文档：空内容、'[]'、或以顶层 `- ` 开头 */
function looksLikePatchDocument(content) {
  const trimmed = String(content).trim();
  if (trimmed === '' || trimmed === '[]') return true;
  return /^-\s/m.test(trimmed) && !/^\s+-\s/m.test(trimmed.split('\n')[0] || '');
}

/**
 * 安全闸：任何"会丢失条目/把文档改坏"的改写都必须被拦下。
 * @param {{ before: string, after: string, removedIds?: string[] }} input
 * @throws {Error} 违反不变量时抛出（调用方应放弃写入）
 */
function assertPatchSafe({ before, after, removedIds = [] }) {
  const beforeIds = topLevelEntryIds(before);
  const afterIds = topLevelEntryIds(after);
  const removed = new Set(removedIds);

  const unexpectedLoss = beforeIds.filter((id) => !afterIds.includes(id) && !removed.has(id));
  if (unexpectedLoss.length > 0) {
    throw new Error(`patch-yaml: 改写会丢失本不应删除的条目 [${unexpectedLoss.join(', ')}]，已放弃写入`);
  }

  const protectedLoss = protectedPatchIds().filter((id) => beforeIds.includes(id) && !afterIds.includes(id));
  if (protectedLoss.length > 0) {
    throw new Error(`patch-yaml: 改写会删除受保护条目 [${protectedLoss.join(', ')}]，已放弃写入（可用 DSH_PATCH_PROTECTED_IDS 调整保护清单）`);
  }

  if (!looksLikePatchDocument(after)) {
    throw new Error('patch-yaml: 改写结果不是合法的顶层 YAML 序列，已放弃写入');
  }
  return true;
}

module.exports = {
  DEFAULT_PROTECTED_IDS,
  splitKeepEol,
  topLevelEntryIds,
  removePatchEntries,
  protectedPatchIds,
  looksLikePatchDocument,
  assertPatchSafe
};
