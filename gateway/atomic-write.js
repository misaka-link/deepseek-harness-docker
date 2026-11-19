/**
 * 原子写工具（Issue #18 同类问题的收口）。
 *
 * 背景：本项目里凡是「先截断再写」的文件，一旦进程在写入途中被杀（SIGKILL / OOM / 容器 stop），
 * 就会留下半截内容。对源码是 SyntaxError，对 JSON 配置是解析失败，对密钥是**静默变短**。
 * 而读取端往往只是 `try { JSON.parse } catch { return {} }` —— 于是「写坏了」被伪装成「没配过」，
 * 用户看到的是「配置/登录态莫名丢失」，比直接报错更难排查。
 *
 * 本模块只做一件事：临时文件写完后 rename 原子替换，任何时刻读者看到的都是完整旧文件或完整新文件。
 * 权限位在 rename 前设好，避免「先 0644 后 chmod」的窗口内被同容器其它用户读到敏感内容。
 *
 * @module atomic-write
 */

const fs = require('fs');
const path = require('path');

/**
 * 同步原子写。
 * @param {string} file 目标文件
 * @param {string|Buffer} data 内容
 * @param {{mode?: number, encoding?: string}} [options]
 */
function writeFileAtomicSync(file, data, options = {}) {
  const dir = path.dirname(file);
  const mode = Number.isInteger(options.mode) ? options.mode : 0o644;
  const encoding = options.encoding || 'utf8';
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid);
  try {
    fs.writeFileSync(tmp, data, { encoding, mode });
    try { fs.chmodSync(tmp, mode); } catch {}
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

module.exports = { writeFileAtomicSync };
