// launchd 服务面：launchctl 封装、服务状态查询、（本文件后半部分，安装阶
// 段补齐）node 路径解析、plist 渲染与 install/uninstall。

import { deps } from './internals.mjs';
import { LABEL } from './paths.mjs';

export function guiTarget() {
  return `gui/${process.getuid()}`;
}

// check=false 的调用占绝大多数：统一走不抛的 execFile，需要判成败看
// status。
export function launchctl(...args) {
  return deps.execFile('/bin/launchctl', args);
}

// launchctl print 的输出里抠状态/退出码/实际间隔；服务未加载返回 null。
export function launchctlInfo() {
  const r = launchctl('print', `${guiTarget()}/${LABEL}`);
  if (r.status !== 0) return null;
  const info = {};
  for (const key of ['state', 'last exit code']) {
    const m = r.stdout.match(
      new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+)$`, 'm'));
    if (m) info[key] = m[1].trim();
  }
  const iv = r.stdout.match(/^\s*run interval\s*=\s*(\d+)\s*seconds/m);
  if (iv) info.interval = parseInt(iv[1], 10);
  return info;
}

const LAUNCHD_STATES = new Map([
  ['running', '运行中'],
  ['not running', '空闲中（按间隔触发）'],
]);

export function launchdStateZh(state) {
  // launchd 的 "not running" 是间隔触发型服务两轮之间的正常空闲态，直译
  // 会让人以为服务停了；未识别的值原样保留以便排查。
  if (!state) return '未知';
  return LAUNCHD_STATES.get(state) ?? state;
}

export function serviceLine(info, plistExists) {
  if (info) {
    return `服务：launchd 已加载，${launchdStateZh(info.state)}，`
      + `上次退出码 ${info['last exit code'] ?? '?'}`;
  }
  if (plistExists) {
    return '服务：plist 文件存在但未加载，运行 cron-ready install 重新加载';
  }
  return '服务：未安装，运行 cron-ready install 安装';
}

Object.assign(deps, { launchctl, launchctlInfo });
