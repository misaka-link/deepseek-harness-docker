'use strict';
/**
 * crash-detector.js — DSH 启动崩溃根因插件分析器。
 */

const fs = require('node:fs');
const paths = require('../core/paths');

function detectCrashingPlugin(recentLogs = [], lastExitInfo = null) {
  let combinedLogs = Array.isArray(recentLogs) ? [...recentLogs] : [];
  if (lastExitInfo && Array.isArray(lastExitInfo.logs)) {
    combinedLogs = [...lastExitInfo.logs, ...combinedLogs];
  }
  const webLog = paths.getDshWebLogFile();
  try {
    if (fs.existsSync(webLog)) {
      const fileContent = fs.readFileSync(webLog, 'utf8');
      const fileLines = fileContent.split('\n').filter(Boolean).slice(-150);
      combinedLogs = [...fileLines, ...combinedLogs];
    }
  } catch {}

  const logText = combinedLogs.join('\n');
  if (!logText.trim()) return null;

  let pluginsList = [];
  try {
    const pm = require('../plugins/plugin-manager');
    const res = pm.getPlugins();
    if (res && Array.isArray(res.plugins)) {
      pluginsList = res.plugins;
    }
  } catch (e) {
    console.warn('[crash-detector] 获取插件列表进行崩溃分析失败:', e.message);
    return null;
  }

  const candidatePlugins = pluginsList.filter((p) => !p.isCore && p.enabled && !p.isUninstalled);
  if (candidatePlugins.length === 0) return null;

  // 1. 结构化 Cordis 加载器条目报错
  const cordisEntryRegex = /(?:loader entry|failed to (?:import|apply|load|resolve)[^:\n]*loader entry)\s+([a-zA-Z0-9_\-.@/]+)(?:\s*\(([@a-zA-Z0-9_\-./]+)\))?/gi;
  let m;
  while ((m = cordisEntryRegex.exec(logText)) !== null) {
    const entryId = m[1];
    const pkgName = m[2];
    for (const p of candidatePlugins) {
      if (p.isCore) continue;
      const cleanName = p.name.replace(/^@.*\//, '');
      if ((pkgName && (p.name === pkgName || cleanName === pkgName || p.name.endsWith('/' + pkgName)))
        || (entryId && (p.name === entryId || cleanName === entryId || p.name === 'dsh-' + entryId || cleanName === 'dsh-' + entryId))) {
        return {
          name: p.name,
          reason: 'cordis_loader_entry_failure',
          matched: `Cordis 加载器明确报告条目装载失败: ${entryId}${pkgName ? ` (${pkgName})` : ''}`
        };
      }
    }
  }

  // 2. 括号包裹包名检测
  for (const p of candidatePlugins) {
    if (p.isCore) continue;
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\(\\s*(?:' + escaped + '|' + short + ')\\s*\\)', 'i').test(logText)) {
      return {
        name: p.name,
        reason: 'plugin_paren_mention',
        matched: `加载器报错信息明确标注故障拓展: (${p.name})`
      };
    }
  }

  // 3. 广义装载与依赖导入失败
  for (const p of candidatePlugins) {
    if (p.isCore) continue;
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = p.name.replace(/^@.*\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('failed to (?:import|apply|load|resolve)[^\\n]*?\\b(?:' + escaped + '|' + short + ')\\b', 'i').test(logText)) {
      return {
        name: p.name,
        reason: 'failed_to_import',
        matched: `日志检测到拓展装载失败: ${p.name}`
      };
    }
  }

  // 4. Node.js 异常调用栈定位
  for (const p of candidatePlugins) {
    if (p.isCore) continue;
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stackRegex = new RegExp(`(?:node_modules[\\\\/]${escaped}[\\\\/]|imported from.*${escaped})`, 'i');
    if (stackRegex.test(logText)) {
      return {
        name: p.name,
        reason: 'stack_trace_match',
        matched: `调用堆栈直接定位到故障插件: ${p.name}`
      };
    }
  }

  // 5. Cordis Patch 配置解析冲突（同行匹配）
  for (const p of candidatePlugins) {
    if (p.isCore) continue;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = esc(p.name) + '|' + esc(p.name.replace(/^@.*\//, ''));
    const reA = new RegExp('(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)[^\\n]*?(?:' + names + ')', 'i');
    const reB = new RegExp('(?:' + names + ')[^\\n]*?(patch|yaml|yml)[^\\n]*?(parse|syntax|invalid|conflict|error)', 'i');
    if (reA.test(logText) || reB.test(logText)) {
      return {
        name: p.name,
        reason: 'patch_conflict',
        matched: `Cordis 补丁配置解析冲突: ${p.name}`
      };
    }
  }

  // 6. 插件自身标签致命异常（同行匹配）
  for (const p of candidatePlugins) {
    if (p.isCore) continue;
    const short = p.name.replace(/^@.*\//, '');
    const tagEsc = ('[' + short + ']').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(tagEsc + '[^\\n]*?(Error|Exception|FATAL|crash|failed)', 'i');
    if (re.test(logText)) {
      return {
        name: p.name,
        reason: 'plugin_logger_error',
        matched: `插件内部日志打印致命异常: [${short}]`
      };
    }
  }

  return null;
}

module.exports = { detectCrashingPlugin };
