'use strict';
/**
 * cordis.patch.yml 的条目级精确删除与安全闸。
 *
 * profiles/web/cordis.patch.yml 同时是 DSH 设置的权威存储（包含 llm-pi-ai 等模型配置）。
 * 本模块仅定位并移除命中条目的字符区间，其余字节（注释、空行、CRLF、行尾空格）逐字保留；
 * 写入前执行 assertPatchSafe() 校验，确保不丢失受保护条目与非目标条目，且结果仍为合法 YAML 序列。
 */

const DEFAULT_PROTECTED_IDS = ['llm-pi-ai'];

const ENTRY_START_RE = /^-\s/;
const ENTRY_ID_RE = /^-\s*id:\s*["']?([^\s"'\r\n]+)/;

function splitKeepEol(content) {
  return String(content).split(/(?<=\n)/);
}

function lineWithoutEol(chunk) {
  return String(chunk).replace(/\r?\n$/, '');
}

function topLevelEntryIds(content) {
  const ids = [];
  for (const chunk of splitKeepEol(content)) {
    const m = ENTRY_ID_RE.exec(chunk);
    if (m) ids.push(m[1]);
  }
  return ids;
}

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

function looksLikePatchDocument(content) {
  const trimmed = String(content).trim();
  if (trimmed === '' || trimmed === '[]') return true;
  return /^-\s/m.test(trimmed) && !/^\s+-\s/m.test(trimmed.split('\n')[0] || '');
}

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
