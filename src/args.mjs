// 子命令选项规格与选项名转换。独立于 cli：选项表是唯一事实源，新增选项
// 时只改这里。

// 选项类型：string 吃一个值；int 吃一个值且必须是严格十进制；bool 是无
// 值开关。
export const SPECS = {
  install: {
    options: {
      roots: 'string',
    },
  },
  uninstall: {
    options: {
      purge: 'bool',
    },
  },
  list: { options: {} },
  run: { options: {} },
  logs: {
    options: { follow: 'bool', f: 'bool' },
    positionalMax: 1,
  },
};

// 选项名统一成代码里用的 camelCase（--roots → roots）。
export function thisCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
