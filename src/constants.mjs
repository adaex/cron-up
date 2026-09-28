// 全部调参常量，集中一处，便于核对 Python 版行为。

export const DEFAULT_CONFIG = {
  version: 1,
  // 默认扫家目录（两层深覆盖 ~/<root>/<workspace>）；安装时可用 roots 收窄。
  roots: ['~'],
  maxDepth: 2,
  intervalSeconds: 300,
  leadSeconds: 600,
  // 每轮巡检给周期任务补 permanent 标记，绕开 Claude Code 的 7 天周期任务
  // 过期。loadConfig 会用默认值补缺键，所以安装或升级后的首轮会把旧任务
  // 全部补标。配置里 autoRenew:false 可关（下轮生效），或安装时
  // --no-auto-renew。
  autoRenew: true,
};

// 预热会话连续三次启动后死亡，大概率是环境坏了（缺信任、env 不对），退避
// 而不是每 5 分钟无限重拉。
export const FAIL_LIMIT = 3;
export const COOLDOWN_SECONDS = 1800;
// pid 合法值域。state.json 与会话登记两个外部来源都在入口处按它校验：
// 超大整数能穿过类型转换，直到 process.kill 才抛，所以必须入口卡范围。
export const PID_T_MAX = 2 ** 31 - 1;
// 健康会话约 10 秒内完成登记。超时仍存活却没登记，是卡在无人应答的提问
// 界面（目录信任、工具授权）；只看存活会把它当健康，只有这个时限兜得住。
export const WARMUP_GRACE_SECONDS = 180;
// 预热会话是缓存不是宠物：「永久」任务让它无限常驻会把它钉死在启动当天的
// claude 版本和不断增长的 typescript 上。超龄会话仅在日志静默一段时间后
// 才退役——日志安静是没有任务在执行的证据，运行中的任务绝不会被切掉。
export const SESSION_MAX_AGE_SECONDS = 7 * 86400;
export const SESSION_IDLE_SECONDS = 3600;
// TUI typescript 是全屏渲染流，长驻时无限增长，拉起时轮转（script(1) 打开
// 即截断，所以轮转粒度是一个预热会话的生命周期）。
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
// 巡检日志每轮几行，但跑几年的机器也该有上限。launchd 每次按路径重开，
// 轮初改名是安全的：本轮 fd 继续写改名后的 inode，下轮开新文件。
export const PATROL_LOG_ROTATE_BYTES = 1024 * 1024;

// 不进入这些目录：VCS/依赖内部与 macOS 家目录系统文件夹——agent 工作区不
// 会在里面，光一个 ~/Library 就足以让家目录扫描爆炸。
export const PRUNE_DIRS = new Set([
  '.git', 'node_modules',
  'Library', 'Applications', 'Desktop', 'Documents', 'Downloads',
  'Movies', 'Music', 'Pictures', 'Public', '.Trash',
  '.cache', '.npm', '.local', '.config',
]);

// 定时任务 7 天过期（周期任务被调度器删除，一次性任务早就触发过），巡检
// 不需要看得更远。展示页另算。
export const SEARCH_DAYS = 7;
// list/总览回答「下次何时触发」，要看到一年后：年度任务必须显示真实日期，
// 不能误报成「无安排」。nextAfter 的日历快进让长窗口依然便宜。
export const DISPLAY_SEARCH_DAYS = 366;
// 补执行检测从任务创建时间向前搜，需要独立的上界。
export const MISSED_LOOKBACK_DAYS = 30;
// list 问「一次性任务是否被错过」，与巡检同一个补执行判定，只是不带前瞻。
export const ZERO_LEAD_MS = 0;
