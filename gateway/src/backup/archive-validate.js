'use strict';
/**
 * archive-validate.js — 归档成员流式白名单校验与 tar 执行原语。
 *
 * 100% 保留全部历史快照兼容校验逻辑：
 *   - 合法依赖目录软链白名单（含 /opt/、/app/plugins/、/usr/lib/node_modules/ 等）
 *   - 指向当前 DSH_DIR 与 LEGACY_DSH_DIR (/root/.dsh) 的绝对软链白名单
 *   - 逃出归档根相对软链按真实落点换算校验
 *   - 硬链接与本地化分隔符（' -> ', ' link to ', ' 连接到 '）+ LC_ALL=C
 *   - 流式按行解析（支持 >100 万成员大快照）
 *   - 统一归一化 './.dsh/' 前缀与 '.dsh/' 前缀
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const paths = require('../core/paths');

const DATA_ENTRIES = ['sessions', 'attachments', 'storages', 'plugin-data', 'logs', 'cache'];
const ALLOWED_ARCHIVE_PREFIX = '.dsh';
const ALLOWED_LINK_PREFIXES = [
  '/usr/local/lib/node_modules/',
  '/usr/lib/node_modules/',
  '/app/plugins/',
  '/app/node_modules/',
  '/opt/'
];
const LINK_SEPARATORS = [' -> ', ' link to ', ' 连接到 '];

const DEFAULT_SNAPSHOT_TIMEOUT_MS = Number(process.env.DSH_SNAPSHOT_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_SNAPSHOT_TIMEOUT_MS)
  : 30 * 60 * 1000;

const DEFAULT_MAX_ARCHIVE_MEMBERS = Number(process.env.DSH_MAX_ARCHIVE_MEMBERS) > 0
  ? Number(process.env.DSH_MAX_ARCHIVE_MEMBERS)
  : 1000 * 1000;
const MAX_LISTING_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_LISTING_BYTES = 512 * 1024 * 1024;
const MAX_TRACKED_SYMLINK_MEMBERS = 100 * 1000;

const toPosix = (p) => String(p).replace(/\\/g, '/');

function getLegacyDshDir() {
  const legHome = process.env.DSH_LEGACY_HOME || '/root';
  return path.basename(legHome) === '.dsh' ? legHome : path.join(legHome, '.dsh');
}

function getArchiveRootBases() {
  return Array.from(new Set([paths.getDshDir(), getLegacyDshDir()]));
}

function getArchiveRootAbsPrefixes() {
  return getArchiveRootBases().map((d) => (d.endsWith('/') ? d : d + '/'));
}

// 兼容静态常量导出
const LEGACY_DSH_DIR = getLegacyDshDir();
const ARCHIVE_ROOT_BASES = getArchiveRootBases();
const ARCHIVE_ROOT_ABS_PREFIXES = getArchiveRootAbsPrefixes();

function verifyGzipMagic(headerBuffer) {
  if (!headerBuffer || headerBuffer.length < 2) return false;
  return headerBuffer[0] === 0x1f && headerBuffer[1] === 0x8b;
}

let _pigzCache = null;

function hasPigz(opts = {}) {
  const forceRefresh = Boolean(opts && opts.refresh);
  const customPath = opts && typeof opts.pathEnv === 'string' ? opts.pathEnv : null;
  const useCache = !forceRefresh && customPath === null;
  if (useCache && _pigzCache !== null) return _pigzCache;

  const candidates = [];
  if (customPath === null) {
    candidates.push('/usr/bin/pigz', '/bin/pigz');
  }
  const pathStr = customPath !== null ? customPath : String(process.env.PATH || '');
  for (const dir of pathStr.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(path.join(trimmed, 'pigz'));
  }

  const seen = new Set();
  let found = false;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        found = true;
        break;
      }
    } catch {}
  }

  if (useCache) _pigzCache = found;
  return found;
}

function getPigzThreads(env = process.env) {
  const source = env || {};
  const raw = source.DSH_BACKUP_THREADS;
  if (raw !== undefined) {
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed >= 1) {
        return Math.max(1, Math.min(parsed, 64));
      }
    }
  }
  const detected = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (Array.isArray(os.cpus()) ? os.cpus().length : 2);
  return Math.max(1, Math.min(detected || 2, 8));
}

function buildTarEnv(extraEnv = {}, baseEnv = process.env) {
  const env = { ...(baseEnv || {}), ...(extraEnv || {}) };
  if (env.PIGZ === undefined || String(env.PIGZ).trim() === '') {
    env.PIGZ = `-p ${getPigzThreads(env)}`;
  }
  return env;
}

function runTarAsync(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 64 * 1024 * 1024;
  const spawnOptions = { ...options };
  delete spawnOptions.timeoutMs;
  delete spawnOptions.maxOutputBytes;
  spawnOptions.env = buildTarEnv(spawnOptions.env);

  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`tar 执行超时（${Math.round(timeoutMs / 1000)}s）: tar ${args.join(' ')}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    const onData = (chunk, isErr) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`tar 输出超过上限（已读 ${outBytes} 字节，上限 ${maxOutputBytes} 字节）: tar ${args.join(' ')}`));
        return;
      }
      if (isErr) stderr += chunk.toString('utf8');
      else stdout += chunk.toString('utf8');
    };
    child.stdout.on('data', (d) => onData(d, false));
    child.stderr.on('data', (d) => onData(d, true));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });
  });
}

/**
 * 统一归一化 './.dsh/' 前缀，同时不放行 './../' 或内部 '/./' 段。
 */
function normalizeArchiveMemberPrefix(memberPath) {
  const s = String(memberPath || '');
  if (s === './.dsh' || s === './.dsh/' || s.startsWith('./.dsh/')) {
    return s.slice(2);
  }
  return s;
}

function assertSafeMemberPath(memberPath, who) {
  const clean = normalizeArchiveMemberPrefix(memberPath).replace(/\/+$/, '');
  if (clean !== ALLOWED_ARCHIVE_PREFIX && !clean.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) {
    throw new Error(`${who}超出允许范围（仅允许 ${ALLOWED_ARCHIVE_PREFIX}/ 之下）: ${String(memberPath).slice(0, 120)}`);
  }
  const segs = clean.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`${who}包含非法路径段: ${String(memberPath).slice(0, 120)}`);
  }
}

function isAllowedAbsoluteLinkTarget(absPath) {
  if (!absPath || !absPath.startsWith('/')) return false;
  if (ALLOWED_LINK_PREFIXES.some((p) => absPath.startsWith(p))) return true;
  for (const root of getArchiveRootAbsPrefixes()) {
    if (!absPath.startsWith(root)) continue;
    const rel = absPath.slice(root.length);
    if (!rel) return false;
    try {
      assertSafeMemberPath(ALLOWED_ARCHIVE_PREFIX + '/' + rel, '归档链接目标');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isAllowedSymlinkTarget(memberName, linkTarget) {
  const normMember = normalizeArchiveMemberPrefix(memberName);
  if (!linkTarget.startsWith('/')) {
    const insideArchive = path.posix.normalize(path.posix.join(path.posix.dirname(normMember), linkTarget));
    if (insideArchive.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) return true;
    const memberDirInArchive = path.posix.dirname(normMember);
    for (const base of getArchiveRootBases()) {
      const memberDirAbs = path.posix.join(toPosix(path.posix.dirname(toPosix(base))), memberDirInArchive);
      const resolved = path.posix.resolve(memberDirAbs, linkTarget);
      if (isAllowedAbsoluteLinkTarget(resolved)) return true;
    }
    return false;
  }
  return isAllowedAbsoluteLinkTarget(path.posix.normalize(linkTarget));
}

function splitLinkMember(rawName) {
  let count = 0;
  let firstIdx = -1;
  let firstSep = null;
  for (const sep of LINK_SEPARATORS) {
    let from = 0;
    let idx;
    while ((idx = rawName.indexOf(sep, from)) >= 0) {
      count += 1;
      if (firstIdx < 0 || idx < firstIdx) { firstIdx = idx; firstSep = sep; }
      from = idx + sep.length;
    }
  }
  if (count === 0) return { name: rawName, linkTarget: null, ambiguous: false };
  if (count > 1) return { name: rawName, linkTarget: null, ambiguous: true };
  return {
    name: rawName.slice(0, firstIdx),
    linkTarget: rawName.slice(firstIdx + firstSep.length),
    ambiguous: false
  };
}

function classifyArchiveMemberLine(rawLine) {
  const line = rawLine.replace(/\s+$/, '');
  if (!line) return null;

  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) throw new Error(`无法解析归档成员: ${line.slice(0, 120)}`);

  const typeChar = parts[0][0];
  const rawName = parts.slice(5).join(' ');
  const isLink = typeChar === 'l' || typeChar === 'h';

  let name = rawName;
  let linkTarget = null;
  if (isLink) {
    const split = splitLinkMember(rawName);
    if (split.ambiguous) {
      throw new Error(`归档链接成员含多个链接分隔符，无法无歧义解析: ${rawName.slice(0, 120)}`);
    }
    name = split.name;
    linkTarget = split.linkTarget;
  }

  const normalizedName = normalizeArchiveMemberPrefix(name);

  if (isLink) {
    if (!linkTarget) {
      const kind = typeChar === 'h' ? '硬' : '符号';
      throw new Error(`归档${kind}链接成员缺少目标（tar 输出格式无法识别）: ${name.slice(0, 120)}`);
    }
    assertSafeMemberPath(normalizedName, '归档链接成员');
    if (normalizedName.replace(/\/+$/, '') === ALLOWED_ARCHIVE_PREFIX) {
      throw new Error(`归档根目录 ${ALLOWED_ARCHIVE_PREFIX} 不得是链接成员: ${name.slice(0, 120)}`);
    }
    if (typeChar === 'h') {
      const normalizedTarget = normalizeArchiveMemberPrefix(linkTarget);
      assertSafeMemberPath(normalizedTarget, '归档硬链接目标');
      return { type: 'hardlink', name: normalizedName, linkTarget: normalizedTarget };
    }
    if (!isAllowedSymlinkTarget(normalizedName, linkTarget)) {
      throw new Error(`归档包含指向不允许位置的链接成员: ${normalizedName.slice(0, 60)} -> ${String(linkTarget).slice(0, 60)}`);
    }
    return { type: 'symlink', name: normalizedName };
  }

  if (typeChar !== '-' && typeChar !== 'd') {
    throw new Error(`归档包含不允许的成员类型 (${typeChar})，仅允许普通文件、目录与受控链接: ${name.slice(0, 120)}`);
  }
  assertSafeMemberPath(normalizedName, '归档成员');
  return { type: typeChar === 'd' ? 'dir' : 'file', name: normalizedName };
}

function validateArchiveMembers(archivePath, opts = {}) {
  const maxMembers = Number(opts.maxMembers) > 0 ? Number(opts.maxMembers) : DEFAULT_MAX_ARCHIVE_MEMBERS;
  const maxListingBytes = Number(opts.maxListingBytes) > 0 ? Number(opts.maxListingBytes) : DEFAULT_MAX_LISTING_BYTES;
  const timeoutMs = Number(opts.timeoutMs) > 0
    ? Number(opts.timeoutMs)
    : DEFAULT_SNAPSHOT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const usePigz = hasPigz();
    const tarArgs = usePigz
      ? ['--numeric-owner', '-I', 'pigz', '-tvf', archivePath]
      : ['--numeric-owner', '-tvzf', archivePath];
    const child = spawn('tar', tarArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildTarEnv({ LC_ALL: 'C', LANG: 'C', LANGUAGE: '' })
    });

    let settled = false;
    let timer = null;
    let members = 0;
    let listingBytes = 0;
    let hardLinks = 0;
    let symLinks = 0;
    let stderr = '';
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const symlinkNames = new Set();

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(
      () => fail(new Error(`归档校验超时（${Math.round(timeoutMs / 1000)}s）: ${path.basename(String(archivePath))}`)),
      timeoutMs
    );
    if (timer.unref) timer.unref();

    const handleLine = (rawLine) => {
      if (settled) return;
      const cls = classifyArchiveMemberLine(rawLine);
      if (!cls) return;
      members += 1;
      if (members > maxMembers) {
        const err = new Error(
          `归档成员数超过上限（${members} > ${maxMembers}），已中止校验。` +
          `如确认可信，请提高环境变量 DSH_MAX_ARCHIVE_MEMBERS 或改用「仅配置」快照后重试。`
        );
        err.errorCode = 'SNAPSHOT_TOO_MANY_MEMBERS';
        err.params = { limit: maxMembers, members };
        throw err;
      }

      if (symlinkNames.size > 0) {
        const segs = cls.name.split('/');
        for (let i = 1; i < segs.length; i++) {
          if (symlinkNames.has(segs.slice(0, i).join('/'))) {
            throw new Error(`归档成员位于符号链接之下（解压时可能写到归档之外）: ${cls.name.slice(0, 120)}`);
          }
        }
      }

      if (cls.type === 'hardlink') {
        const target = cls.linkTarget ? cls.linkTarget.replace(/\/+$/, '') : null;
        if (target && symlinkNames.has(target) && symlinkNames.size < MAX_TRACKED_SYMLINK_MEMBERS) {
          symlinkNames.add(cls.name.replace(/\/+$/, ''));
        }
        hardLinks += 1;
      } else if (cls.type === 'symlink') {
        if (symlinkNames.size >= MAX_TRACKED_SYMLINK_MEMBERS) {
          throw new Error(`归档符号链接成员过多（> ${MAX_TRACKED_SYMLINK_MEMBERS}），无法安全校验`);
        }
        symlinkNames.add(cls.name.replace(/\/+$/, ''));
        symLinks += 1;
      }
    };

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      listingBytes += chunk.length;
      if (listingBytes > maxListingBytes) {
        return fail(new Error(`归档清单输出异常增大（已读 ${listingBytes} 字节 > ${maxListingBytes} 字节），已中止校验`));
      }
      pending += decoder.write(chunk);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > MAX_LISTING_LINE_BYTES) {
          return fail(new Error(`归档成员行异常过长（${line.length} 字节），无法安全解析`));
        }
        try {
          handleLine(line);
        } catch (e) {
          return fail(e);
        }
      }
      if (pending.length > MAX_LISTING_LINE_BYTES) {
        return fail(new Error(`归档成员行异常过长（>${MAX_LISTING_LINE_BYTES} 字节），无法安全解析`));
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length >= 8192) return;
      stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });

    child.on('error', (err) => fail(new Error('无法启动 tar 校验归档: ' + err.message)));

    child.on('close', (code) => {
      if (settled) return;
      pending += decoder.end();
      if (pending) {
        try {
          handleLine(pending);
        } catch (e) {
          return fail(e);
        }
      }
      if (code !== 0) {
        return fail(new Error('归档文件损坏或不是合法的 tar.gz 文件: ' + (stderr.trim() || `tar 退出码 ${code}`)));
      }
      if (members === 0) {
        const err = new Error('归档内容为空');
        err.errorCode = 'SNAPSHOT_EMPTY_ARCHIVE';
        return fail(err);
      }
      succeed({ members, listingBytes, hardLinks, symLinks });
    });
  });
}

module.exports = {
  DATA_ENTRIES,
  ALLOWED_ARCHIVE_PREFIX,
  ALLOWED_LINK_PREFIXES,
  LINK_SEPARATORS,
  LEGACY_DSH_DIR,
  ARCHIVE_ROOT_BASES,
  ARCHIVE_ROOT_ABS_PREFIXES,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  toPosix,
  getLegacyDshDir,
  getArchiveRootBases,
  getArchiveRootAbsPrefixes,
  verifyGzipMagic,
  hasPigz,
  getPigzThreads,
  buildTarEnv,
  runTarAsync,
  normalizeArchiveMemberPrefix,
  assertSafeMemberPath,
  isAllowedAbsoluteLinkTarget,
  isAllowedSymlinkTarget,
  splitLinkMember,
  classifyArchiveMemberLine,
  validateArchiveMembers
};
