"""Unit tests for doorman. Run: /usr/bin/python3 -m unittest discover -s tests

Zero third-party dependencies; the binary under test has no .py extension, so
it is loaded explicitly via SourceFileLoader.
"""

import argparse
import contextlib
import datetime
import io
import json
import os
import shutil
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


class CronHumanizeTests(unittest.TestCase):
    def h(self, expr):
        return d.humanize_cron(d.Cron(expr), expr)

    def test_common_shapes(self):
        self.assertEqual(self.h("5 0 * * *"), "每天 00:05")
        self.assertEqual(self.h("*/5 * * * *"), "每 5 分钟")
        self.assertEqual(self.h("0 10 * * 0"), "每周日 10:00")
        self.assertEqual(self.h("0 9 * * 1-5"),
                         "每周一、周二、周三、周四、周五 09:00")
        self.assertEqual(self.h("30 4 1,15 * *"), "每月 1、15 日 04:30")
        self.assertEqual(self.h("7 * * * *"), "每小时第 7 分")

    def test_complex_or_ambiguous_shapes_are_quoted_raw(self):
        # DoM 与 DoW 同时受限是 OR 语义，人话必然有歧义，照抄原表达式。
        self.assertEqual(self.h("0 18 20 * 1"), "cron 0 18 20 * 1")
        self.assertEqual(self.h("0 0 1 1 *"), "cron 0 0 1 1 *")

    def test_minute_hour_shortcuts_require_unrestricted_dates(self):
        # 日期/星期/月份受限时，「每 N 分钟」「每小时第 N 分」会丢掉
        # 日期限定，必须照抄原表达式。
        self.assertEqual(self.h("*/5 * 1 * *"), "cron */5 * 1 * *")
        self.assertEqual(self.h("7 * * * 1"), "cron 7 * * * 1")
        # 非等步长、也不是单点的分钟集合同样照抄。
        self.assertEqual(self.h("3,33 * * * *"), "cron 3,33 * * * *")

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

    def test_corrupt_json_exits_cleanly(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            f.write("{ not valid json")
            path = f.name
        self.addCleanup(os.unlink, path)
        with self.assertRaises(SystemExit) as ctx:
            d.load_config(path)
        self.assertEqual(ctx.exception.code, 2)

    def test_missing_config_exits_cleanly_for_launchd(self):
        # `run` is launchd's entry point: a deleted config must produce a
        # one-line reason, not a traceback with exit code 0.
        with self.assertRaises(SystemExit) as ctx:
            d.load_config("/nonexistent/doorman-config.json")
        self.assertEqual(ctx.exception.code, 2)

    def test_status_still_sees_a_missing_config_as_absent(self):
        # `status` reports absence as part of its output, so it opts out.
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

    def test_satisfiable_crons_still_resolve(self):
        # A DoM/DoW OR expression where one side alone is out of range.
        self.assertEqual(d.Cron("0 12 99 * 1").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 12, 0))

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


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        # Module globals are patched wholesale below; restore them so test
        # order never matters.
        for name in ("STATE_PATH", "alive", "proc_started_at", "discover",
                     "read_tasks", "has_consumer", "spawn_session",
                     "stop_session", "acquire_run_lock"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600})
        self.alive_pids = set()
        self.next_pid = 100
        self.consumer = False

        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.read_tasks = lambda ws: [{"cron": "*/5 * * * *", "createdAt": 0}]
        d.has_consumer = lambda ws: self.consumer
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


class ListTests(unittest.TestCase):
    """cmd_list's MISSED column."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600})
        for name in ("discover", "read_tasks", "has_consumer"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.has_consumer = lambda ws: False

    def render(self, tasks):
        d.read_tasks = lambda ws: tasks
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

    def test_one_shot_beyond_the_window_is_not_missed(self):
        # Fires in ~60 days: outside the search window, so next_after is None
        # — but it has not been missed, and must not be reported as such.
        future = datetime.datetime.now() + datetime.timedelta(days=60)
        out = self.render([{
            "cron": f"{future.minute} {future.hour} {future.day} "
                    f"{future.month} *",
            "createdAt": int(time.time() * 1000), "recurring": False}])
        self.assertNotIn("已错过", out)
        self.assertIn("无安排", out)

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
        self.assertIn("每天 00:05", out)
        self.assertIn("每周日 10:00", out)
        self.assertIn("周期", out)
        self.assertIn("交互会话：无", out)

    def test_malformed_task_is_shown_not_dropped(self):
        out = self.render([{"cron": "not a cron", "prompt": "坏任务"}])
        self.assertIn("cron 无效", out)
        self.assertIn("坏任务", out)

    def test_task_without_prompt_gets_a_placeholder(self):
        out = self.render([{"cron": "5 0 * * *", "recurring": True}])
        self.assertIn("（无任务描述）", out)

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


class OverviewTests(unittest.TestCase):
    """The bare `doorman` overview: inventory plus actionable alerts."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        write_json(self.cfg_path,
                   {"roots": [self.tmp], "maxDepth": 3,
                    "intervalSeconds": 300, "leadSeconds": 600})
        for name in ("discover", "read_tasks", "has_consumer",
                     "launchctl_info", "STATE_PATH", "PLIST_PATH"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.discover = lambda roots, depth: iter([(WS_PATH, "x")])
        d.has_consumer = lambda ws: False
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
        self.assertIn("已进入提前启动窗口", out)

    def test_bad_cron_and_cooldown_become_alerts(self):
        out = self.render(
            tasks=[{"cron": "broken", "prompt": "坏任务"}],
            state={WS_PATH: {"pid": None, "fails": 3,
                             "cooldownUntil": int(time.time()) + 900}})
        self.assertIn("cron 无法解析", out)
        self.assertIn("冷却中", out)


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

    def test_zero_lead_is_an_explicit_choice_not_a_missing_flag(self):
        # `if args.lead:` dropped --lead 0 silently; 0 means "no lead time"
        # and is legal, so it must survive into the config.
        self.assertEqual(self.install(lead=0)["leadSeconds"], 0)

    def test_zero_interval_is_rejected_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            self.install(interval=0)
        self.assertEqual(ctx.exception.code, 1)

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


if __name__ == "__main__":
    unittest.main()
