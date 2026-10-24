// 全部调参常量集中一处，改动时便于通盘核对。

// 配置文件只有 roots 一个字段：巡检间隔、提前量、扫描深度、续期与任务归属
// 盖印都是不可关闭的唯一行为（见 README），常量化在本文件。
export const DEFAULT_CONFIG = {
  // 默认只扫本人的三个任务制容器，不扫整个家目录——他人可写仓库里的周期
  // 任务会被自动续期永久化，默认范围必须是用户完全掌控的领地（见 README
  // 安全说明）。其他布局用 cron-up install --roots 覆盖；目录不存在则跳过。
  roots: ['~/space', '~/workspace', '~/tasks'],
};

// launchd 两轮巡检之间的秒数（plist 的 StartInterval）。
export const INTERVAL_SECONDS = 300;
// 提前多少秒为窗口内任务备好会话。任务相对巡检网格的相位任意：最迟在落
// 点前一轮（≤INTERVAL）被发现并 spawn，spawn 后当轮等待认亲并盖印（见
// WARMUP_WAIT_MS），故提前量只需「一轮间隔 + 等待与重扫开销」。一次性
// 任务在 :00/:30 网格最多提前 90 秒投递，其窗口前沿在 cron.mjs 的 wanted
// 里再前推 CC_JITTER.oneShotMaxMs，不占这里的周期任务余量。
export const LEAD_SECONDS = 360;
// 工作区发现的最大递归深度（相对 roots）：深度 3 覆盖
// <容器>/<仓>/<子目录>/<孙目录> 里的任务文件。
export const MAX_SCAN_DEPTH = 3;

// 预热会话连续三次启动后死亡，大概率是环境坏了（缺信任、env 不对），退避
// 而不是每轮无限重拉。
export const FAIL_LIMIT = 3;
export const COOLDOWN_SECONDS = 1800;
// 失败计数随死条目保留的时长。提前窗口通常只覆盖一两轮巡检（每小时任务
// 约 2 轮），计数若在窗口外的轮次被清理就永远数不满 FAIL_LIMIT——冷却只对
// 稠密任务生效。保留 48 小时让稀疏任务跨窗口累积；老化防止陈年计数误伤
// 已修好的环境。
export const FAIL_TTL_SECONDS = 48 * 3600;
// pid 合法值域。state.json 与会话登记两个外部来源的 pid 都在入口处
// （config 的 parsePid）按它统一校验：超大整数能穿过类型转换，直到
// process.kill 才抛，所以必须入口卡范围。
export const PID_T_MAX = 2 ** 31 - 1;
// 健康会话约 10 秒内完成登记。超时仍存活却没登记，是卡在无人应答的提问
// 界面（目录信任、工具授权）；只看存活会把它当健康，只有这个时限兜得住。
// 这是唯一的判死阈值，且只在跨轮判定（轮龄为整数个巡检间隔）时生效。
export const WARMUP_GRACE_SECONDS = 180;
// spawn 当轮在轮内等待会话登记的上限：它是「盖印加速」预算，不是判死阈
// 值——等不到的会话原样留到下轮，按 WARMUP_GRACE_SECONDS 跨轮判死，失
// 败计数不因等待而累积（慢启动环境两轮就被冷却的回退就是这么来的）。
// 健康会话约 10 秒登记，24 秒是 8 拍重扫（另加进入时的先扫一拍）；拍数
// 帽与墙钟帽双出口，高负载拖慢 setTimeout 也不会把一轮撑过间隔。
export const WARMUP_WAIT_MS = 24_000;
export const WARMUP_POLL_MS = 3_000;
// window 回收判据一：界面静默超过此时长视为「本任务已执行完」。TUI 工作
// 时持续渲染（毫秒级刷新 typescript），静默 3 分钟不可能是在执行；取
// WARMUP_GRACE 同值，结构上对齐「3 分钟定生死」的既有心智。
export const SESSION_RECYCLE_IDLE_SECONDS = WARMUP_GRACE_SECONDS;
// window 回收判据二：距该任务下次「需要会话在场」至少还有这么多秒。回收
// 后下轮（≤INTERVAL）发现并 spawn，进程即在场，盖印在该轮等待期内完成；
// 一个巡检间隔之外的 120 秒余量罩一次性任务最多 90 秒的提前投递与唤醒
// 抖动。更近的触发不回收，复用现有会话。
export const SESSION_FIRE_MARGIN_SECONDS = 120;
export const SESSION_RECYCLE_MARGIN_SECONDS =
  SESSION_FIRE_MARGIN_SECONDS + INTERVAL_SECONDS;
// 巡检日志每轮两行心跳加零星事件，跑几年的机器也该有上限。launchd 每次按
// 路径重开，轮初改名是安全的：本轮 fd 继续写改名后的 inode，下轮开新文件。
export const PATROL_LOG_ROTATE_BYTES = 1024 * 1024;
// 心跳沉默多少倍轮次间隔算异常：轮首据此提示漏轮（电脑休眠时 launchd 会
// 合并错过的间隔，醒来只补一轮），总览页据此报「服务在但巡检没在跑」。
export const HEARTBEAT_STALE_FACTOR = 2;

// 不进入这些目录：VCS/依赖内部与 macOS 家目录系统文件夹——agent 工作区不
// 会在里面，光一个 ~/Library 就足以让家目录扫描爆炸。
export const PRUNE_DIRS = new Set([
  '.git', 'node_modules',
  'Library', 'Applications', 'Desktop', 'Documents', 'Downloads',
  'Movies', 'Music', 'Pictures', 'Public', '.Trash',
  '.cache', '.npm', '.local', '.config',
]);

// Claude Code 会话投递定时任务时的抖动参数，两处使用：list/总览预测
// 「预计实际触发时间」；巡检把「落点之后、延迟投递点之前」这段投递尾窗
// 也算作需要会话在场，避免在任务真正投递前把预热回收。逆向自
// Claude Code v2.1.285
// （darwin-arm64 原生二进制，2026-09-30 安装）内部 createCronScheduler 的
// gV 默认值：周期任务 fire = 落点 + min(hash(id)·recurringFrac·周期,
// recurringCapMs)；一次性任务在 :00/:30 网格点提前 0~oneShotMaxMs。
// 这些值没有稳定性承诺——版本升级可能改，运行时还可能被远程配置键
// tengu_kairos_cron_config（60 秒刷新，校验失败回退默认）覆盖。预测与
// 实际系统性对不上时，按 findings 主题
// claude-code-scheduled-task-jitter 的排查步骤复核新版本。
export const CC_JITTER = {
  recurringFrac: 0.5,
  recurringCapMs: 30 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
};

// 投递尾窗判定的回看/前探窗口（wanted 与 nextDelivery 共用，见
// src/cron.mjs 的 recurringTailWindow）：找上一落点用 prevAtOrBefore、算
// 周期用 nextAfter，两个方向都要罩住月/年任务之外的 2 月 29 日——相邻落
// 点隔 4 年，世纪非闰年（2100）隔 8 年；窗口小了尾窗会塌缩成零：落点已
// 过、投递未到，死亡却不重拉。日历快进按月跳，十年窗口也只有百余次迭代。
export const TAIL_WINDOW_DAYS = 366 * 10 + 1;

// 定时任务 7 天过期（周期任务被调度器删除，一次性任务早就触发过），巡检
// 不需要看得更远。展示页另算。
export const SEARCH_DAYS = 7;
// list/总览回答「下次何时触发」，要看到一年后：年度任务必须显示真实日期，
// 不能误报成「无安排」。nextAfter 的日历快进让长窗口依然便宜。
export const DISPLAY_SEARCH_DAYS = 366;
