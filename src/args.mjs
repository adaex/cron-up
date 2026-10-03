// 子命令选项规格与选项名转换。独立于 cli：install 的「未生效参数」名单
// （service.mjs）从同一张选项表派生，新增可持久化选项时两处自动同步。

// 选项类型：string 吃一个值；int 吃一个值且必须是严格十进制；bool 是无值
// 开关；tri 支持 --name / --no-name（install 的 auto-renew、auto-min-id）。
export const SPECS = {
  install: {
    options: {
      roots: 'string',
      interval: 'int',
      lead: 'int',
      force: 'bool',
      'auto-renew': 'tri',
      'auto-min-id': 'tri',
      'session-retain': 'string',
    },
  },
  uninstall: {
    options: {
      purge: 'bool',
      'keep-sessions': 'bool',
    },
  },
  list: { options: {} },
  run: { options: {} },
  renew: { options: {} },
  logs: {
    options: { follow: 'bool', f: 'bool' },
    positionalMax: 1,
  },
};

// 选项名统一成代码里用的 camelCase（--keep-sessions → keepSessions）。
export function thisCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
