const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const {
  readSidecar,
  writeSidecarAtomic,
  removeSidecar
} = require('./snapshot-manifest');

const SNAPSHOTS_DIR = process.env.DSH_SNAPSHOTS_DIR || '/root/.dsh-snapshots';
// M11：支持通过 DSH_HOME 迁移运行根目录（非 root 部署时指向 /home/<user>）
const DSH_DIR = path.join(process.env.DSH_HOME || '/root', '.dsh');
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB

function getCurrentDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  try {
    const vMeta = JSON.parse(fs.readFileSync(path.join(__dirname, '../version.json'), 'utf8'));
    if (vMeta?.supply?.dshVersion) return vMeta.supply.dshVersion;
  } catch {}
  return '0.1.7-rc.2';
}

function getCurrentProjectVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  return '0.1.9';
}

try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch {}

let activeTask = null; // { type: 'backup'|'restore'|'import', label: string, startedAt: number }

function isBusy() {
  return activeTask !== null;
}

function getActiveTask() {
  return activeTask;
}

function sanitizeName(name) {
  return (name || 'manual').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function verifyGzipMagic(headerBuffer) {
  if (!headerBuffer || headerBuffer.length < 2) return false;
  return headerBuffer[0] === 0x1f && headerBuffer[1] === 0x8b;
}

function hasPigz() {
  try {
    const res = spawnSync('which', ['pigz'], { encoding: 'utf8' });
    return res.status === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 异步执行 tar 命令，完全解耦 Node.js 主事件循环
 *
 * ⚠️ 本函数的 maxOutputBytes 只是「防止子进程吐出海量文本把父进程内存打满」的资源兜底，
 * **不能**用来判定归档是否可信：合法快照的成员清单会随使用量无上限增长。
 * 需要逐成员校验的场合（restore / import）请用 validateArchiveMembers()——它按行流式解析，
 * 不设字节硬上限，因此不会误杀大快照（Issue #8）。
 */
function runTarAsync(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10 * 60 * 1000;
  // 给「捕获完整 stderr 用于报错」留足余量；真正的安全判定不依赖这个值
  const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : 64 * 1024 * 1024;
  const spawnOptions = { ...options };
  delete spawnOptions.timeoutMs;
  delete spawnOptions.maxOutputBytes;

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
    child.stdout.on('data', d => onData(d, false));
    child.stderr.on('data', d => onData(d, true));

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// 本服务创建的快照一律以 `tar -cf <file> -C /root .dsh` 打包，因此成员必须全部位于 `.dsh/` 之下。
const ALLOWED_ARCHIVE_PREFIX = '.dsh';
// 快照里 node_modules 下的软链会指向这些依赖安装位置（install-plugin.mjs / pnpm 产生），属合法目标
const ALLOWED_LINK_PREFIXES = [
  '/usr/local/lib/node_modules/',
  '/usr/lib/node_modules/',
  '/app/plugins/',
  '/app/node_modules/',
  '/opt/'
];

// ── 归档校验（validateArchiveMembers）的资源上限 ──────────────────────────────
// Issue #8 教训：**不能用「tar 清单输出字节数」去判定归档是否可信**。
// 合法快照的成员数会随插件依赖、会话与附件持续增长（实测约 138~160 字节/成员），
// v0.1.4~v0.1.9 用写死的 8 MiB 清单上限，使成员数超过约 5~6 万的正常快照被误判为「恶意/损坏」。
// 现在改为「按行流式解析 + 只限制成员数」，内存 O(1)，上限宽松到不会误伤真实大快照。
const DEFAULT_MAX_ARCHIVE_MEMBERS = Number(process.env.DSH_MAX_ARCHIVE_MEMBERS) > 0
  ? Number(process.env.DSH_MAX_ARCHIVE_MEMBERS)
  : 1000 * 1000;
// 单行长度兜底：`tar -tv` 一行不会超过「PATH_MAX + 元数据」，超长说明输出已不可信
const MAX_LISTING_LINE_BYTES = 64 * 1024;
// 清单总字节兜底：仅用于兜住「tar 疯狂吐垃圾」的极端情况（流式解析本身不占内存）
const DEFAULT_MAX_LISTING_BYTES = 512 * 1024 * 1024;
// 链接成员的分隔文案：符号链接是 ` -> `（不本地化）；硬链接是本地化字符串。
// 这里固定 spawn 的 LC_ALL=C，同时兼容 zh_CN 的 ` 连接到 `，避免再被 locale 咬一次。
const LINK_SEPARATORS = [' -> ', ' link to ', ' 连接到 '];
// 允许作为符号链接绝对目标前缀的「归档根」：快照里真实存在
// `.dsh-module-fallback/node_modules/<pkg> -> <home>/.dsh/profiles/web/node_modules/<pkg>` 这类软链，
// 其目标仍在被还原的树内，属合法成员（旧实现会整包拒收 → 老快照永远还原不了）。
// 第 1 项 = 本次运行的 DSH home；第 2 项 = 「默认部署根」下的 .dsh，
// 用于「从默认 root 部署迁移到自定义 DSH_HOME（非 root 部署）」后仍能还原旧快照；
// 与 DSH_DIR 同样从 env 派生（可用 DSH_LEGACY_HOME 覆盖），不写死具体 home。
const LEGACY_DSH_DIR = path.join(process.env.DSH_LEGACY_HOME || '/root', '.dsh');
const ARCHIVE_ROOT_ABS_PREFIXES = Array.from(new Set([DSH_DIR + '/', LEGACY_DSH_DIR + '/']));
// 纵深防御：追踪符号链接成员，拒绝任何位于符号链接之下的成员
// （GNU tar 解压时会拒绝这种写法，但白名单不该依赖下游行为）；
// 同时给追踪集合一个上限，避免病态归档用海量软链把内存顶爆。
const MAX_TRACKED_SYMLINK_MEMBERS = 100 * 1000;

/**
 * 校验归档成员路径是否合法（必须位于 `.dsh/` 之下且不含 `..` / `.` / 空段）。
 * @param {string} memberPath 归档内成员名
 * @param {string} who 报错时的主语（如「归档成员」「归档硬链接目标」）
 */
function assertSafeMemberPath(memberPath, who) {
  const clean = memberPath.replace(/\/+$/, '');
  if (clean !== ALLOWED_ARCHIVE_PREFIX && !clean.startsWith(ALLOWED_ARCHIVE_PREFIX + '/')) {
    throw new Error(`${who}超出允许范围（仅允许 ${ALLOWED_ARCHIVE_PREFIX}/ 之下）: ${String(memberPath).slice(0, 120)}`);
  }
  const segs = clean.split('/');
  if (segs.some(s => s === '..' || s === '.' || s === '')) {
    throw new Error(`${who}包含非法路径段: ${String(memberPath).slice(0, 120)}`);
  }
}

/**
 * 符号链接目标是否受控。
 *  - 相对目标：归一化后必须仍在 `.dsh/` 之内；
 *  - 绝对目标：**先归一化再比对前缀**（否则 `/opt/../etc/passwd` 这类目标能用 `startsWith`
 *    骗过白名单），允许指向本项目合法的依赖安装位置，也允许指向**本归档自身的根**
 *    （`$DSH_HOME/.dsh`）——目标仍在被还原的树内，且剩余部分仍按成员路径校验。
 */
function isAllowedSymlinkTarget(memberName, linkTarget) {
  if (!linkTarget.startsWith('/')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(memberName), linkTarget))
      .startsWith(ALLOWED_ARCHIVE_PREFIX + '/');
  }
  const normalized = path.posix.normalize(linkTarget);
  if (!normalized.startsWith('/')) return false;
  if (ALLOWED_LINK_PREFIXES.some(p => normalized.startsWith(p))) return true;
  for (const root of ARCHIVE_ROOT_ABS_PREFIXES) {
    if (!normalized.startsWith(root)) continue;
    const rel = normalized.slice(root.length);
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

/**
 * 从 `tar -tv` 的成员名正文里切出「名字 + 链接目标」。
 *
 * ⚠️ 分隔符（` -> ` / ` link to ` / ` 连接到 `）是 tar 自己插入的普通文本，
 * 而成员名或目标本身**也可能包含同样的字符串**——此时单行文本无法无歧义切分。
 * 旧实现取「第一个」分隔符，会被 `.dsh/leak -> dummy -> /etc/passwd`
 * 这类构造欺骗（名字被截断、真正的绝对目标被当成相对路径放行）。
 * 因此这里改为：**出现多于一个分隔符就直接 fail-closed**（真实快照的成员名不含这些串）。
 */
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

/** 解析 `tar -tvzf` 的一行；非法成员直接抛错（fail-closed）。 */
function classifyArchiveMemberLine(rawLine) {
  const line = rawLine.replace(/\s+$/, '');
  if (!line) return null;

  const parts = line.trim().split(/\s+/);
  // `-rw-r--r-- owner/group size date time name`
  if (parts.length < 6) throw new Error(`无法解析归档成员: ${line.slice(0, 120)}`);

  const typeChar = parts[0][0];
  const rawName = parts.slice(5).join(' ');
  const isLink = typeChar === 'l' || typeChar === 'h';

  // 只有链接成员才做分隔符切分：普通成员名里若恰好含有 ` -> ` / ` link to `，
  // 切分会把真实名字截断，从而可能**漏掉**名字后半段的 `..` 段。
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

  if (isLink) {
    if (!linkTarget) {
      const kind = typeChar === 'h' ? '硬' : '符号';
      throw new Error(`归档${kind}链接成员缺少目标（tar 输出格式无法识别）: ${name.slice(0, 120)}`);
    }
    assertSafeMemberPath(name, '归档链接成员');
    // 归档根目录本身必须是目录，绝不能是链接成员：否则解压后 `.dsh` 会变成一个指向别处的软链，
    // 而 restoreBackup 随后的「把 gateway.config.json 拷进 staging」等步骤会顺着它写出去。
    if (name.replace(/\/+$/, '') === ALLOWED_ARCHIVE_PREFIX) {
      throw new Error(`归档根目录 ${ALLOWED_ARCHIVE_PREFIX} 不得是链接成员: ${name.slice(0, 120)}`);
    }
    if (typeChar === 'h') {
      // 硬链接的目标是「归档内已存在的成员」，把它当作普通成员名同样校验：
      // 若目标逃出 `.dsh/` 或含 `..`，解压时可能被引导到归档之外。
      assertSafeMemberPath(linkTarget, '归档硬链接目标');
      return { type: 'hardlink', name, linkTarget };
    }
    if (!isAllowedSymlinkTarget(name, linkTarget)) {
      throw new Error(`归档包含指向不允许位置的链接成员: ${name.slice(0, 60)} -> ${String(linkTarget).slice(0, 60)}`);
    }
    return { type: 'symlink', name };
  }

  if (typeChar !== '-' && typeChar !== 'd') {
    throw new Error(`归档包含不允许的成员类型 (${typeChar})，仅允许普通文件、目录与受控链接: ${name.slice(0, 120)}`);
  }
  assertSafeMemberPath(name, '归档成员');
  return { type: typeChar === 'd' ? 'dir' : 'file', name };
}

/**
 * 归档成员白名单校验（在解压/转正之前调用）。
 *
 * 阻断：绝对路径、`..` 段、超出 `.dsh/` 前缀的成员（如 `.ssh/authorized_keys`、`.bashrc`），
 * 以及设备 / FIFO 等非普通文件成员（防止解压时写到目录外）。
 * 允许：普通文件 / 目录 / 符号链接（目标受限）/ 硬链接（目标必须仍是归档内的 `.dsh/` 成员）。
 * 失败即抛错，调用方不会执行任何解压动作（fail-closed）。
 *
 * 实现要点（Issue #8 修复）：
 *  1. **按行流式解析** `tar -tvzf` 的 stdout，不再把整份清单缓冲进内存，也不再设字节数硬上限；
 *     限制改为「成员数」，宽到不会误伤合法大快照（旧实现 8 MiB 上限会把 ≥5~6 万成员的正常快照判为损坏）。
 *  2. spawn 时强制 `LC_ALL=C`：GNU tar 对硬链接打印的是本地化文案（C: ` link to ` / zh_CN: ` 连接到 `），
 *     而旧代码只认符号链接的 ` -> `，导致**任何含硬链接的合法快照**都被误判为「链接成员缺少目标」。
 *  3. 报错文案不再把「规模超限」说成「文件已损坏」，并在错误里带上实际计数，便于排障。
 *
 * @param {string} archivePath 归档路径
 * @param {object} [opts] { maxMembers, maxListingBytes, timeoutMs }
 * @returns {Promise<{members:number, listingBytes:number, hardLinks:number, symLinks:number}>}
 */
function validateArchiveMembers(archivePath, opts = {}) {
  const maxMembers = Number(opts.maxMembers) > 0 ? Number(opts.maxMembers) : DEFAULT_MAX_ARCHIVE_MEMBERS;
  const maxListingBytes = Number(opts.maxListingBytes) > 0 ? Number(opts.maxListingBytes) : DEFAULT_MAX_LISTING_BYTES;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['--numeric-owner', '-tvzf', archivePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' }
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
    // 符号链接成员名 → 用于「成员不得位于符号链接之下」的纵深防御
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
        // 这里是「规模」而不是「损坏」：文案必须让用户能分辨，并给出明确的自救路径
        throw new Error(
          `归档成员数超过上限（${members} > ${maxMembers}），已中止校验。` +
          `该归档可能是合法但异常庞大的快照；如确认可信，请提高上限（环境变量 DSH_MAX_ARCHIVE_MEMBERS）或改用「仅配置」快照后重试。`
        );
      }

      // 纵深防御：任何成员的祖先路径都不能是符号链接成员。
      // GNU tar 解压时会拒绝这种写法（"无法 open: 不是目录"），但白名单不该把安全性
      // 完全外包给下游，否则一旦换成其它解压实现就会出现写入树外的窗口。
      if (symlinkNames.size > 0) {
        const segs = cls.name.split('/');
        // 从 i=1 起算：连 `.dsh` 自身也比对一次（根成员是链接已被上面直接拒掉，这里是第二道保险）
        for (let i = 1; i < segs.length; i++) {
          if (symlinkNames.has(segs.slice(0, i).join('/'))) {
            throw new Error(`归档成员位于符号链接之下（解压时可能写到归档之外）: ${cls.name.slice(0, 120)}`);
          }
        }
      }

      if (cls.type === 'hardlink') {
        // 指向符号链接的硬链接会「继承」符号链接语义；不登记的话，
        // `.dsh/sym`（软链）→ `.dsh/h4 link to .dsh/sym` → `.dsh/h4/evil` 会绕过后面的祖先检查。
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
        return fail(new Error(
          `归档清单输出异常增大（已读 ${listingBytes} 字节 > ${maxListingBytes} 字节兜底上限），已中止校验`
        ));
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

    // stderr 只保留前 8 KiB 用于报错，避免坏归档吐垃圾把内存打满
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
      if (members === 0) return fail(new Error('归档内容为空'));
      succeed({ members, listingBytes, hardLinks, symLinks });
    });
  });
}

/**
 * 异步非阻塞创建配置快照
 * @param {string|object} nameOrOpts - 快照备注名或参数对象 { name, type }
 * @param {string} [backupType='full'] - 备份类型: 'full' (完整备份) 或 'config' (仅配置无会话)
 */
async function createBackup(nameOrOpts = '', backupType = 'full') {
  if (activeTask) {
    throw new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`);
  }

  let name = '';
  let type = 'full';
  if (typeof nameOrOpts === 'object' && nameOrOpts !== null) {
    name = nameOrOpts.name || '';
    type = nameOrOpts.type || nameOrOpts.backupType || 'full';
  } else {
    name = nameOrOpts || '';
    type = backupType || 'full';
  }

  const isConfigOnly = type === 'config';
  const safeName = sanitizeName(name);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = isConfigOnly
    ? `dsh-config-${ts}-${safeName}.tar.gz`
    : `dsh-snapshot-${ts}-${safeName}.tar.gz`;
  const finalPath = path.join(SNAPSHOTS_DIR, filename);
  const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

  const taskDesc = isConfigOnly ? '仅配置快照(无会话)' : '完整快照';
  activeTask = { type: 'backup', label: `创建${taskDesc}`, startedAt: Date.now() };

  console.log(`[backup-service] 开始异步创建${taskDesc}: ${filename}...`);

  try {
    // 排除庞大且不影响配置的临时与缓存目录，极大提升打包速度
    const isMultiThread = hasPigz();
    if (isMultiThread) {
      console.log('[backup-service] 检测到 pigz，已启用全核心多线程并行压缩加速');
    }

    const tarArgs = [
      '--warning=no-file-changed',
      '--exclude=.dsh/.pnpm-store',
      '--exclude=**/node_modules/.cache',
      '--exclude=.dsh/tmp',
      '--exclude=.dsh/gateway.config.json'
    ];

    // 仅配置模式：完全排除所有对话会话历史、多媒体附件及会话投影缓存，仅保留配置、模型凭据与插件
    if (isConfigOnly) {
      tarArgs.push(
        '--exclude=.dsh/sessions',
        '--exclude=.dsh/attachments',
        '--exclude=.dsh/storages/session_projcache',
        '--exclude=.dsh/storages/session_projcache_archive_manager_v2'
      );
    }

    if (isMultiThread) {
      tarArgs.push('-I', 'pigz');
    } else {
      tarArgs.push('-z');
    }

    tarArgs.push('-cf', tmpPath, '-C', '/root', '.dsh');

    const res = await runTarAsync(tarArgs);

    // tar 非零退出码说明归档不完整（读错误 / 权限跳过等），绝不能当作有效快照转正
    if (res.code !== 0) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`tar 打包失败 (exit=${res.code}): ${String(res.stderr || '').slice(0, 300)}`);
    }

    if (!fs.existsSync(tmpPath)) {
      throw new Error('快照文件未成功生成: ' + (res.stderr || 'tar 执行失败'));
    }

    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error('生成的快照文件大小为 0，已被清理');
    }

    // 原子重命名
    fs.renameSync(tmpPath, finalPath);
    console.log(`[backup-service] ${taskDesc}创建成功: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    const dshVersion = getCurrentDshVersion();
    const projectVersion = getCurrentProjectVersion();
    try {
      writeSidecarAtomic(SNAPSHOTS_DIR, filename, {
        meta: {
          dshVersion,
          projectVersion,
          dockerSuiteVersion: projectVersion,
          schemaVersion: 2,
          configModel: 'patch-layer',
          backupType: isConfigOnly ? 'config' : 'full',
          createdAt: stat.mtime.toISOString(),
          name: safeName
        },
        archive: {
          sizeBytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs)
        }
      });
    } catch (e) {
      console.warn('[backup-service] 写入快照元数据 sidecar 失败:', e.message);
    }

    return {
      ok: true,
      snapshot: {
        filename,
        type: isConfigOnly ? 'config' : 'full',
        typeLabel: isConfigOnly ? '仅配置 (无会话)' : '完整备份',
        sizeBytes: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        createdAt: stat.mtime.toISOString(),
        dshVersion,
        projectVersion,
        name: safeName
      }
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    console.error(`[backup-service] ${taskDesc}创建失败:`, err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * 异步非阻塞恢复配置快照
 */
async function restoreBackup(filename, dshManager) {
  if (activeTask) {
    throw new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`);
  }

  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    throw new Error('非法快照文件名');
  }

  const snapshotPath = path.join(SNAPSHOTS_DIR, safeFilename);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error('快照文件不存在: ' + safeFilename);
  }

  activeTask = { type: 'restore', label: '恢复快照', startedAt: Date.now() };
  console.log(`[backup-service] 开始安全还原快照: ${safeFilename}...`);

  let rollbackRoot = null; // 还原前的配置回滚点（供失败时回滚）
  try {
    // 1. 预先校验快照完整性 + 成员白名单，防损坏/恶意归档破坏现有环境
    await validateArchiveMembers(snapshotPath);

    // 2. 优雅停止 DSH 并彻底清理可能占用端口的外部孤儿进程
    if (dshManager && typeof dshManager.stop === 'function') {
      await dshManager.stop();
    }
    try { spawnSync('fuser', ['-k', '-9', `${DSH_PORT}/tcp`], { stdio: 'ignore' }); } catch {}
    try {
      const psOut = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
      if (psOut.status === 0 && psOut.stdout) {
        for (const line of psOut.stdout.split('\n')) {
          if (/dsh\s+web|dsh-market-restart/i.test(line)) {
            const m = line.trim().match(/^(\d+)/);
            if (m && Number(m[1]) !== process.pid) {
              try { process.kill(Number(m[1]), 'SIGKILL'); } catch {}
            }
          }
        }
      }
    } catch {}

    // 3. 解压到独立 staging 目录（完全不触碰现网），校验通过后再原子切换
    // 注意：/root/.dsh 是挂载卷，跨设备 rename 会 EXDEV，
    // 因此 staging 与回滚点都必须放在该卷内部（同设备），并在切换时跳过这两个名字。
    const stagingRoot = path.join(DSH_DIR, '.restore-staging');
    rollbackRoot = path.join(DSH_DIR, '.restore-rollback');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    const isMultiThread = hasPigz();
    const extractArgs = ['--warning=no-file-changed', '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir'];
    if (isMultiThread) {
      extractArgs.push('-I', 'pigz');
    } else {
      extractArgs.push('-z');
    }
    extractArgs.push('-xf', snapshotPath, '-C', stagingRoot);
    const extractRes = await runTarAsync(extractArgs);
    if (extractRes.code !== 0) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('tar 解压到 staging 失败（现网未受影响）: ' + (extractRes.stderr || '未知错误'));
    }

    const stagedDsh = path.join(stagingRoot, '.dsh');
    if (!fs.existsSync(stagedDsh)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error('快照内容异常：未找到 .dsh 目录，已中止（现网未受影响）');
    }
    // 快照刻意排除了网关自有的 gateway.config.json（含 authToken）与 .session_secret，这里从现网带过去
    for (const keep of ['gateway.config.json', '.session_secret']) {
      const cur = path.join(DSH_DIR, keep);
      if (fs.existsSync(cur)) { try { fs.copyFileSync(cur, path.join(stagedDsh, keep)); } catch {} }
    }

    // 4. 原子切换：注意 /root/.dsh 是 Docker 卷挂载点，整体 rename 会 EBUSY，
    //    因此改为"逐子项搬移"——现网内容先搬到回滚点，再把 staging 内容搬入。
    const SKIP = new Set(['.restore-staging', '.restore-rollback']);
    const moveChildren = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        if (SKIP.has(entry)) continue;
        fs.renameSync(path.join(from, entry), path.join(to, entry));
      }
    };
    const clearDir = (dir) => {
      for (const entry of fs.readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    };
    try {
      moveChildren(DSH_DIR, rollbackRoot); // 现网 → 回滚点
      moveChildren(stagedDsh, DSH_DIR);    // staging → 现网
      console.log(`[backup-service] 配置已原子切换（旧配置备份于 ${rollbackRoot}，成功后自动清理）`);
    } catch (switchErr) {
      try {
        clearDir(DSH_DIR);
        moveChildren(rollbackRoot, DSH_DIR);
      } catch (rb) {
        console.error('[backup-service] 切换失败后的即时回滚异常:', rb.message);
      }
      throw new Error('配置切换失败，已回滚到原配置: ' + switchErr.message);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }

    const webProfileDir = path.join(DSH_DIR, 'profiles', 'web');

    // 5. 若解压后 node_modules 为空（轻量清单备份），自动依据 package.json 补全
    const targetNodeModules = path.join(webProfileDir, 'node_modules');
    const targetPkgJson = path.join(webProfileDir, 'package.json');
    if (fs.existsSync(targetPkgJson) && (!fs.existsSync(targetNodeModules) || fs.readdirSync(targetNodeModules).length === 0)) {
      console.log('[backup-service] 检测到快照未包含完整的 node_modules，正在通过 pnpm 自动补全依赖...');
      await new Promise(resolve => {
        const pnpmInstall = spawn('pnpm', ['install', '--no-frozen-lockfile'], {
          cwd: webProfileDir,
          stdio: 'ignore'
        });
        pnpmInstall.on('close', resolve);
        pnpmInstall.on('error', resolve);
      });
    }

    // 6. 执行权限自愈与补丁
    try {
      if (fs.existsSync(DSH_DIR)) fs.chmodSync(DSH_DIR, 0o700);
      const credPath = path.join(DSH_DIR, '.credentials.yaml');
      if (fs.existsSync(credPath)) fs.chmodSync(credPath, 0o600);
    } catch {}

    if (fs.existsSync('/app/scripts/install-plugin.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/install-plugin.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }
    if (fs.existsSync('/app/scripts/patch-dsh-client.mjs')) {
      await new Promise(r => {
        const c = spawn('node', ['/app/scripts/patch-dsh-client.mjs'], { stdio: 'ignore' });
        c.on('close', r);
      });
    }

    // 7. 重新拉起 DSH 并真实验证就绪状态
    let dshReady = false;
    if (dshManager && typeof dshManager.boot === 'function') {
      const bootRes = await dshManager.boot();
      dshReady = bootRes.ok === true;
      if (!dshReady) {
        throw new Error('快照解压完成，但 DSH 启动超时或未能成功就绪，请在终端查看日志');
      }
    }

    // 成功：清理回滚点
    try { fs.rmSync(rollbackRoot, { recursive: true, force: true }); } catch {}
    console.log(`[backup-service] 快照 ${safeFilename} 还原完成，DSH 服务就绪状态: ${dshReady}`);
    return { ok: true, filename: safeFilename, dshReady };
  } catch (err) {
    // 失败：若已切换过且回滚点仍在，尽力恢复还原前的配置并重新拉起
    try {
      if (rollbackRoot && fs.existsSync(rollbackRoot)) {
        console.warn('[backup-service] 还原失败，正在回滚到还原前的配置...');
        const skip = new Set(['.restore-staging', '.restore-rollback']);
        for (const entry of fs.readdirSync(DSH_DIR)) {
          if (skip.has(entry)) continue;
          fs.rmSync(path.join(DSH_DIR, entry), { recursive: true, force: true });
        }
        for (const entry of fs.readdirSync(rollbackRoot)) {
          fs.renameSync(path.join(rollbackRoot, entry), path.join(DSH_DIR, entry));
        }
        if (dshManager && typeof dshManager.boot === 'function') {
          await dshManager.boot().catch(() => {});
        }
        console.log('[backup-service] 已回滚到还原前的配置');
      }
    } catch (rbErr) {
      console.error('[backup-service] 回滚失败:', rbErr.message);
    }
    console.error('[backup-service] 快照还原异常:', err.message);
    throw err;
  } finally {
    activeTask = null;
  }
}

/**
 * 异步流式接收导入快照文件 (.tar.gz)
 */
function importBackupStream(req, rawFilename) {
  // 反模式修复：原 `new Promise(async executor)` 中任何抛出都会变成未处理的 rejection，
  // 导致该 Promise 永不 settle。改为「同步 executor + 异步实现函数」，异常统一走 reject。
  return new Promise((resolve, reject) => {
    // 同理：只用 catch 兜住实现函数抛出的异常，不采用其返回值（实现函数会自行 resolve/reject）
    Promise.resolve()
      .then(() => importBackupStreamImpl(req, rawFilename, resolve, reject))
      .catch(reject);
  });
}

async function importBackupStreamImpl(req, rawFilename, resolve, reject) {
    if (activeTask) {
      return reject(new Error(`当前正在执行 ${activeTask.label} 操作，请稍候再试`));
    }

    const origName = path.basename(rawFilename || 'imported-snapshot.tar.gz');
    const safeBase = sanitizeName(origName.replace(/\.tar\.gz$/i, ''));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `dsh-snapshot-${ts}-imported_${safeBase}.tar.gz`;
    const finalPath = path.join(SNAPSHOTS_DIR, filename);
    const tmpPath = path.join(SNAPSHOTS_DIR, `.${filename}.tmp`);

    activeTask = { type: 'import', label: '导入快照', startedAt: Date.now() };
    console.log(`[backup-service] 接收流式上传导入快照: ${filename}...`);

    const outStream = fs.createWriteStream(tmpPath);
    // 磁盘写满 / 权限变化时 WriteStream 会 emit 'error'，无监听即为未捕获异常 → 整个网关退出
    outStream.on('error', (e) => {
      aborted = true;
      try { req.destroy(); } catch {}
      cleanup();
      reject(new Error('写入快照文件失败: ' + e.message));
    });
    let totalBytes = 0;
    let headerBytes = Buffer.alloc(0);
    let headerChecked = false;
    let aborted = false;

    const cleanup = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      activeTask = null;
    };

    req.on('data', chunk => {
      if (aborted) return;
      totalBytes += chunk.length;

      // 检查大小上限
      if (totalBytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        req.destroy();
        outStream.destroy();
        cleanup();
        return reject(new Error('上传文件超过大小限制 (最大 300MB)'));
      }

      // 快速检查 Gzip 魔数 (1f 8b)
      if (!headerChecked) {
        headerBytes = Buffer.concat([headerBytes, chunk]);
        if (headerBytes.length >= 2) {
          headerChecked = true;
          if (!verifyGzipMagic(headerBytes)) {
            aborted = true;
            req.destroy();
            outStream.destroy();
            cleanup();
            return reject(new Error('无效的文件格式，仅支持 .tar.gz 压缩归档'));
          }
        }
      }

      outStream.write(chunk);
    });

    req.on('error', err => {
      aborted = true;
      outStream.destroy();
      cleanup();
      reject(err);
    });

    req.on('end', async () => {
      if (aborted) return;
      outStream.end();
      outStream.on('finish', async () => {
        try {
          if (totalBytes < 100) {
            cleanup();
            return reject(new Error('上传文件为空或数据不完整'));
          }

          // 归档完整性 + 成员白名单二次校验（不合法则丢弃，不转正）
          await validateArchiveMembers(tmpPath);

          // 原子更名转正
          fs.renameSync(tmpPath, finalPath);
          const stat = fs.statSync(finalPath);
          console.log(`[backup-service] 成功导入快照: ${filename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

          resolve({
            ok: true,
            snapshot: {
              filename,
              sizeBytes: stat.size,
              sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
              createdAt: stat.mtime.toISOString(),
              name: safeBase
            }
          });
        } catch (verErr) {
          cleanup();
          reject(verErr);
        } finally {
          activeTask = null;
        }
      });
    });
}

function listBackups() {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.tar.gz') && !f.startsWith('.'));
    const list = files.map(filename => {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, filename);
        const stat = fs.statSync(filePath);
        const isConfig = filename.startsWith('dsh-config-') || filename.includes('-config-') || filename.includes('_config_');
        let dshVersion = null;
        let projectVersion = null;
        let configModel = null;
        try {
          const sc = readSidecar(SNAPSHOTS_DIR, filename);
          if (sc && sc.meta) {
            dshVersion = sc.meta.dshVersion || null;
            projectVersion = sc.meta.projectVersion || sc.meta.dockerSuiteVersion || null;
            configModel = sc.meta.configModel || null;
          }
        } catch {}
        return {
          filename,
          type: isConfig ? 'config' : 'full',
          typeLabel: isConfig ? '仅配置 (无会话)' : '完整备份',
          sizeBytes: stat.size,
          sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
          createdAt: stat.mtime.toISOString(),
          dshVersion,
          projectVersion,
          configModel
        };
      } catch {
        return null;
      }
    }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return {
      ok: true,
      snapshots: list,
      activeTask: getActiveTask()
    };
  } catch (err) {
    return { ok: false, error: err.message, snapshots: [], activeTask: getActiveTask() };
  }
}

function deleteBackup(filename) {
  try {
    const safeFilename = path.basename(filename || '');
    if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
      return { ok: false, error: '非法文件名' };
    }
    const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      try { removeSidecar(SNAPSHOTS_DIR, safeFilename); } catch {}
      return { ok: true };
    }
    return { ok: false, error: '快照文件不存在' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getBackupPath(filename) {
  const safeFilename = path.basename(filename || '');
  if (!safeFilename.endsWith('.tar.gz') || safeFilename.includes('..')) {
    return null;
  }
  const filePath = path.join(SNAPSHOTS_DIR, safeFilename);
  return fs.existsSync(filePath) ? filePath : null;
}

module.exports = {
  createBackup,
  restoreBackup,
  importBackupStream,
  listBackups,
  deleteBackup,
  getBackupPath,
  getActiveTask,
  isBusy,
  validateArchiveMembers,
  // 供回归测试直接做单元级断言（解析单行 / 单条路径）
  classifyArchiveMemberLine,
  assertSafeMemberPath,
  runTarAsync,
  SNAPSHOTS_DIR
};
