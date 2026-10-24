#!/usr/bin/env node
/**
 * Issue #11: 运行时依赖瘦身脚本 (C 档裁剪)
 *
 * 用法:
 *   node scripts/prune-runtime-deps.mjs --root <node_modules 绝对路径> --level mini|full [--dry-run] [--json]
 *
 * 契约规则:
 *   1. 纯 Node.js 标准库实现，无外部依赖
 *   2. 严格路径白名单：--root 必须是绝对路径且包含 'node_modules'
 *   3. 仅 mini 变体执行裁剪；full 变体不做任何删除，返回 0 退出码
 *   4. mini 裁剪目标:
 *      - *.map（源码映射文件）
 *      - *.d.ts, *.d.mts, *.d.cts（TypeScript 类型声明文件）
 *      - 目录 test|tests|__tests__|docs|examples（包内测试与文档目录）
 *      - prebuilds/ 下非 linux-x64/linux-arm64 子目录（跨平台原生预编译包）
 *      - libreoffice-kit-wasm 的 assets/*（Office 渲染 wasm 资源，保留外壳）
 *      - 目录 sherpa-onnx-* 的 *.so 与 lib/（本地语音模型原生库，保留外壳）
 *   5. 严格保护（绝不删除）:
 *      - package.json
 *      - index.js
 *      - *.node 原生模块
 *      - lib/*.js 核心库代码
 *   6. 幂等性：重复执行不报错、不抛异常
 *   7. dry-run 模式：仅统计计算可释放字节数，不执行实际删除
 *   8. 单点异常不中断整体遍历流程
 *   9. 结束打印:「[prune-runtime-deps] 释放 X MB，用时 Ys」，退出码 0
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── 参数解析与校验 ─────────────────────────────────────────────────────────

let rootDir = null;
let level = null;
let dryRun = false;
let jsonOutput = false;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--root') {
    rootDir = process.argv[++i];
  } else if (arg.startsWith('--root=')) {
    rootDir = arg.slice('--root='.length);
  } else if (arg === '--level') {
    level = process.argv[++i];
  } else if (arg.startsWith('--level=')) {
    level = arg.slice('--level='.length);
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--json') {
    jsonOutput = true;
  }
}

if (!rootDir) {
  console.error('[prune-runtime-deps] 错误: 必须通过 --root 指定目标路径');
  process.exit(1);
}

if (!path.isAbsolute(rootDir)) {
  console.error(`[prune-runtime-deps] 错误: --root 必须为绝对路径: ${rootDir}`);
  process.exit(1);
}

const resolvedRoot = path.resolve(rootDir);

if (!resolvedRoot.includes('node_modules')) {
  console.error(`[prune-runtime-deps] 错误: --root 路径必须包含 'node_modules': ${resolvedRoot}`);
  process.exit(1);
}

if (!level || !['mini', 'full'].includes(level.trim().toLowerCase())) {
  console.error(`[prune-runtime-deps] 错误: --level 必须指定为 mini 或 full (当前: ${level})`);
  process.exit(1);
}

const normalizedLevel = level.trim().toLowerCase();

// ── 统计计数器 ─────────────────────────────────────────────────────────────

let totalFreedBytes = 0;
let deletedFilesCount = 0;
let deletedDirsCount = 0;
const startTime = process.hrtime.bigint();

// ── 辅助函数 ───────────────────────────────────────────────────────────────

/**
 * 计算目录占用的物理字节数（递归计算所有非软链文件）
 */
function getDirSizeBytes(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          size += getDirSizeBytes(fullPath);
        } else if (entry.isFile()) {
          const st = fs.statSync(fullPath);
          size += st.size;
        }
      } catch {}
    }
  } catch {}
  return size;
}

/**
 * 保护判定：绝对不能删除的文件
 */
function isProtectedFile(filePath, fileName) {
  if (fileName === 'package.json') return true;
  if (fileName === 'index.js') return true;
  if (fileName.endsWith('.node')) return true;

  // 绝不删 lib/*.js（即位于 lib/ 目录下的所有 js 文件）
  if (fileName.endsWith('.js')) {
    const parts = filePath.split(path.sep);
    const libIdx = parts.indexOf('lib');
    if (libIdx !== -1) {
      return true;
    }
  }

  // 【Issue #11 / DQ5】跨架构原生件白名单：误删会导致 arm64 启动期 Cannot find the native Koffi module
  if (filePath.includes(`${path.sep}@koromix${path.sep}`)) return true;
  if (/@vscode[\/\\]ripgrep-linux-[^/\\]+[\/\\]bin[\/\\]/.test(filePath)) return true;
  // *.so 只在 sherpa-onnx-* 包内允许删除（由 pruneDirectory 的规则限定），其余一律保护
  if (fileName.endsWith('.so') && !filePath.includes('sherpa-onnx-')) return true;

  return false;
}

const PRUNABLE_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'docs', 'examples']);

/**
 * 遍历并裁剪目录
 */
function pruneDirectory(currentDir) {
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  const currentDirName = path.basename(currentDir);
  const parentDir = path.dirname(currentDir);
  const parentDirName = path.basename(parentDir);

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // 绝不跟进软链，防止环路与误删外部实体
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      const dirName = entry.name;

      // 规则 A: prebuilds/ 下非 linux-x64 / linux-arm64 的子目录 (如 win32-x64, darwin-arm64)
      if (currentDirName === 'prebuilds' && !['linux-x64', 'linux-arm64'].includes(dirName)) {
        try {
          const sz = getDirSizeBytes(fullPath);
          totalFreedBytes += sz;
          deletedDirsCount++;
          if (!dryRun) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (e) {
          console.warn(`[prune-runtime-deps] 警告: 删除预编译目录失败 ${fullPath}:`, e.message);
        }
        continue;
      }

      // 规则 B: sherpa-onnx-* 下的 lib/ 目录
      if (currentDirName.startsWith('sherpa-onnx-') && dirName === 'lib') {
        try {
          const sz = getDirSizeBytes(fullPath);
          totalFreedBytes += sz;
          deletedDirsCount++;
          if (!dryRun) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (e) {
          console.warn(`[prune-runtime-deps] 警告: 删除 sherpa lib 目录失败 ${fullPath}:`, e.message);
        }
        continue;
      }

      // 规则 C: 包内 test/tests/__tests__/docs/examples 目录
      // 必须是已安装包内部的子目录（即父目录存在 package.json），绝不误删命名碰巧相同的包根
      if (PRUNABLE_DIR_NAMES.has(dirName) && fs.existsSync(path.join(currentDir, 'package.json'))) {
        try {
          const sz = getDirSizeBytes(fullPath);
          totalFreedBytes += sz;
          deletedDirsCount++;
          if (!dryRun) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch (e) {
          console.warn(`[prune-runtime-deps] 警告: 删除文档/测试目录失败 ${fullPath}:`, e.message);
        }
        continue;
      }

      // 规则 D: libreoffice-kit-wasm/assets/*
      // 如果当前正要进入 libreoffice-kit-wasm/assets，对 assets 内的所有子目录直接清理
      if (currentDirName === 'libreoffice-kit-wasm' && dirName === 'assets') {
        try {
          const assetEntries = fs.readdirSync(fullPath, { withFileTypes: true });
          for (const aEntry of assetEntries) {
            const aPath = path.join(fullPath, aEntry.name);
            try {
              if (aEntry.isDirectory()) {
                const sz = getDirSizeBytes(aPath);
                totalFreedBytes += sz;
                deletedDirsCount++;
                if (!dryRun) {
                  fs.rmSync(aPath, { recursive: true, force: true });
                }
              } else if (aEntry.isFile()) {
                const st = fs.statSync(aPath);
                totalFreedBytes += st.size;
                deletedFilesCount++;
                if (!dryRun) {
                  fs.unlinkSync(aPath);
                }
              }
            } catch (ae) {
              console.warn(`[prune-runtime-deps] 警告: 清理 assets 项失败 ${aPath}:`, ae.message);
            }
          }
        } catch (e) {
          console.warn(`[prune-runtime-deps] 警告: 读取 assets 目录失败 ${fullPath}:`, e.message);
        }
        continue;
      }

      // 常规目录，递归继续处理
      pruneDirectory(fullPath);

    } else if (entry.isFile()) {
      const fileName = entry.name;

      // 强规则：受保护文件绝不能删除
      if (isProtectedFile(fullPath, fileName)) {
        continue;
      }

      let shouldPrune = false;

      // 规则 1: *.map 源码映射文件
      if (fileName.endsWith('.map')) {
        shouldPrune = true;
      }

      // 规则 2: *.d.ts / *.d.mts / *.d.cts 类型声明文件
      else if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) {
        shouldPrune = true;
      }

      // 规则 3: sherpa-onnx-* 下的 *.so 动态库
      else if (currentDirName.startsWith('sherpa-onnx-') && (fileName.endsWith('.so') || /\.so(\.\d+)*$/.test(fileName))) {
        shouldPrune = true;
      }

      if (shouldPrune) {
        try {
          const st = fs.statSync(fullPath);
          totalFreedBytes += st.size;
          deletedFilesCount++;
          if (!dryRun) {
            fs.unlinkSync(fullPath);
          }
        } catch (e) {
          console.warn(`[prune-runtime-deps] 警告: 删除文件失败 ${fullPath}:`, e.message);
        }
      }
    }
  }
}

// ── 执行主流程 ─────────────────────────────────────────────────────────────

if (normalizedLevel === 'mini' && fs.existsSync(resolvedRoot)) {
  pruneDirectory(resolvedRoot);
}

const endTime = process.hrtime.bigint();
const elapsedSec = (Number(endTime - startTime) / 1e9).toFixed(2);
const freedMB = (totalFreedBytes / (1024 * 1024)).toFixed(2);

const summaryMsg = `[prune-runtime-deps]${dryRun ? ' (dry-run)' : ''} 释放 ${freedMB} MB，用时 ${elapsedSec}s`;

if (jsonOutput) {
  console.log(JSON.stringify({
    level: normalizedLevel,
    root: resolvedRoot,
    freedBytes: totalFreedBytes,
    freedMB: Number(freedMB),
    timeSeconds: Number(elapsedSec),
    deletedFiles: deletedFilesCount,
    deletedDirs: deletedDirsCount,
    dryRun,
    message: summaryMsg
  }, null, 2));
} else {
  console.log(summaryMsg);
}

process.exit(0);
