"""Unit tests for doorman. Run: /usr/bin/python3 -m unittest discover -s tests

Zero third-party dependencies; the binary under test has no .py extension, so
it is loaded explicitly via SourceFileLoader.
"""

import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock
from importlib.machinery import SourceFileLoader

BIN = os.path.join(os.path.dirname(__file__), "..", "bin", "doorman")
d = SourceFileLoader("doorman", os.path.abspath(BIN)).load_module()

NOW = datetime.datetime(2026, 9, 20, 15, 47)  # Sunday
WS_PATH = "/x"


def read_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f)


class CronTests(unittest.TestCase):
    def test_step_ranges(self):
        self.assertEqual(d.Cron("*/5 * * * *").next_after(NOW),
                         datetime.datetime(2026, 9, 20, 15, 50))
        self.assertEqual(d.Cron("3,33 * * * *").next_after(NOW),
                         datetime.datetime(2026, 9, 20, 16, 3))

    def test_rolls_to_next_day(self):
        self.assertEqual(d.Cron("3 9 * * *").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 9, 3))

    def test_day_of_week(self):
        # Sunday-only, 10:00 already passed today → next Sunday
        self.assertEqual(d.Cron("0 10 * * 0").next_after(NOW),
                         datetime.datetime(2026, 9, 27, 10, 0))

    def test_dom_dow_or_semantics(self):
        # Both restricted: hit either. Today is the 20th (DoM match).
        self.assertEqual(d.Cron("0 18 20 * 1").next_after(NOW),
                         datetime.datetime(2026, 9, 20, 18, 0))

    def test_dom_dow_or_hits_weekday(self):
        # Both restricted: fire on the 25th OR Monday. Tomorrow (Mon 9/21)
        # wins even though it is not the 25th.
        self.assertEqual(d.Cron("0 12 25 * 1").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 12, 0))

    def test_vixie_start_step(self):
        self.assertEqual(d.parse_cron_field("5/15", 0, 59), {5, 20, 35, 50})

    def test_dow_seven_is_sunday_inside_ranges(self):
        # 7 names Sunday; the fold must happen AFTER range expansion. A
        # textual replace("7","0") turns "1-7" into the backwards "1-0",
        # which parses empty and the task silently never fires.
        self.assertEqual(d.Cron("0 9 * * 1-7").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 9, 0))
        self.assertEqual(d.Cron("0 9 * * 2-7").next_after(NOW),
                         datetime.datetime(2026, 9, 22, 9, 0))
        self.assertEqual(d.Cron("0 9 * * 7").next_after(NOW),
                         datetime.datetime(2026, 9, 27, 9, 0))
        self.assertEqual(d.Cron("0 9 * * 0,7").next_after(NOW),
                         datetime.datetime(2026, 9, 27, 9, 0))

    def test_out_of_range_dow_is_dropped_not_folded(self):
        # 8 must not become Monday via 8 % 7 == 1.
        self.assertFalse(d.Cron("0 9 * * 8").satisfiable)


class CronSatisfiabilityTests(unittest.TestCase):
    def test_empty_field_sets_are_unsatisfiable(self):
        for expr in ("99 * * * *", "5-2 * * * *", "0 99 * * *",
                     "0 0 * 13 *", "0 0 99 * *", "0 9 * * 8"):
            with self.subTest(expr=expr):
                self.assertFalse(d.Cron(expr).satisfiable)

    def test_unsatisfiable_views_as_invalid(self):
        v = d.task_view({"cron": "99 * * * *"}, NOW)
        self.assertFalse(v["valid"])

    def test_in_range_values_surrounding_a_typo_survive(self):
        # vixie would reject the whole line; doorman only clips the bad
        # value, so the typo does not silence the legal 5 past the hour.
        cron = d.Cron("5,99 * * * *")
        self.assertTrue(cron.satisfiable)
        self.assertEqual(cron.next_after(NOW),
                         datetime.datetime(2026, 9, 20, 16, 5))

    def test_out_of_range_or_side_does_not_match_through(self):
        # Old behaviour kept DoM=99 in the set and the DoW OR-side still
        # matched Mondays. An illegal field must fail loudly instead.
        cron = d.Cron("0 12 99 * 1")
        self.assertFalse(cron.satisfiable)
        self.assertIsNone(cron.next_after(NOW))


class CronFastForwardTests(unittest.TestCase):
    """next_after 的日历快进必须与朴素逐分钟扫描给出完全相同的结果。"""

    @staticmethod
    def brute_next_after(cron, after, within_days):
        if not cron.satisfiable:
            return None
        t = (after + datetime.timedelta(minutes=1)).replace(
            second=0, microsecond=0)
        deadline = after + datetime.timedelta(days=within_days)
        while t <= deadline:
            if cron._matches(t):
                return t
            t += datetime.timedelta(minutes=1)
        return None

    EXPRS = ("*/5 * * * *", "3 9 * * *", "0 0 29 2 *", "0 0 31 4 *",
             "0 10 * * 0", "0 18 20 * 1", "0 12 25 * 1", "30 3 1 1 *",
             "*/7 */3 * * *", "0 0 1 * *", "15 14 * * 5", "0 0 29 2 1",
             "59 23 31 12 *", "0,30 8-18/2 1,15 * *", "0 0 29 2 0")
    STARTS = (datetime.datetime(2026, 9, 20, 15, 47),
              datetime.datetime(2026, 1, 31, 23, 59),
              datetime.datetime(2027, 2, 28, 0, 0),
              datetime.datetime(2028, 2, 29, 12, 0),
              datetime.datetime(2026, 12, 31, 23, 58))

    def test_fast_forward_matches_brute_force(self):
        for expr in self.EXPRS:
            cron = d.Cron(expr)
            for start in self.STARTS:
                for window in (7, 31, 366, 800):
                    with self.subTest(expr=expr, start=start, window=window):
                        self.assertEqual(
                            cron.next_after(start, within_days=window),
                            self.brute_next_after(cron, start, window))

    def test_year_long_display_window_stays_cheap(self):
        # 快进之前，一年窗口意味着 52 万次逐分钟迭代；闰日表达式是最坏
        # 情况之一，也必须毫秒级返回。
        cron = d.Cron("0 0 29 2 *")
        started = time.time()
        cron.next_after(NOW, within_days=d.DISPLAY_SEARCH_DAYS)
        self.assertLess(time.time() - started, 0.2)

    def test_task_view_sees_a_year_ahead(self):
        # list/总览共用的展示视图：年度任务必须给出真实日期，而不是
        # 被 7 天巡检窗口误报成「无安排」。
        future = NOW + datetime.timedelta(days=60)
        expr = (f"{future.minute} {future.hour} {future.day} "
                f"{future.month} *")
        v = d.task_view({"cron": expr, "recurring": True}, NOW)
        self.assertEqual(v["nxt"], future)
        # 巡检判定不受显示窗口影响：60 天外不算「需要预热」。
        self.assertFalse(d.task_wanted(
            {"cron": expr, "recurring": True}, NOW,
            datetime.timedelta(minutes=10)))

    def test_task_view_can_answer_the_patrol_question_too(self):
        # 传了 lead 就不必再问一遍 task_wanted：在同一个已解析的 cron 上
        # 算完，总览页因此不必为同一任务重复解析、重复扫触发窗口。
        soon = NOW + datetime.timedelta(minutes=5)
        expr = f"{soon.minute} {soon.hour} {soon.day} {soon.month} *"
        task = {"cron": expr, "recurring": True}
        lead = datetime.timedelta(minutes=10)
        self.assertIs(d.task_view(task, NOW, lead)["wanted"], True)
        self.assertIs(d.task_view(task, NOW, lead)["wanted"],
                      d.task_wanted(task, NOW, lead))
        # 不传 lead 时 wanted 为 None（不是缺席）：list 只关心展示，不该
        # 多算一遍。
        self.assertIsNone(d.task_view(task, NOW)["wanted"])
        # 无效任务的 wanted 同样是 None，调用方判完 valid 就走，不踩空。
        self.assertIsNone(d.task_view({"cron": "nope"}, NOW, lead)["wanted"])


class DisplayTests(unittest.TestCase):
    """等宽终端的展示助手：CJK 宽度、截断、补位。"""

    def test_display_width_handles_cjk_and_punctuation(self):
        self.assertEqual(d.disp_width("中文："), 6)
        self.assertEqual(d.disp_width("ab"), 2)
        # 省略号 U+2026 是 East Asian Ambiguous，按 1 列计（多数终端如此）
        self.assertEqual(d.clip("中文测试", 5), "中…")
        self.assertEqual(d.disp_width(d.clip("中文测试", 5)), 3)
        self.assertEqual(d.clip("abcdef", 5), "abc…")
        self.assertEqual(d.pad("中文", 6), "中文  ")


class ConfigTests(unittest.TestCase):
    def test_roots_normalised_despite_shell_tilde_quirks(self):
        # After "--roots ~/a,~/b" passes through the shell, only the first
        # tilde was expanded; the program must still normalise both.
        with mock.patch.dict(os.environ, {"HOME": "/home/u"}):
            self.assertEqual(
                d.normalize_roots(["/home/u/a", "~/b"]),
                ["/home/u/a", "/home/u/b"])
            # blanks are dropped; non-tilde entries survive unchanged
            self.assertEqual(
                d.normalize_roots(["~/x", "", "  "]),
                ["/home/u/x"])
            self.assertEqual(
                d.normalize_roots(["/abs/path/"]),
                ["/abs/path"])
            # 手改 config 混入的非字符串元素：跳过而不是在 .strip() 崩掉
            self.assertEqual(
                d.normalize_roots(["~/x", 5, None, ["y"]]),
                ["/home/u/x"])


class ValidationTests(unittest.TestCase):
    def test_lead_smaller_than_interval_warns(self):
        warnings = d.validate_config(
            {"intervalSeconds": 300, "leadSeconds": 60, "roots": []}, announce=lambda _: None)
        self.assertTrue(any("leadSeconds" in w for w in warnings))

    def test_missing_root_warns(self):
        warnings = d.validate_config(
            {"intervalSeconds": 300, "leadSeconds": 600,
             "roots": ["/nonexistent/path/xyz"]}, announce=lambda _: None)
        self.assertTrue(any("不存在" in w for w in warnings))

    def test_clean_config_has_no_warnings(self):
        warnings = d.validate_config(
            {"intervalSeconds": 300, "leadSeconds": 600, "roots": ["/tmp"]})
        self.assertEqual(warnings, [])

    def test_empty_roots_warn(self):
        # roots 为空意味着巡检永远空转，必须说得出来
        warnings = d.validate_config(
            {"intervalSeconds": 300, "leadSeconds": 600, "roots": []},
            announce=lambda _: None)
        self.assertTrue(any("roots" in w for w in warnings))

    def test_discover_recovers_the_on_disk_case_of_a_root(self):
        # macOS 默认文件系统大小写不敏感：敲错大小写的 roots 照样 isdir，
        # 但会话登记里的 cwd 是磁盘真实写法，带错大小写的 ws 会永远匹配
        # 不上，消费者判断静默失效。认回真实写法是 discover 的职责，而不
        # 是留给安装时的一句警告。
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        ws = os.path.join(tmp, "MyProj")
        os.makedirs(os.path.join(ws, ".claude"))
        write_json(os.path.join(ws, ".claude", "scheduled_tasks.json"),
                   {"tasks": []})
        typed = os.path.join(tmp, "myproj")
        if not os.path.isdir(typed):
            self.skipTest("大小写敏感的文件系统上无法构造该场景")
        self.assertEqual([w for w, _ in d.discover([typed], 2)],
                         [os.path.realpath(ws)])

    def test_on_disk_case_passes_missing_paths_through(self):
        self.assertEqual(d.on_disk_case("/nonexistent/xyz/abc"),
                         "/nonexistent/xyz/abc")

    def test_corrupt_json_exits_cleanly(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            f.write("{ not valid json")
            path = f.name
        self.addCleanup(os.unlink, path)
        with self.assertRaises(SystemExit) as ctx:
            d.load_config(path)
        self.assertEqual(ctx.exception.code, 2)

    def test_corrupt_json_can_be_raised_for_human_pages(self):
        # launchd 入口走默认的 exit(2)；总览选择接住后继续渲染。
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            f.write("{ not valid json")
            path = f.name
        self.addCleanup(os.unlink, path)
        with self.assertRaises(ValueError):
            d.load_config(path, corrupt_ok=True)

    def test_non_object_json_config_exits_legibly(self):
        # 手改成合法 JSON 但顶层不是对象（123、["a"]）：dict.update 会在
        # try 之外抛 TypeError/ValueError——launchd 入口每轮 traceback。
        # 与「不是合法 JSON」同等对待：一行原因、退出码 2。
        for content in ("123", '["a", "b"]', '"text"'):
            with self.subTest(content=content):
                with tempfile.NamedTemporaryFile("w", suffix=".json",
                                                 delete=False) as f:
                    f.write(content)
                    path = f.name
                self.addCleanup(os.unlink, path)
                with self.assertRaises(SystemExit) as ctx:
                    d.load_config(path)
                self.assertEqual(ctx.exception.code, 2)

    def test_non_object_json_config_is_corrupt_for_human_pages(self):
        # 总览页选择接住损坏配置继续渲染：非对象配置要以 ValueError 报出。
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            f.write("123")
            path = f.name
        self.addCleanup(os.unlink, path)
        with self.assertRaises(ValueError):
            d.load_config(path, corrupt_ok=True)

    def test_missing_config_exits_cleanly_for_launchd(self):
        # `run` is launchd's entry point: a deleted config must produce a
        # one-line reason, not a traceback with exit code 0.
        with self.assertRaises(SystemExit) as ctx:
            d.load_config("/nonexistent/doorman-config.json")
        self.assertEqual(ctx.exception.code, 2)

    def test_overview_still_sees_a_missing_config_as_absent(self):
        # The overview reports absence as part of its output, so it opts out.
        with self.assertRaises(OSError):
            d.load_config("/nonexistent/doorman-config.json",
                          missing_ok=True)

    def test_string_roots_falls_back_to_default(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            json.dump({"roots": "~/single-string"}, f)
            path = f.name
        self.addCleanup(os.unlink, path)
        cfg = d.load_config(path)
        self.assertIsInstance(cfg["roots"], list)
        self.assertNotIn("~", "".join(cfg["roots"]))

    def test_bool_maxdepth_is_coerced_to_default(self):
        # bool 是 int 的子类：手改 config 写入 true 不能冒充合法深度
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            json.dump({"maxDepth": True}, f)
            path = f.name
        self.addCleanup(os.unlink, path)
        self.assertEqual(d.load_config(path)["maxDepth"],
                         d.DEFAULT_CONFIG["maxDepth"])


class WantedTests(unittest.TestCase):
    LEAD = datetime.timedelta(minutes=10)

    def test_within_lead_window(self):
        t = {"cron": "50 15 20 9 *", "createdAt": 1_789_000_000_000}
        self.assertTrue(d.task_wanted(t, NOW, self.LEAD))

    def test_recurring_flag_identifies_one_shot(self):
        self.assertTrue(d.task_is_oneshot(
            {"cron": "0 0 1 1 *", "recurring": False}))
        # An annual cron that textually looks one-shot is NOT, with the flag:
        self.assertFalse(d.task_is_oneshot(
            {"cron": "0 0 1 1 *", "recurring": True}))

    def test_shape_fallback_without_flag(self):
        self.assertTrue(d.task_is_oneshot({"cron": "0 0 1 1 *"}))
        self.assertFalse(d.task_is_oneshot({"cron": "0 0 * * *"}))

    def test_missed_one_shot_is_wanted(self):
        t = {"cron": "40 15 20 9 *", "createdAt": 1_789_000_000_000}
        self.assertTrue(d.task_wanted(t, NOW, self.LEAD))

    def test_missed_recurring_waits_for_next_round(self):
        t = {"cron": "40 15 * * *", "createdAt": 1_789_000_000_000}
        self.assertFalse(d.task_wanted(t, NOW, self.LEAD))
        self.assertEqual(d.Cron("40 15 * * *").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 15, 40))

    def test_bad_cron_is_not_wanted(self):
        self.assertFalse(
            d.task_wanted({"cron": "not a cron"}, NOW, self.LEAD))

    def test_malformed_tasks_never_raise(self):
        # Every one of these has been seen or is one typo away: the task file
        # is written by another program, so a bad entry must read as "not
        # wanted" rather than abort the patrol.
        for task in ({"cron": 123}, {"cron": None}, {"cron": []},
                     {"prompt": "no cron"}, {},
                     {"cron": "*/5 * * * *", "createdAt": "yesterday"},
                     {"cron": "*/5 * * * *", "createdAt": None},
                     {"cron": "0 0 1 1 *", "createdAt": 10 ** 18}):
            with self.subTest(task=task):
                self.assertIsInstance(
                    d.task_wanted(task, NOW, self.LEAD), bool)

    def test_unsatisfiable_cron_returns_none_fast(self):
        # Out-of-range fields used to walk four years of candidate minutes.
        for expr in ("99 * * * *", "0 99 * * *", "0 0 * 13 *", "0 0 99 * *"):
            with self.subTest(expr=expr):
                started = time.time()
                self.assertIsNone(d.Cron(expr).next_after(NOW))
                self.assertLess(time.time() - started, 0.05)

    def test_beyond_the_window_reads_as_no_next_fire(self):
        # The search only looks SEARCH_DAYS ahead, which is all a task can
        # live for. A yearly expression therefore has no next fire "soon" —
        # and must not be mistaken for one that fires imminently.
        self.assertIsNone(d.Cron("0 0 29 2 *").next_after(NOW))
        self.assertFalse(d.task_wanted(
            {"cron": "0 0 29 2 *", "recurring": True}, NOW, self.LEAD))
        # It still resolves when a caller explicitly asks to look further.
        self.assertEqual(
            d.Cron("0 0 29 2 *").next_after(NOW, within_days=900),
            datetime.datetime(2028, 2, 29, 0, 0))

    def test_missed_one_shot_created_long_ago_is_still_wanted(self):
        # Catch-up search runs forward from creation, so it must not be
        # limited by the ordinary look-ahead window.
        created = NOW - datetime.timedelta(days=10)
        fire = NOW - datetime.timedelta(days=9)
        task = {"cron": f"{fire.minute} {fire.hour} {fire.day} {fire.month} *",
                "createdAt": int(created.timestamp() * 1000),
                "recurring": False}
        self.assertTrue(d.task_wanted(task, NOW, self.LEAD))

    def test_ancient_unmatchable_one_shot_stays_cheap(self):
        # A stale entry whose expression never matches must not scan every
        # minute since it was written.
        created = NOW - datetime.timedelta(days=3650)
        task = {"cron": "0 0 30 2 *",  # Feb 30th: never
                "createdAt": int(created.timestamp() * 1000),
                "recurring": False}
        started = time.time()
        self.assertFalse(d.task_wanted(task, NOW, self.LEAD))
        self.assertLess(time.time() - started, 0.2)


class TaskFileTests(unittest.TestCase):
    """read_tasks validates shape: the file is another program's output."""

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)
        os.makedirs(os.path.join(self.ws, ".claude"))

    def write(self, text):
        with open(os.path.join(self.ws, ".claude",
                               "scheduled_tasks.json"), "w") as f:
            f.write(text)

    def capture_logs(self):
        logs = []
        self.addCleanup(setattr, d, "log", d.log)
        d.log = logs.append
        return logs

    def test_shapes_that_used_to_crash_the_patrol(self):
        for text in ("[]", "null", '"a string"', "42",
                     '{"tasks": {"a": 1}}', '{"tasks": "nope"}',
                     '{"no_tasks_key": 1}', "{ truncated"):
            with self.subTest(text=text):
                self.write(text)
                result = d.read_tasks(self.ws)
                self.assertIn(result, (None, []))

    def test_non_dict_entries_are_dropped(self):
        self.write('{"tasks": [{"cron": "0 9 * * *"}, "junk", null, 7]}')
        self.assertEqual(d.read_tasks(self.ws),
                         [{"cron": "0 9 * * *"}])

    def test_missing_file_reads_as_none(self):
        self.assertIsNone(d.read_tasks(
            os.path.join(self.ws, "nonexistent")))

    def test_unreadable_file_is_reported_by_the_patrol(self):
        # 「证据不足所以不动会话」不等于「不吭声」：文件仍在却读不出，意味
        # 着该目录的定时任务一个都不会执行，正是 doorman 要防的静默失效。
        self.write("{ truncated")
        logs = self.capture_logs()
        d.patrol_workspace(self.ws, {}, datetime.datetime.now(),
                           datetime.timedelta(0), int(time.time()), set(), [])
        self.assertTrue(any("任务文件读不出" in m for m in logs))

    def test_file_vanished_after_discovery_is_not_reported(self):
        # discover 之后文件消失（一次性任务执行完被删）是正常竞态，不告警。
        logs = self.capture_logs()
        d.patrol_workspace(self.ws, {}, datetime.datetime.now(),
                           datetime.timedelta(0), int(time.time()), set(), [])
        self.assertEqual(logs, [])


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        # 本类每个用例都要跑完整巡检，日志直写 stdout 会冲散 unittest 的
        # 进度输出；用例判的是 state.json，不看日志。
        self.addCleanup(setattr, d, "log", d.log)
        d.log = lambda *a, **k: None
        # Module globals are patched wholesale below; restore them so test
        # order never matters.
        for name in ("STATE_PATH", "SESSION_LOG_DIR", "alive",
                     "proc_started_at", "discover", "read_tasks",
                     "scan_sessions", "spawn_session", "stop_session",
                     "acquire_run_lock", "list_script_processes"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.SESSION_LOG_DIR = os.path.join(self.tmp, "sessions")
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600})
        self.alive_pids = set()
        self.next_pid = 100
        self.consumer = False

        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.read_tasks = lambda ws: [{"cron": "*/5 * * * *", "createdAt": 0}]
        d.scan_sessions = lambda: (
            ({WS_PATH} if self.consumer else set(), None))
        d.list_script_processes = lambda: []
        d.alive = lambda pid: pid in self.alive_pids
        # Identity fingerprints are faked as "start-<pid>": a pid that is
        # alive in the fake table reports the same value spawn recorded, and
        # a recycled pid can be simulated by rewriting state.
        d.proc_started_at = lambda pid: (
            f"start-{pid}" if pid in self.alive_pids else None)

        def fake_spawn(ws):
            pid = self.next_pid
            self.next_pid += 1
            self.alive_pids.add(pid)
            return pid, f"start-{pid}"

        d.spawn_session = fake_spawn
        d.stop_session = lambda ent: self.alive_pids.discard(
            ent.get("pid")) or True
        d.acquire_run_lock = lambda: 1
        self.args = argparse.Namespace(config=self.cfg_path)

    def state(self):
        if not os.path.exists(d.STATE_PATH):
            return {}
        return read_json(d.STATE_PATH)

    def patrol(self):
        d.cmd_run(self.args)

    def test_lifecycle(self):
        # 1: first spawn, fails=0
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertEqual(ent["fails"], 0)
        self.assertIn(ent["pid"], self.alive_pids)
        pid1 = ent["pid"]

        # 2: registered and healthy → still tracked, streak reset
        self.state()[WS_PATH]["fails"] = 1
        write_json(d.STATE_PATH, self.state())
        self.consumer = True
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], pid1)
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)

        # 3: dies while needed → fails=1, respawned
        self.consumer = False
        self.alive_pids.discard(pid1)
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["fails"], 1)
        self.assertNotEqual(self.state()[WS_PATH]["pid"], pid1)

        # 4: two more quick deaths → cooldown, no live pid
        for _ in range(2):
            self.alive_pids.discard(self.state()[WS_PATH]["pid"])
            self.patrol()
        ent = self.state()[WS_PATH]
        self.assertEqual(ent["fails"], 3)
        self.assertGreater(ent["cooldownUntil"], time.time())
        self.assertFalse(ent.get("pid"))
        spawned_after_cooldown = self.next_pid

        # 5: no respawn during cooldown
        self.patrol()
        self.assertEqual(self.next_pid, spawned_after_cooldown)

        # 6: cooldown elapsed → one clean probationary spawn
        s = self.state()
        s[WS_PATH]["cooldownUntil"] = int(time.time()) - 1
        write_json(d.STATE_PATH, s)
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertEqual(ent["fails"], 0)
        self.assertIn(ent["pid"], self.alive_pids)

        # 7: a pure user session (no state) is never tracked
        os.remove(d.STATE_PATH)
        self.consumer = True
        self.patrol()
        self.assertNotIn(WS_PATH, self.state())

        # 8: user session closes → clean spawn
        self.consumer = False
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)

    def test_observed_registration_resets_streak_even_when_nothing_wanted(self):
        # 健康会话长期常驻（周期任务不在提前窗口，wanted 轮次一直不来）：
        # 失败计数必须在看到登记的当轮就清零——否则计数挂在活会话头上，
        # 之后一次无关死亡（重启）就把陈年计数顶满冷却。
        self.patrol()
        pid1 = self.state()[WS_PATH]["pid"]
        d.read_tasks = lambda ws: [{"cron": "0 9 1 1 *", "recurring": True}]
        s = self.state()
        s[WS_PATH]["fails"] = 2
        write_json(d.STATE_PATH, s)
        self.consumer = True  # 会话早已登记，只是近期没有任务想要它
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)
        self.assertEqual(self.state()[WS_PATH]["pid"], pid1)

    def test_stuck_session_is_retired_and_counted(self):
        """Alive but never registering — parked on a trust/permission prompt.

        This is the common real-world failure, and liveness alone reports it
        as healthy forever. The warm-up deadline is what turns it into a
        failure that eventually reaches COOLDOWN.
        """
        self.patrol()
        stuck_pid = self.state()[WS_PATH]["pid"]

        # Within the grace period it is left alone: this is what a normal
        # ~10s startup looks like.
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], stuck_pid)
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)

        # Past the deadline, still unregistered → killed and replaced.
        s = self.state()
        s[WS_PATH]["startedAt"] -= d.WARMUP_GRACE_SECONDS + 1
        write_json(d.STATE_PATH, s)
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertNotEqual(ent["pid"], stuck_pid)
        self.assertNotIn(stuck_pid, self.alive_pids)  # actually terminated
        self.assertEqual(ent["fails"], 1)

        # Repeated stuck spawns must reach COOLDOWN rather than loop forever.
        for _ in range(2):
            s = self.state()
            s[WS_PATH]["startedAt"] -= d.WARMUP_GRACE_SECONDS + 1
            write_json(d.STATE_PATH, s)
            self.patrol()
        self.assertGreater(self.state()[WS_PATH].get("cooldownUntil", 0),
                           time.time())

    def test_recycled_pid_is_not_mistaken_for_our_session(self):
        """A pid alone is not an identity; macOS recycles them within hours."""
        self.patrol()
        ent = self.state()[WS_PATH]
        pid = ent["pid"]

        # Same pid, different process: still "alive", but not ours. It must
        # not be treated as a live standby session, and must not be signalled.
        s = self.state()
        s[WS_PATH]["procStart"] = "start-some-other-process"
        write_json(d.STATE_PATH, s)
        self.assertFalse(d.tracked_alive(self.state()[WS_PATH]))

        self.patrol()
        self.assertNotEqual(self.state()[WS_PATH]["pid"], pid)
        self.assertIn(pid, self.alive_pids)  # the impostor was left running

    def test_empty_task_list_reaps_our_session(self):
        """All tasks gone (fired one-shot deleted, expired, removed): the
        warm session WE spawned has no reason to live for another week."""
        self.patrol()
        pid = self.state()[WS_PATH]["pid"]

        d.read_tasks = lambda ws: []
        self.patrol()
        self.assertEqual(self.state(), {})
        self.assertNotIn(pid, self.alive_pids)

    def test_cooldown_entry_is_cleared_when_tasks_disappear(self):
        # Three quick failures → cooldown; then the task file is emptied.
        # Staying in cooldown for a directory that has no tasks is pointless.
        self.patrol()
        for _ in range(3):
            self.alive_pids.discard(self.state()[WS_PATH]["pid"])
            self.patrol()
        self.assertIn("cooldownUntil", self.state()[WS_PATH])

        d.read_tasks = lambda ws: []
        self.patrol()
        self.assertEqual(self.state(), {})

    def test_unreadable_task_file_never_reaps(self):
        # None means "the file could not be read" — never kill a tracked
        # session on evidence that weak; wait for a readable empty list.
        self.patrol()
        pid = self.state()[WS_PATH]["pid"]

        d.read_tasks = lambda ws: None
        self.patrol()
        self.assertIn(pid, self.alive_pids)
        self.assertEqual(self.state()[WS_PATH]["pid"], pid)

    def test_old_idle_session_is_rotated_not_counted_as_failure(self):
        """permanent 任务的会话长生不死后需要维护：超龄且日志静默的会话
        被主动结束并按需重拉——换代是维护，不进失败计数。"""
        self.patrol()
        pid1 = self.state()[WS_PATH]["pid"]
        self.consumer = True  # 长驻会话都是已登记的健康会话

        # 未满龄：不动
        s = self.state()
        s[WS_PATH]["startedAt"] -= d.SESSION_MAX_AGE_SECONDS - 100
        write_json(d.STATE_PATH, s)
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], pid1)

        # 超龄且 typescript 不存在（无任何活动证据）→ 本轮换代，下轮重拉
        s = self.state()
        s[WS_PATH]["startedAt"] -= 200
        write_json(d.STATE_PATH, s)
        self.patrol()
        self.assertNotIn(pid1, self.alive_pids)  # 旧会话真的被结束了
        self.assertNotIn(WS_PATH, self.state())  # 登记也清了

        self.consumer = False  # 登记处同步消失后，下轮按需重拉
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertNotEqual(ent["pid"], pid1)
        self.assertEqual(ent["fails"], 0)

    def test_old_but_active_session_is_not_rotated(self):
        """超龄但 typescript 仍在写入（任务在执行中）：不能砍。"""
        self.patrol()
        pid1 = self.state()[WS_PATH]["pid"]
        self.consumer = True  # 已登记的健康会话
        log_path = d.session_log_path(WS_PATH)
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "w") as f:
            f.write("task output\n")  # mtime 即现在
        s = self.state()
        s[WS_PATH]["startedAt"] -= d.SESSION_MAX_AGE_SECONDS + 1
        write_json(d.STATE_PATH, s)
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], pid1)
        self.assertIn(pid1, self.alive_pids)

    def test_orphan_session_is_adopted_not_duplicated(self):
        """state.json 丢失后，进程表里仍有本工作区的 script 会话：认回
        跟踪（卡死的 3 分钟后照常被退休），绝不在同目录再拉一个。"""
        log_path = d.session_log_path(WS_PATH)
        self.alive_pids.add(555)
        d.list_script_processes = lambda: [(
            555, f"/usr/bin/script -q {log_path} "
                 f"/bin/zsh -lic 'cd /x && claude'")]
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertEqual(ent["pid"], 555)        # 接管而非新拉
        self.assertEqual(ent["procStart"], "start-555")
        self.assertEqual(self.next_pid, 100)     # 没有发生新 spawn

        # 接管后进入正常生命周期：下轮巡检照常跟踪它
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], 555)

    def test_dead_orphan_in_snapshot_is_not_adopted(self):
        """进程表快照拍于轮次开头，可能含着刚死掉的 pid：接管前必须
        复核存活，否则认回一个死人会白记失败。"""
        log_path = d.session_log_path(WS_PATH)
        d.list_script_processes = lambda: [(
            556, f"/usr/bin/script -q {log_path} /bin/zsh -lic x")]
        # 556 不在 alive_pids：快照里的死人
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertNotEqual(ent["pid"], 556)
        self.assertEqual(ent["pid"], 100)  # 正常新拉

    def test_unrelated_script_processes_are_not_adopted(self):
        self.alive_pids.add(557)
        d.list_script_processes = lambda: [(
            557, "/usr/bin/script -q /other/place.log /bin/zsh -lic x")]
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], 100)

    def test_bool_lead_seconds_fails_the_launchd_entry(self):
        # bool 是 int 的子类：手改 config 写入 true 必须像其他非法值一样
        # 让 launchd 入口以退出码 2 失败，而不是静默变成 1 秒提前量。
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": True})
        with self.assertRaises(SystemExit) as ctx:
            self.patrol()
        self.assertEqual(ctx.exception.code, 2)

    def test_one_broken_workspace_does_not_stop_the_patrol(self):
        """discover() is a generator: an exception would skip the rest."""
        visited = []

        def read(ws):
            visited.append(ws)
            if ws == "/broken":
                raise RuntimeError("corrupt beyond read_tasks")
            return [{"cron": "*/5 * * * *", "createdAt": 0}]

        d.discover = lambda roots, depth: iter([("/broken", "x"),
                                                (WS_PATH, "x")])
        d.read_tasks = read
        self.patrol()
        self.assertEqual(visited, ["/broken", WS_PATH])
        self.assertIn(WS_PATH, self.state())


class SpawnEnvTest(unittest.TestCase):
    """spawn_session 的 child 分支：打上预热标识、strip 掉 CC 标记。"""

    def test_child_marked_and_claude_markers_stripped(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        ws = os.path.join(tmp, "proj")
        os.makedirs(ws)
        log = os.path.join(tmp, "sessions", "x.log")
        seen = {}

        def fake_execv(prog, argv):
            # 在 execv 调用瞬间快照环境——这是预热会话实际继承到的环境。
            seen["prog"] = prog
            seen["argv"] = argv
            seen["env"] = dict(os.environ)

        with mock.patch.dict(os.environ,
                             {"CLAUDE_CODE_CHILD_SESSION": "parent-sid"},
                             clear=False), \
                mock.patch.object(d.os, "fork", return_value=0), \
                mock.patch.object(d.os, "execv", side_effect=fake_execv), \
                mock.patch.object(d.os, "umask"), \
                mock.patch.object(d.os, "setsid"), \
                mock.patch.object(d.os, "chdir"), \
                mock.patch.object(d.os, "dup2"), \
                mock.patch.object(d.os, "open", return_value=3), \
                mock.patch.object(d, "session_log_path", return_value=log), \
                mock.patch.object(d, "proc_started_at",
                                  return_value="start"):
            _pid, start = d.spawn_session(ws)
        self.assertEqual(seen["env"].get("DOORMAN_SESSION"), "1")
        self.assertNotIn("CLAUDE_CODE_CHILD_SESSION", seen["env"])
        self.assertFalse(any(k.startswith("CLAUDE_CODE_")
                             for k in seen["env"]))
        self.assertEqual(seen["prog"], "/usr/bin/script")
        self.assertEqual(seen["argv"][:3],
                         ["/usr/bin/script", "-q", log])
        self.assertEqual(start, "start")


class SessionScanTests(unittest.TestCase):
    """scan_sessions: one registry pass → consumer set + shape self-check."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.real_alive = d.alive
        for name in ("SESSION_DIR", "alive", "_pid_is_claude"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.SESSION_DIR = self.tmp
        self.live, self.claude = set(), set()
        d.alive = lambda pid: pid in self.live
        d._pid_is_claude = lambda pid: pid in self.claude

    def write_reg(self, name, pid, cwd, kind="interactive"):
        with open(os.path.join(self.tmp, name), "w") as f:
            json.dump({"pid": pid, "cwd": cwd, "kind": kind}, f)

    def test_live_claude_consumers_dead_and_other_kinds_ignored(self):
        self.live, self.claude = {101, 202}, {101, 202}
        self.write_reg("a.json", 101, os.path.realpath(self.tmp))
        self.write_reg("dead.json", 999, "/nowhere/dead")
        self.write_reg("other.json", 202, "/nowhere/x", kind="some-other")
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, {os.path.realpath(self.tmp)})
        self.assertIsNone(alert)

    def test_empty_directory_is_quiet(self):
        self.assertEqual(d.scan_sessions(), (set(), None))

    def test_registry_shape_change_alerts(self):
        # Files exist, none look interactive — the canary for an
        # undocumented registry format changing under us.
        self.write_reg("x.json", 1, "/a", kind="brand-new-kind")
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, set())
        self.assertIsNotNone(alert)

    def test_all_corrupt_files_alert(self):
        with open(os.path.join(self.tmp, "bad.json"), "w") as f:
            f.write("{ truncated")
        _, alert = d.scan_sessions()
        self.assertIsNotNone(alert)

    def test_transiently_unreadable_registration_is_retried(self):
        # Claude Code 会就地重写登记文件（非原子），读写相撞读到半个
        # JSON：睡一拍重读能拿回完整内容，这一轮不能误判成「无会话」。
        self.live, self.claude = {101}, {101}
        with open(os.path.join(self.tmp, "a.json"), "w") as f:
            f.write("占位：json.load 被接管，真实内容不参与")
        good = {"kind": "interactive", "pid": 101,
                "cwd": os.path.realpath(self.tmp)}
        with mock.patch.object(d.json, "load",
                               side_effect=[ValueError("mid-write"), good]), \
                mock.patch.object(d.time, "sleep") as sleep:
            consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, {os.path.realpath(self.tmp)})
        self.assertIsNone(alert)
        sleep.assert_called_once_with(0.1)

    def test_permanently_corrupt_registration_gives_up_after_one_retry(self):
        with open(os.path.join(self.tmp, "bad.json"), "w") as f:
            f.write("占位：json.load 被接管，真实内容不参与")
        with mock.patch.object(d.json, "load",
                               side_effect=ValueError("corrupt")), \
                mock.patch.object(d.time, "sleep") as sleep:
            consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, set())
        self.assertIsNotNone(alert)  # 有文件却读不出会话：自检告警仍在
        self.assertEqual(sleep.call_count, 1)  # 只重试一次，不无限纠缠

    def test_live_non_claude_process_alerts(self):
        # A recycled/other pid holding a registration: consumers must not
        # claim the workspace, and a registry full of these is a signal
        # that the launch shape changed.
        self.live = {101}
        self.write_reg("a.json", 101, os.path.realpath(self.tmp))
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, set())
        self.assertIsNotNone(alert)

    def test_malformed_pid_entries_are_skipped(self):
        # 登记文件是外部程序写的，pid 可能缺失、null、非数值、非正数、
        # 超出 pid_t 的巨大整数（json.load 甚至会读进 Infinity）：一律当
        # 「没有活进程」跳过，也不能计入 live_other 误触登记格式告警。
        # 必须用真实 alive 跑——这几道关是 scan_sessions 唯一的防线，漏
        # 一类就炸掉整轮巡检（它在 per-workspace 保护圈之外）。超大整数
        # 是最隐蔽的那类：int() 对 Python 整数是恒等运算，类型转换和
        # 「> 0」都拦不住它，只有 pid_t 上界挡得住，否则一路走到 os.kill
        # 抛 OverflowError。pid 缺失时兜底的 -1 会被 kill(-1, 0)（权限
        # 探测）读作存活。cwd 非字符串同理，会在 realpath 处抛
        # TypeError——活 pid 配畸形 cwd 也要安全跳过。
        d.alive = self.real_alive
        me = os.getpid()  # 一个确定存活的 pid：健康登记长这样
        d._pid_is_claude = lambda pid: pid == me
        self.write_reg("live.json", me, os.path.realpath(self.tmp))
        self.write_reg("null.json", None, "/a")
        self.write_reg("neg.json", -1, "/a")
        self.write_reg("junk.json", "abc", "/a")
        self.write_reg("huge.json", 10 ** 20, "/a")
        self.write_reg("cwdnum.json", me, 5)
        self.write_reg("cwdlist.json", me, ["/a"])
        # 空串/相对路径 cwd：realpath 会解析到巡检进程自己的 cwd 下，
        # 凭空造出一个「消费者」目录，可能令预热被静默跳过
        self.write_reg("cwdempty.json", me, "")
        self.write_reg("cwdrel.json", me, "some/relative/path")
        with open(os.path.join(self.tmp, "inf.json"), "w") as f:
            f.write('{"kind": "interactive", "pid": Infinity, "cwd": "/a"}')
        with open(os.path.join(self.tmp, "absent.json"), "w") as f:
            json.dump({"kind": "interactive", "cwd": "/a"}, f)
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, {os.path.realpath(self.tmp)})
        self.assertIsNone(alert)

    def test_registrations_without_pid_or_cwd_alert(self):
        # 登记还能认出 interactive，但 pid/cwd 字段集体读不出（改名、
        # 缺失）：前两条自检分别只看 kind 与进程形态，兜不住这种漂移，
        # consumers 会静默变空、已有会话旁边被重复拉起——第三条烟雾
        # 告警兜这个洞。
        self.live, self.claude = {101}, {101}
        with open(os.path.join(self.tmp, "nopid.json"), "w") as f:
            json.dump({"kind": "interactive", "cwd": "/a"}, f)
        self.write_reg("nocwd.json", 101, None)
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, set())
        self.assertIsNotNone(alert)
        self.assertIn("pid", alert)

    def test_dead_pid_registrations_are_quiet(self):
        # 进程已退出的陈旧登记是正常现象（Claude Code 崩溃会留下），
        # 不是格式漂移，不许误报。
        self.write_reg("stale.json", 999, "/a")
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, set())
        self.assertIsNone(alert)


class ClaudeProcessDetectionTests(unittest.TestCase):
    """_pid_is_claude：原生安装看 comm；npm/bun 形态是解释器进程，
    要到完整命令行里认 claude 入口路径。"""

    def detect(self, comm, args=""):
        def fake_run(cmd, **kw):
            if "comm=" in cmd:
                return mock.Mock(stdout=f"{comm}\n")
            return mock.Mock(stdout=f"{args}\n")
        with mock.patch.object(d.subprocess, "run", side_effect=fake_run):
            return d._pid_is_claude(42)

    def test_native_install_by_comm(self):
        self.assertTrue(self.detect("claude"))
        self.assertTrue(self.detect("/Users/u/.local/bin/claude"))

    def test_npm_install_via_interpreter_args(self):
        # bin/claude 是指向包内 cli.js 的符号链接，两种形态都要认
        self.assertTrue(self.detect("node", "node /opt/homebrew/bin/claude"))
        self.assertTrue(self.detect(
            "node", "node /opt/homebrew/lib/node_modules/"
                    "@anthropic-ai/claude-code/cli.js"))
        self.assertTrue(self.detect("bun", "bun /home/u/.bun/bin/claude -r"))
        self.assertTrue(self.detect("node", "node /x/claude/run.js"))

    def test_unrelated_processes_are_rejected(self):
        self.assertFalse(self.detect("node", "node server.js"))
        self.assertFalse(self.detect("node", "node claude.md"))
        # 非解释器进程绝不看命令行：参数里提到 claude 也不算
        self.assertFalse(self.detect("vim", "vim claude.md"))
        self.assertFalse(self.detect("zsh", ""))
        self.assertFalse(self.detect("python3", "python3 /x/claude"))

    def test_ps_failure_reads_as_not_claude(self):
        with mock.patch.object(d.subprocess, "run",
                               side_effect=OSError("ps gone")):
            self.assertFalse(d._pid_is_claude(42))


class PatrolLogRotateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(setattr, d, "LOG_DIR", d.LOG_DIR)
        d.LOG_DIR = self.tmp

    def touch(self, name, size=0):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as f:
            f.write(b"x" * size)
        return path

    def test_oversized_logs_are_renamed(self):
        out = self.touch("launchd.out.log", d.PATROL_LOG_ROTATE_BYTES + 1)
        d.rotate_patrol_logs()
        self.assertFalse(os.path.exists(out))
        self.assertTrue(os.path.exists(out + ".1"))

    def test_small_logs_are_left_alone(self):
        err = self.touch("launchd.err.log", 10)
        d.rotate_patrol_logs()
        self.assertTrue(os.path.exists(err))
        self.assertFalse(os.path.exists(err + ".1"))

    def test_existing_dot1_is_replaced(self):
        out = self.touch("launchd.out.log", d.PATROL_LOG_ROTATE_BYTES + 1)
        self.touch("launchd.out.log.1", 5)
        d.rotate_patrol_logs()
        self.assertEqual(os.path.getsize(out + ".1"),
                         d.PATROL_LOG_ROTATE_BYTES + 1)


class ProcessFingerprintTests(unittest.TestCase):
    def test_ps_start_time_runs_under_pinned_c_locale(self):
        # The lstart string is compared for exact equality across
        # launchd-driven and manual runs; localised ps output would make
        # our own session look like a recycled pid.
        with mock.patch.object(d.subprocess, "run",
                               return_value=mock.Mock(stdout="x")) as rr:
            d.proc_started_at(42)
        env = rr.call_args.kwargs["env"]
        self.assertEqual(env["LC_ALL"], "C")
        self.assertEqual(env["LANG"], "C")


class ListTests(unittest.TestCase):
    """cmd_list's MISSED column."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600})
        for name in ("discover", "read_tasks", "scan_sessions"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.scan_sessions = lambda: (set(), None)

    def render(self, tasks, consumers=set()):
        d.read_tasks = lambda ws: tasks
        d.scan_sessions = lambda: (consumers, None)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_list(argparse.Namespace(config=self.cfg_path))
        return buf.getvalue()

    def test_missed_one_shot_is_flagged(self):
        past = datetime.datetime.now() - datetime.timedelta(days=1)
        created = past - datetime.timedelta(hours=1)
        out = self.render([{
            "cron": f"{past.minute} {past.hour} {past.day} {past.month} *",
            "createdAt": int(created.timestamp() * 1000),
            "recurring": False}])
        self.assertIn("已错过", out)

    def test_unreadable_file_is_reported_as_such(self):
        # 读不出 ≠ 空：文件损坏时如实说任务不会执行，而不是报「均为空」。
        self.assertIn("全部读不出", self.render(None))

    def test_mixed_unreadable_and_empty_files_are_itemized(self):
        d.discover = lambda roots, depth: iter([(WS_PATH, "x"), ("/y", "y")])
        d.read_tasks = lambda ws: None if ws == WS_PATH else []
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_list(argparse.Namespace(config=self.cfg_path))
        out = buf.getvalue()
        self.assertIn("其中 1 个读不出", out)
        self.assertIn("其余的任务列表均为空", out)

    def test_one_shot_weeks_ahead_shows_its_date_not_missed(self):
        # Fires in ~60 days: inside the year-long display window, so its
        # date is shown (not "一年内无") — and it has not been missed.
        future = datetime.datetime.now() + datetime.timedelta(days=60)
        out = self.render([{
            "cron": f"{future.minute} {future.hour} {future.day} "
                    f"{future.month} *",
            "createdAt": int(time.time() * 1000), "recurring": False}])
        self.assertNotIn("已错过", out)
        self.assertIn(future.strftime("%m-%d %H:%M"), out)

    def test_valid_cron_that_never_fires_reads_as_such(self):
        # 2 月 30 日：字段都在界内（satisfiable），但一年窗口内扫不到任何
        # 触发点——显示「一年内无」而不是一个假日期。
        out = self.render([{"cron": "0 0 30 2 *", "recurring": True,
                            "prompt": "永不触发的任务"}])
        self.assertIn("一年内无", out)

    def test_each_task_gets_its_own_row_with_summary_and_cadence(self):
        out = self.render([
            {"cron": "5 0 * * *", "recurring": True,
             "prompt": "群人数每日定时任务：执行某脚本\n第二行细节不出现"},
            {"cron": "0 10 * * 0", "recurring": True,
             "prompt": "  周报任务：\n   做一些事"},
        ])
        self.assertIn("共 1 个工作区、2 个定时任务", out)
        self.assertIn("群人数每日定时任务：执行某脚本", out)
        self.assertIn("周报任务：", out)  # 只取首个非空行，剥掉首尾空白
        self.assertNotIn("第二行细节不出现", out)
        self.assertIn("5 0 * * *", out)
        self.assertIn("0 10 * * 0", out)
        self.assertIn("周期", out)
        self.assertIn("交互会话：无", out)

    def test_malformed_task_is_shown_not_dropped(self):
        out = self.render([{"cron": "not a cron", "prompt": "坏任务"}])
        self.assertIn("cron 无效", out)
        self.assertIn("坏任务", out)

    def test_task_without_prompt_gets_a_placeholder(self):
        out = self.render([{"cron": "5 0 * * *", "recurring": True}])
        self.assertIn("（无任务描述）", out)

    def test_consumer_column_reflects_single_scan(self):
        out = self.render(
            [{"cron": "5 0 * * *", "recurring": True}],
            consumers={WS_PATH})
        self.assertIn("交互会话：有", out)

    def test_rows_never_overflow_the_terminal_width(self):
        orig_terminal_width = d.terminal_width
        for width in (60, 80, 100, 200):
            d.terminal_width = lambda w=width: w
            self.addCleanup(setattr, d, "terminal_width", orig_terminal_width)
            out = self.render([
                {"cron": "5 0 * * *", "recurring": True,
                 "prompt": "短任务"},
                {"cron": "0 10 * * 0", "recurring": True,
                 "prompt": "很" * 300},
            ])
            for line in out.splitlines():
                self.assertLessEqual(
                    d.disp_width(line), width,
                    f"{width} 列下溢出：{line!r}")

    def test_permanent_recurring_is_labeled(self):
        out = self.render([
            {"cron": "5 0 * * *", "recurring": True, "permanent": True,
             "prompt": "长期任务"},
            {"cron": "0 10 * * 0", "recurring": True,
             "prompt": "普通周期任务"},
        ])
        self.assertIn("周期·永久", out)
        self.assertIn("普通周期任务", out)
        # Widening the kind column to fit「周期·永久」must not overflow.
        for line in out.splitlines():
            self.assertLessEqual(d.disp_width(line), d.terminal_width())


class OverviewTests(unittest.TestCase):
    """The bare `doorman` overview: inventory plus actionable alerts."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        write_json(self.cfg_path,
                   {"roots": [self.tmp], "maxDepth": 3,
                    "intervalSeconds": 300, "leadSeconds": 600})
        for name in ("discover", "read_tasks", "scan_sessions",
                     "launchctl_info", "STATE_PATH", "PLIST_PATH"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.scan_sessions = lambda: (set(), None)
        d.launchctl_info = lambda: {
            "state": "running", "last exit code": "0", "interval": 300}
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.PLIST_PATH = os.path.join(self.tmp, "missing.plist")
        self.args = argparse.Namespace(config=self.cfg_path)

    def render(self, tasks=None, state=None):
        d.read_tasks = lambda ws: tasks or []
        if state is not None:
            write_json(d.STATE_PATH, state)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_overview(self.args)
        return buf.getvalue()

    def test_empty_world_renders_cleanly(self):
        out = self.render()
        self.assertIn("doorman", out)
        self.assertIn("launchd 已加载", out)
        self.assertIn("任务：暂无", out)
        self.assertIn("无保活会话", out)
        self.assertIn("常用命令", out)

    def test_no_cooling_tail_when_nothing_is_cooling(self):
        # 没有冷却中的会话时不显示「冷却 0 个」——计数后缀只在有事时说。
        out = self.render()
        self.assertIn("会话：无保活会话", out)
        self.assertNotIn("冷却", out)

    def test_task_inventory_and_soonest_line(self):
        out = self.render([{
            "cron": "59 23 * * *", "recurring": True,
            "prompt": "晚间任务：收尾工作"}])
        self.assertIn("任务：1 个，分布在 1 个工作区", out)
        self.assertIn("晚间任务：收尾工作", out)
        self.assertIn("最近：", out)

    def test_wanted_without_consumer_is_an_alert(self):
        fire = datetime.datetime.now() + datetime.timedelta(minutes=2)
        out = self.render([{
            "cron": f"{fire.minute} {fire.hour} {fire.day} {fire.month} *",
            "recurring": False,
            "createdAt": int(time.time() * 1000),
            "prompt": "马上要跑的一次性任务"}])
        self.assertIn("需要留意", out)
        self.assertIn("即将执行（或错过待补执行）", out)
        self.assertIn("下轮巡检会自动启动", out)

    def test_pending_task_during_cooldown_gets_one_combined_alert(self):
        # "下轮会自动启动" and "冷却中" used to appear together for the
        # same workspace and contradict each other.
        fire = datetime.datetime.now() + datetime.timedelta(minutes=2)
        out = self.render(
            tasks=[{
                "cron": f"{fire.minute} {fire.hour} {fire.day} {fire.month} *",
                "recurring": False,
                "createdAt": int(time.time() * 1000),
                "prompt": "马上要跑的一次性任务"}],
            state={WS_PATH: {"pid": None, "fails": 3,
                             "cooldownUntil": int(time.time()) + 900}})
        self.assertIn("冷却中", out)
        self.assertNotIn("下轮巡检会自动启动", out)

    def test_bad_cron_and_cooldown_become_alerts(self):
        out = self.render(
            tasks=[{"cron": "broken", "prompt": "坏任务"}],
            state={WS_PATH: {"pid": None, "fails": 3,
                             "cooldownUntil": int(time.time()) + 900}})
        self.assertIn("cron 无法解析", out)
        self.assertIn("冷却中", out)

    def test_unreadable_task_file_is_alerted_not_ghosted(self):
        # 与巡检同一条规则：文件在却读不出，总览必须把它摆进「需要留意」，
        # 而不是从任务盘点里抹掉、装作一切正常。
        ws = os.path.join(self.tmp, "proj")
        os.makedirs(os.path.join(ws, ".claude"))
        with open(os.path.join(ws, ".claude", "scheduled_tasks.json"),
                  "w") as f:
            f.write("{ broken")
        d.discover = lambda roots, depth: iter([(ws, os.path.join(
            ws, ".claude", "scheduled_tasks.json"))])
        # 不走 render()：它会把 read_tasks 换成 None→[] 的 fake，而这里要
        # 让真实的 read_tasks 读出 None。
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_overview(self.args)
        self.assertIn("任务文件读不出", buf.getvalue())

    def test_corrupt_config_renders_the_whole_page(self):
        # 损坏配置不能让总览死在半路：服务、会话、命令都还得显示。
        with open(self.cfg_path, "w") as f:
            f.write("{ not valid json")
        out = self.render()
        self.assertIn("文件损坏", out)
        self.assertIn("会话：无保活会话", out)
        self.assertIn("常用命令", out)

    def test_missing_config_still_shows_sessions(self):
        # 会话信息来自 state.json，配置缺失时也要出现。
        os.remove(self.cfg_path)
        out = self.render(state={WS_PATH: {"pid": None, "fails": 3,
                                           "cooldownUntil": time.time() + 900}})
        self.assertIn("配置：缺失", out)
        self.assertIn("冷却 1 个", out)

    def test_non_int_numeric_fields_alert_instead_of_crashing(self):
        # 手改 config 把 leadSeconds 写成字符串：launchd 入口以退出码 2
        # 失败，总览不能在 timedelta(seconds=...) 处 traceback，要像损坏
        # 配置一样给出「需要留意」，页面其余部分照常。
        write_json(self.cfg_path,
                   {"roots": [self.tmp], "maxDepth": 3,
                    "intervalSeconds": 300, "leadSeconds": "600"})
        out = self.render()
        self.assertIn("leadSeconds", out)
        self.assertIn("应为整数秒", out)
        self.assertIn("需要留意", out)
        self.assertIn("会话：", out)

    def test_bool_numeric_fields_alert_like_other_bad_types(self):
        # true/false 是 int 子类，不能被当成合法的间隔/提前量
        write_json(self.cfg_path,
                   {"roots": [self.tmp], "maxDepth": 3,
                    "intervalSeconds": True, "leadSeconds": False})
        out = self.render()
        self.assertIn("应为整数秒", out)
        self.assertIn("需要留意", out)

    def test_live_session_outside_scan_scope_is_flagged(self):
        # 目录从巡检视野消失（任务文件被删/移出 roots）后，它的保活会话
        # 不再被回收或换代——总览必须把这种「无人管理」的会话点出来。
        me = os.getpid()
        d.discover = lambda roots, depth: iter([])
        out = self.render(state={WS_PATH: {
            "pid": me, "startedAt": int(time.time()) - 60,
            "procStart": None}})
        self.assertIn("已不在巡检范围", out)

    def test_live_session_inside_scan_scope_is_not_flagged(self):
        me = os.getpid()
        out = self.render(state={WS_PATH: {
            "pid": me, "startedAt": int(time.time()) - 60,
            "procStart": None}})
        self.assertIn("保活 1 个", out)
        self.assertNotIn("已不在巡检范围", out)

    def test_live_sessions_show_pid_and_dead_entries_are_counted(self):
        # 会话明细行并入总览后，pid 与失效条目计数是它独有的信息。
        me = os.getpid()  # tracked_alive 需要一个真实存活的 pid
        # startedAt 用整数（巡检写入的就是 int）；630 而非 600：渲染前还
        # 会流逝几毫秒，浮点边界会让 // 60 落到 9。
        out = self.render(state={
            WS_PATH: {"pid": me, "startedAt": int(time.time()) - 630,
                      "procStart": None},
            "/gone": {"pid": None, "fails": 1},
        })
        self.assertIn("保活 1 个", out)
        self.assertIn(f"pid {me}", out)
        self.assertIn("已运行 10 分钟", out)
        self.assertIn("已失效 1 个", out)

    def test_hand_edited_state_types_render_without_crashing(self):
        # 总览页的会话部分在 per-workspace 保护圈之外：手改 state 的
        # 数值字段（字符串 pid、字符串 cooldownUntil）不能让它 traceback。
        out = self.render(state={WS_PATH: {"pid": "123", "fails": 1,
                                           "cooldownUntil": "abc"}})
        self.assertIn("会话：", out)


class StateFileTests(unittest.TestCase):
    """load_state must survive a damaged file: it feeds the launchd path."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(setattr, d, "STATE_PATH", d.STATE_PATH)
        d.STATE_PATH = os.path.join(self.tmp, "state.json")

    def write(self, text):
        with open(d.STATE_PATH, "w") as f:
            f.write(text)

    def test_damaged_shapes_read_as_empty(self):
        for text in ("[]", "null", "42", '"text"', "{ truncated"):
            with self.subTest(text=text):
                self.write(text)
                self.assertEqual(d.load_state(), {})

    def test_non_dict_entries_are_dropped(self):
        self.write('{"/a": {"pid": 1}, "/b": "junk", "/c": null}')
        self.assertEqual(d.load_state(), {"/a": {"pid": 1}})

    def test_hand_edited_numeric_fields_cannot_crash_the_patrol(self):
        # 手改 state 写进字符串/浮点/负数/超大整数：数值字段在 load_state
        # 入口整型化并校验范围，否则 tracked_alive 的 waitpid/killpg 抛
        # TypeError、cooldownUntil 与 now 的比较抛 TypeError——而这两处
        # （cmd_run 的收尾过滤、总览页）都在 per-workspace 保护圈之外。
        # 负数 pid 还会被 waitpid/killpg 当成进程组号，可能误伤无辜进程。
        self.write('{"/a": {"pid": "123", "startedAt": "456", '
                   '"cooldownUntil": "789", "fails": 2}, '
                   '"/b": {"pid": [1], "fails": 1, "cooldownUntil": "abc"}, '
                   '"/c": {"pid": -5}, '
                   '"/d": {"pid": 100000000000000000000}, '
                   '"/e": {"pid": 1.5}}')
        st = d.load_state()
        cur = int(time.time())
        for ent in st.values():
            d.tracked_alive(ent)  # 保护圈之外的真实调用点，不许抛
            bool(ent.get("cooldownUntil", 0) > cur)
        self.assertEqual(st["/a"]["pid"], 123)       # 数字字符串按数值接受
        self.assertEqual(st["/a"]["startedAt"], 456)
        self.assertEqual(st["/a"]["cooldownUntil"], 789)
        self.assertIsNone(st["/b"]["pid"])           # 非数值作废
        self.assertNotIn("cooldownUntil", st["/b"])  # 坏时间戳按不存在
        self.assertIsNone(st["/c"]["pid"])           # 负数 pid 无意义
        self.assertIsNone(st["/d"]["pid"])           # 超出 pid_t
        self.assertEqual(st["/e"]["pid"], 1)         # 浮点截断（pid 1 必死）

    def test_non_numeric_fails_cannot_wedge_a_workspace(self):
        # fails 不做整型化的话，手改成字符串会让巡检在 fails+1 处抛
        # TypeError——每轮都被 per-workspace 保护圈接住，该工作区永远
        # 等不到会话。load_state 与其他数值字段一并清洗。
        self.write('{"/a": {"pid": 1, "fails": "abc"},'
                   ' "/b": {"pid": 1, "fails": "2"},'
                   ' "/c": {"pid": 1, "fails": 2.7}}')
        st = d.load_state()
        self.assertNotIn("fails", st["/a"])    # 非数值按「字段不存在」
        self.assertEqual(st["/b"]["fails"], 2)  # 数字字符串按数值接受
        self.assertEqual(st["/c"]["fails"], 2)  # 浮点截断

    def test_missing_file_reads_as_empty(self):
        self.assertEqual(d.load_state(), {})


class LogPathTests(unittest.TestCase):
    """`doorman logs` picks the patrol log, not whatever crashed once."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for name in ("LOG_DIR", "SESSION_LOG_DIR"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.LOG_DIR = self.tmp
        d.SESSION_LOG_DIR = os.path.join(self.tmp, "sessions")
        os.makedirs(d.SESSION_LOG_DIR)
        self.out = os.path.join(self.tmp, "launchd.out.log")
        self.err = os.path.join(self.tmp, "launchd.err.log")
        self.notes = []

    def resolve(self, workspace=None):
        return d.resolve_log_path(workspace, announce=self.notes.append)

    def test_stale_error_does_not_hide_the_patrol_log(self):
        # The real regression: one old crash used to mask every later round.
        with open(self.out, "w") as f:
            f.write("patrol ok\n")
        with open(self.err, "w") as f:
            f.write("SyntaxError from days ago\n")
        self.assertEqual(self.resolve(), self.out)
        self.assertTrue(any("巡检若异常先看它" in n for n in self.notes))

    def test_empty_error_log_is_not_mentioned(self):
        with open(self.out, "w") as f:
            f.write("patrol ok\n")
        open(self.err, "w").close()
        self.assertEqual(self.resolve(), self.out)
        self.assertEqual(self.notes, [])

    def test_falls_back_to_stderr_before_the_first_patrol(self):
        with open(self.err, "w") as f:
            f.write("boom\n")
        self.assertEqual(self.resolve(), self.err)

    def test_workspace_fragment_matches_one_session_log(self):
        path = os.path.join(d.SESSION_LOG_DIR, "Users_me_team-space.log")
        open(path, "w").close()
        self.assertEqual(self.resolve("team"), path)

    def test_unmatched_fragment_returns_none(self):
        self.assertIsNone(self.resolve("nothing-here"))

    def test_ambiguous_fragment_exits_with_the_candidates(self):
        for name in ("Users_me_a-space.log", "Users_me_b-space.log"):
            open(os.path.join(d.SESSION_LOG_DIR, name), "w").close()
        with self.assertRaises(SystemExit):
            self.resolve("space")
        self.assertTrue(any("a-space" in n for n in self.notes))

    def test_rotated_dot1_logs_are_not_candidates(self):
        # 轮转过一次的工作区不该永远被报成「匹配到多个」。
        path = os.path.join(d.SESSION_LOG_DIR, "Users_me_proj.log")
        open(path, "w").close()
        open(path + ".1", "w").close()
        self.assertEqual(self.resolve("proj"), path)

    def test_absolute_path_recovers_the_on_disk_case(self):
        # 日志文件名由工作区路径折成，而 spawn 记的是 discover 规范化后的
        # 真实大小写：敲错大小写的绝对路径必须认回同一个文件，而不是报
        # 「找不到」。
        root = os.path.realpath(self.tmp)
        os.makedirs(os.path.join(root, "MyProj"))
        path = d.session_log_path(os.path.join(root, "MyProj"))
        open(path, "w").close()
        typed = os.path.join(root, "myproj")
        if not os.path.isdir(typed):
            self.skipTest("大小写敏感的文件系统上无法构造该场景")
        self.assertEqual(self.resolve(typed), path)


class SessionLogPathTests(unittest.TestCase):
    """日志文件名 slug：下划线转义在斜杠折叠之前，路径不再撞名。"""

    def test_similar_workspaces_do_not_collide(self):
        self.assertNotEqual(d.session_log_path("/a/b"),
                            d.session_log_path("/a_b"))

    def test_mapping_shape(self):
        self.assertTrue(d.session_log_path("/a/b").endswith("a_b.log"))
        self.assertTrue(d.session_log_path("/a_b").endswith("a__b.log"))
        self.assertTrue(d.session_log_path("/x").endswith("x.log"))


class InstallArgTests(unittest.TestCase):
    """cmd_install with the system-touching parts stubbed out."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for attr in ("APP_SUPPORT", "SESSION_LOG_DIR", "CONFIG_PATH",
                     "STATE_PATH", "BIN_PATH", "PLIST_PATH"):
            self.addCleanup(setattr, d, attr, getattr(d, attr))
        d.APP_SUPPORT = self.tmp
        d.SESSION_LOG_DIR = os.path.join(self.tmp, "sessions")
        d.CONFIG_PATH = os.path.join(self.tmp, "config.json")
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.BIN_PATH = os.path.join(self.tmp, "bin", "doorman")
        d.PLIST_PATH = os.path.join(self.tmp, "doorman.plist")
        for name in ("launchctl", "cmd_run"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.launchctl = lambda *a, **k: mock.Mock(returncode=0, stderr="")
        d.cmd_run = lambda *a, **k: None

    def install(self, **kw):
        args = argparse.Namespace(roots=self.tmp, interval=None, lead=None,
                                  force=True)
        for k, v in kw.items():
            setattr(args, k, v)
        with mock.patch("sys.stdout"):
            d.cmd_install(args)
        return read_json(d.CONFIG_PATH)

    def test_first_patrol_message_matches_what_actually_happened(self):
        # install 与 launchd 的巡检撞车时首轮是被跳过的，不能照常说「完成」。
        for ran, expect in ((True, "首轮巡检完成"),
                            (False, "首轮巡检暂未执行")):
            with self.subTest(ran=ran):
                d.cmd_run = mock.Mock(return_value=ran)
                args = argparse.Namespace(roots=self.tmp, interval=None,
                                          lead=None, force=True)
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    d.cmd_install(args)
                self.assertIn(expect, buf.getvalue())

    def test_installed_copy_points_at_upgrade_instead_of_pretending(self):
        # 已安装副本再跑 install：二进制无从更新，必须说破并指向 upgrade，
        # 而不是静默跳过、照常打印「已安装命令行」装作升级成功。
        d.BIN_PATH = os.path.realpath(d.__file__)
        args = argparse.Namespace(roots=self.tmp, interval=None,
                                  lead=None, force=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_install(args)
        self.assertIn("doorman upgrade", buf.getvalue())
        self.assertNotIn("已安装命令行", buf.getvalue())

    def test_zero_lead_is_an_explicit_choice_not_a_missing_flag(self):
        # `if args.lead:` dropped --lead 0 silently; 0 means "no lead time"
        # and is legal, so it must survive into the config.
        self.assertEqual(self.install(lead=0)["leadSeconds"], 0)

    def test_zero_interval_is_rejected_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            self.install(interval=0)
        self.assertEqual(ctx.exception.code, 1)

    def test_non_object_legacy_config_is_ignored_on_force(self):
        # 手改成合法 JSON 但顶层不是对象：--force 合并旧配置时不能
        # 在 dict.update 上抛 TypeError，按没有旧值、全部默认处理。
        with open(d.CONFIG_PATH, "w") as f:
            f.write("123")
        cfg = self.install()
        self.assertEqual(cfg["intervalSeconds"],
                         d.DEFAULT_CONFIG["intervalSeconds"])
        self.assertEqual(cfg["roots"], [self.tmp])

    def test_bool_interval_in_config_is_rejected_loudly(self):
        # true 是 int 的子类，不能被 isinstance(int) 当成合法间隔：
        # 手改进现有配置的布尔值要在安装校验处被拦下。
        write_json(d.CONFIG_PATH,
                   {"roots": [self.tmp], "maxDepth": 2,
                    "intervalSeconds": True, "leadSeconds": 600})
        with self.assertRaises(SystemExit) as ctx:
            self.install()
        self.assertEqual(ctx.exception.code, 1)

    def test_explicitly_empty_roots_is_rejected_loudly(self):
        # `--roots ,` 解析不出任何有效目录：必是手误，静默写进配置
        # 会让巡检从此空转。
        with self.assertRaises(SystemExit) as ctx:
            self.install(roots=",")
        self.assertEqual(ctx.exception.code, 1)

    def test_default_roots_prints_a_safety_notice(self):
        # 未指定 --roots 落到默认全家目录：自动续期会把今后 clone 进来
        # 的任何周期任务永久化，这一点要在安装时当面说清。
        args = argparse.Namespace(roots=None, interval=None, lead=None,
                                  force=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_install(args)
        self.assertIn("--roots", buf.getvalue())
        self.assertIn("clone", buf.getvalue())

    def test_explicit_roots_prints_no_safety_notice(self):
        args = argparse.Namespace(roots=self.tmp, interval=None, lead=None,
                                  force=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_install(args)
        self.assertNotIn("今后 clone", buf.getvalue())

    def test_omitted_flags_preserve_existing_values(self):
        self.install(lead=45)
        cfg = self.install(interval=120)
        self.assertEqual(cfg["leadSeconds"], 45)
        self.assertEqual(cfg["intervalSeconds"], 120)

    def test_binary_is_installed_atomically(self):
        # The installed binary is launchd's entry point and is overwritten
        # while patrols may be starting: no truncated intermediate state.
        real_replace = os.replace
        seen = []

        def spy(src, dst):
            if dst == d.BIN_PATH:
                seen.append((os.path.exists(dst), os.path.getsize(src)))
            return real_replace(src, dst)

        with mock.patch("os.replace", side_effect=spy):
            self.install()
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1], os.path.getsize(os.path.abspath(BIN)))
        self.assertTrue(os.access(d.BIN_PATH, os.X_OK))

    def test_auto_renew_flags_set_the_value(self):
        self.assertIs(self.install(auto_renew=True)["autoRenew"], True)
        self.assertIs(self.install(auto_renew=False)["autoRenew"], False)

    def test_omitted_auto_renew_flag_preserves_existing_value(self):
        self.install(auto_renew=False)
        self.assertIs(self.install()["autoRenew"], False)

    def test_legacy_config_without_the_key_defaults_on(self):
        # Upgrade path: a config written before autoRenew existed inherits the
        # default, so the first post-upgrade patrol tags existing recurring
        # tasks — the intended "renew on upgrade" behaviour.
        write_json(d.CONFIG_PATH, {"roots": [self.tmp], "maxDepth": 2,
                                   "intervalSeconds": 300, "leadSeconds": 600})
        self.assertIs(d.load_config(d.CONFIG_PATH)["autoRenew"], True)

    def test_non_bool_auto_renew_is_coerced_to_default(self):
        write_json(d.CONFIG_PATH, {"roots": [self.tmp], "maxDepth": 2,
                                   "intervalSeconds": 300, "leadSeconds": 600,
                                   "autoRenew": "yes"})
        self.assertIs(d.load_config(d.CONFIG_PATH)["autoRenew"], True)


class UninstallTests(unittest.TestCase):
    """卸载即解除管理：自己启动的保活会话默认一并结束，不留孤儿。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for name in ("STATE_PATH", "PLIST_PATH", "APP_SUPPORT", "LOG_DIR",
                     "BIN_PATH", "launchctl", "stop_session",
                     "tracked_alive"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.PLIST_PATH = os.path.join(self.tmp, "x.plist")
        d.APP_SUPPORT = os.path.join(self.tmp, "support")
        d.LOG_DIR = os.path.join(self.tmp, "logs")
        d.BIN_PATH = os.path.join(self.tmp, "bin")
        d.launchctl = lambda *a, **k: mock.Mock(returncode=0)
        self.stopped = []
        d.stop_session = lambda ent: self.stopped.append(ent.get("pid"))
        d.tracked_alive = lambda ent: bool(ent.get("pid"))

    def uninstall(self, **kw):
        args = argparse.Namespace(purge=False, keep_sessions=False)
        for k, v in kw.items():
            setattr(args, k, v)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            d.cmd_uninstall(args)
        return buf.getvalue()

    def test_sessions_are_stopped_by_default(self):
        write_json(d.STATE_PATH,
                   {"/x": {"pid": 11}, "/y": {"pid": 22}})
        out = self.uninstall()
        self.assertEqual(sorted(self.stopped), [11, 22])
        self.assertIn("正在结束保活会话", out)

    def test_keep_sessions_leaves_them_running(self):
        write_json(d.STATE_PATH, {"/x": {"pid": 11}})
        self.uninstall(keep_sessions=True)
        self.assertEqual(self.stopped, [])

    def test_legacy_stop_sessions_flag_is_gone(self):
        # 旧拼法 --stop-sessions 已删除：个人工具不留双拼法，未知参数
        # 必须像其他误输一样报用法错误（argparse 退出码 2）。
        with mock.patch.object(
                sys, "argv", ["doorman", "uninstall", "--stop-sessions"]), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                d.main()
        self.assertEqual(ctx.exception.code, 2)


class CliTests(unittest.TestCase):
    """--config 挂在主解析器和每个子解析器上，写在子命令前后都认。

    只认一个位置时，报错提示只说「用 --config 指定路径」而不说放哪，
    用户每次都得以试错换答案。
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg = os.path.join(self.tmp, "config.json")
        write_json(self.cfg, {"roots": [], "maxDepth": 2,
                              "intervalSeconds": 300, "leadSeconds": 600})
        self.addCleanup(setattr, d, "scan_sessions", d.scan_sessions)
        d.scan_sessions = lambda: (set(), None)

    def run_main(self, argv):
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", argv), \
                contextlib.redirect_stdout(buf):
            d.main()
        return buf.getvalue()

    def test_config_flag_before_the_subcommand(self):
        self.assertIn("没有发现定时任务文件",
                      self.run_main(["doorman", "--config", self.cfg, "list"]))

    def test_config_flag_after_the_subcommand(self):
        self.assertIn("没有发现定时任务文件",
                      self.run_main(["doorman", "list", "--config", self.cfg]))

    def test_config_flag_defaults_to_being_absent(self):
        # 没给 --config 时属性根本不落上（与「给了但是 None」不同），读取处
        # 因此统一 getattr。一旦有人去掉 SUPPRESS 默认值，这条就红。
        captured = {}
        with mock.patch.object(
                d, "cmd_list", lambda args: captured.update(vars(args))):
            self.run_main(["doorman", "list"])
        self.assertNotIn("config", captured)


class UpgradeTests(unittest.TestCase):
    """cmd_upgrade: 从 GitHub release 拉取、校验、原子替换、新二进制首巡。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.bin = os.path.join(self.tmp, "doorman")
        with open(self.bin, "w") as f:
            f.write('VERSION = "0.1.9"\n')
        for name in ("BIN_PATH", "latest_release", "_download"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.BIN_PATH = self.bin

    def good_blob(self):
        blob = b"#!/usr/bin/env python3\nVERSION = \"9.9.9\"\n"
        sums = f"{hashlib.sha256(blob).hexdigest()}  doorman\n".encode()
        return blob, sums

    def run_upgrade(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            try:
                d.cmd_upgrade(argparse.Namespace())
            except SystemExit as e:
                return e.code, out.getvalue(), err.getvalue()
        return 0, out.getvalue(), err.getvalue()

    def test_upgrade_replaces_binary_after_checksum_verifies(self):
        blob, sums = self.good_blob()
        d.latest_release = lambda: ("v9.9.9", "https://x/doorman", "https://x/s")
        d._download = mock.Mock(side_effect=[blob, sums])
        with mock.patch.object(d.subprocess, "run", return_value=mock.Mock(
                returncode=0, stdout="", stderr="")):
            code, out, _ = self.run_upgrade()
        self.assertEqual(code, 0)
        self.assertIn("已升级 0.1.9 → 9.9.9", out)
        self.assertIn("首轮巡检完成", out)
        with open(self.bin, "rb") as f:
            self.assertEqual(f.read(), blob)

    def test_checksum_mismatch_aborts_and_keeps_old_binary(self):
        blob, _ = self.good_blob()
        bad_sums = b"deadbeef" * 8 + b"  doorman\n"
        d.latest_release = lambda: ("v9.9.9", "u1", "u2")
        d._download = mock.Mock(side_effect=[blob, bad_sums])
        code, _, err = self.run_upgrade()
        self.assertEqual(code, 1)
        self.assertIn("校验失败", err)
        with open(self.bin) as f:
            self.assertIn("0.1.9", f.read())

    def test_already_latest_skips_download(self):
        d.latest_release = lambda: ("v0.1.9", "u1", "u2")
        d._download = mock.Mock(
            side_effect=AssertionError("已是最新时不该下载"))
        code, out, _ = self.run_upgrade()
        self.assertEqual(code, 0)
        self.assertIn("已是最新", out)

    def test_api_failure_exits_with_one_line(self):
        d.latest_release = mock.Mock(side_effect=OSError("无网络"))
        code, _, err = self.run_upgrade()
        self.assertEqual(code, 1)
        self.assertIn("查询最新 release 失败", err)

    def test_upgrade_without_installation_points_at_install(self):
        os.remove(self.bin)
        code, _, err = self.run_upgrade()
        self.assertEqual(code, 1)
        self.assertIn("全新安装", err)

    def test_failed_first_patrol_is_reported(self):
        blob, sums = self.good_blob()
        d.latest_release = lambda: ("v9.9.9", "u1", "u2")
        d._download = mock.Mock(side_effect=[blob, sums])
        with mock.patch.object(d.subprocess, "run", return_value=mock.Mock(
                returncode=2, stdout="", stderr="配置损坏")):
            code, _, err = self.run_upgrade()
        self.assertEqual(code, 1)
        self.assertIn("退出码 2", err)
        self.assertIn("配置损坏", err)


class RenewTests(unittest.TestCase):
    """renew_workspace tags recurring tasks permanent: atomically, exactly
    once, and without disturbing anything else in the file."""

    RECURRING = {
        "id": "abc", "cron": "0 5 * * *",
        "prompt": "kaboo 上报，结果通过木偶发到群里",
        "createdAt": 1790150238473, "recurring": True,
        "createdBySessionId": "sess-1", "lastFiredAt": 1790166600547,
    }

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)
        self.dir = os.path.join(self.ws, ".claude")
        os.makedirs(self.dir)
        self.path = os.path.join(self.dir, "scheduled_tasks.json")

    def put(self, doc, mode=None):
        with open(self.path, "w") as f:
            json.dump(doc, f, ensure_ascii=False)
        if mode is not None:
            os.chmod(self.path, mode)

    def raw(self):
        with open(self.path) as f:
            return f.read()

    def test_tags_recurring_and_preserves_everything_else(self):
        self.put({"tasks": [dict(self.RECURRING)], "version": 7})
        self.assertEqual(d.renew_workspace(self.path), 1)
        doc = read_json(self.path)
        task = doc["tasks"][0]
        self.assertIs(task["permanent"], True)
        for key, value in self.RECURRING.items():
            self.assertEqual(task[key], value)  # no other field touched
        self.assertEqual(doc["version"], 7)     # unknown top-level key kept

    def test_chinese_prompt_is_written_literally(self):
        self.put({"tasks": [dict(self.RECURRING)]})
        d.renew_workspace(self.path)
        text = self.raw()
        self.assertIn("群里", text)
        self.assertNotIn("\\u", text)

    def test_second_run_is_a_byte_for_byte_noop(self):
        self.put({"tasks": [dict(self.RECURRING)]})
        self.assertEqual(d.renew_workspace(self.path), 1)
        first = os.stat(self.path)
        self.assertEqual(d.renew_workspace(self.path), 0)
        second = os.stat(self.path)
        # Returning 0 must not even open the file for writing: same inode and
        # mtime prove the 5-minute patrol will not rewrite it for ever.
        self.assertEqual((first.st_ino, first.st_mtime_ns),
                         (second.st_ino, second.st_mtime_ns))

    def test_only_explicit_recurring_tasks_are_eligible(self):
        self.put({"tasks": [
            dict(self.RECURRING),
            {**dict(self.RECURRING), "id": "already", "permanent": True},
            {"id": "oneshot", "cron": "0 9 1 1 *", "createdAt": 1,
             "recurring": False},
            {"id": "flagless", "cron": "0 9 * * *", "createdAt": 1},
        ]})
        self.assertEqual(d.renew_workspace(self.path), 1)
        tasks = read_json(self.path)["tasks"]
        self.assertIs(tasks[0]["permanent"], True)
        self.assertIs(tasks[1]["permanent"], True)
        self.assertNotIn("permanent", tasks[2])
        self.assertNotIn("permanent", tasks[3])

    def test_any_truthy_permanent_is_already_exempt(self):
        for flag in (True, "yes", 1):
            with self.subTest(flag=flag):
                self.put({"tasks": [{**dict(self.RECURRING),
                                     "permanent": flag}]})
                before = self.raw()
                self.assertEqual(d.renew_workspace(self.path), 0)
                self.assertEqual(before, self.raw())

    def test_malformed_documents_return_none_untouched(self):
        for text in ("{ broken", '{"tasks": "x"}', "[]", "null"):
            with self.subTest(text=text):
                with open(self.path, "w") as f:
                    f.write(text)
                before = self.raw()
                self.assertIsNone(d.renew_workspace(self.path))
                self.assertEqual(before, self.raw())

    def test_missing_file_returns_none(self):
        # setUp creates the .claude dir but never the task file.
        self.assertIsNone(d.renew_workspace(self.path))

    def test_nondict_entries_and_unknown_keys_survive(self):
        self.put({"tasks": [dict(self.RECURRING), "junk", None, 5],
                  "extraTop": {"nested": True}})
        d.renew_workspace(self.path)
        doc = read_json(self.path)
        self.assertEqual(doc["extraTop"], {"nested": True})
        self.assertEqual(doc["tasks"][1:], ["junk", None, 5])

    def test_file_mode_is_preserved(self):
        for mode in (0o600, 0o640, 0o644):
            with self.subTest(mode=oct(mode)):
                self.put({"tasks": [dict(self.RECURRING)]}, mode=mode)
                d.renew_workspace(self.path)
                self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode),
                                 mode)

    def test_atomic_write_refuses_a_stale_mtime(self):
        self.put({"tasks": [dict(self.RECURRING)]})
        stale_mtime = os.stat(self.path).st_mtime_ns
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"tasks": []}, f)  # Claude Code's newer write
        with self.assertRaises(d.TaskFileChanged):
            d.atomic_write_json(self.path, {"tasks": [{"x": 1}]},
                                stale_mtime)
        self.assertEqual(read_json(self.path)["tasks"], [])
        self.assertFalse(os.path.exists(self.path + ".tmp"))

    def test_concurrent_change_mid_update_is_not_clobbered(self):
        self.put({"tasks": [dict(self.RECURRING)]})
        orig_load = d.load_task_doc

        def racy(path):
            doc = orig_load(path)
            # Simulate Claude Code committing an update after doorman read the
            # document but before it writes its tag back.
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"tasks": [{"id": "cc-wins"}]}, f)
            return doc

        d.load_task_doc = racy
        self.addCleanup(setattr, d, "load_task_doc", orig_load)
        with self.assertRaises(d.TaskFileChanged):
            d.renew_workspace(self.path)
        # The REPL's newer document survives; no .tmp is left behind.
        self.assertEqual(read_json(self.path),
                         {"tasks": [{"id": "cc-wins"}]})
        self.assertFalse(os.path.exists(self.path + ".tmp"))

    def test_task_view_exposes_the_permanent_flag(self):
        base = {"cron": "5 0 * * *", "prompt": "x", "createdAt": 0}
        self.assertTrue(d.task_view({**base, "recurring": True,
                                     "permanent": True}, NOW)["permanent"])
        self.assertFalse(d.task_view({**base, "recurring": True},
                                     NOW)["permanent"])
        # A one-shot carrying the field is not reported as a permanent
        # recurring job — permanent only modifies the recurring kind.
        self.assertFalse(d.task_view({**base, "recurring": False,
                                      "permanent": True}, NOW)["permanent"])


class RunRenewTests(unittest.TestCase):
    """autoRenew wires renewal into cmd_run; cmd_renew works on its own."""

    FAR = "0 0 1 1 *"  # Jan 1st: nothing fires within a September 7-day window

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "root")
        os.makedirs(self.root)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        for name in ("STATE_PATH", "scan_sessions", "acquire_run_lock",
                     "rotate_patrol_logs", "list_script_processes"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.scan_sessions = lambda: (set(), None)
        d.acquire_run_lock = lambda: 1
        d.rotate_patrol_logs = lambda: None
        d.list_script_processes = lambda: []

    def make_ws(self, name, doc):
        ws = os.path.join(self.root, name)
        os.makedirs(os.path.join(ws, ".claude"))
        path = os.path.join(ws, ".claude", "scheduled_tasks.json")
        with open(path, "w") as f:
            json.dump(doc, f, ensure_ascii=False)
        return path

    def write_cfg(self, auto_renew):
        write_json(self.cfg_path,
                   {"roots": [self.root], "maxDepth": 3,
                    "intervalSeconds": 300, "leadSeconds": 600,
                    "autoRenew": auto_renew})

    def read(self, path):
        with open(path) as f:
            return f.read()

    def recurring(self, task_id="a"):
        return {"id": task_id, "cron": self.FAR, "recurring": True,
                "prompt": "周期任务", "createdAt": 1790000000000}

    def run_cmd(self, func):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            func(argparse.Namespace(config=self.cfg_path))
        return buf.getvalue()

    def test_patrol_tags_when_auto_renew_enabled(self):
        path = self.make_ws("a", {"tasks": [self.recurring()]})
        self.write_cfg(True)
        self.run_cmd(d.cmd_run)
        self.assertIs(read_json(path)["tasks"][0]["permanent"], True)

    def test_patrol_leaves_the_file_untouched_when_disabled(self):
        path = self.make_ws("a", {"tasks": [self.recurring()]})
        self.write_cfg(False)
        before = self.read(path)
        self.run_cmd(d.cmd_run)
        self.assertEqual(before, self.read(path))

    def test_manual_renew_tags_all_regardless_of_the_flag(self):
        p1 = self.make_ws("a", {"tasks": [self.recurring("a")]})
        p2 = self.make_ws("b", {"tasks": [
            {**self.recurring("b"), "permanent": True}]})
        p3 = self.make_ws("c", None)  # "null": malformed → skipped
        self.write_cfg(False)          # explicit renew ignores autoRenew
        out = self.run_cmd(d.cmd_renew)
        self.assertIs(read_json(p1)["tasks"][0]["permanent"], True)
        self.assertIn("已续期", out)
        self.assertIn("已是最新", out)
        self.assertIn("跳过", out)
        self.assertIn("本次续期 1 个任务", out)
        self.assertEqual(self.read(p3), "null")

    def test_manual_renew_waits_its_turn_when_locked(self):
        d.acquire_run_lock = lambda: None
        path = self.make_ws("a", {"tasks": [self.recurring()]})
        before = self.read(path)
        out = self.run_cmd(d.cmd_renew)
        self.assertEqual(before, self.read(path))
        self.assertIn("稍后重试", out)

    def test_run_reports_whether_it_actually_ran(self):
        # install 末尾靠这个返回值决定说「首轮巡检完成」还是「被跳过」：
        # 抢不到锁时必须说得出来，否则紧接着的两行输出自相矛盾。
        self.write_cfg(True)
        args = argparse.Namespace(config=self.cfg_path)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertIs(d.cmd_run(args), True)
            d.acquire_run_lock = lambda: None
            self.assertIs(d.cmd_run(args), False)
        self.assertIn("本轮跳过", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
