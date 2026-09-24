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
import stat
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

    def test_corrupt_json_can_be_raised_for_human_pages(self):
        # launchd 入口走默认的 exit(2)；总览选择接住后继续渲染。
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            f.write("{ not valid json")
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
                     "read_tasks", "scan_sessions", "spawn_session",
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
        d.scan_sessions = lambda: (
            ({WS_PATH} if self.consumer else set(), None))
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
        for name in ("SESSION_DIR", "alive", "_pid_comm_is_claude"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.SESSION_DIR = self.tmp
        self.live, self.claude = set(), set()
        d.alive = lambda pid: pid in self.live
        d._pid_comm_is_claude = lambda pid: pid in self.claude

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
        # 登记文件是外部程序写的，pid 可能缺失、null、非数值、非正数：
        # 一律当「没有活进程」跳过，也不能计入 live_other 误触登记格式
        # 告警。必须用真实 alive 复现两个旧坑——pid=null 让 int(None) 抛
        # TypeError 炸掉整轮巡检（scan_sessions 在 per-workspace 保护圈
        # 之外）；pid 缺失时兜底的 -1 被 kill(-1, 0)（权限探测）读作存活。
        d.alive = self.real_alive
        me = os.getpid()  # 一个确定存活的 pid：健康登记长这样
        d._pid_comm_is_claude = lambda pid: pid == me
        self.write_reg("live.json", me, os.path.realpath(self.tmp))
        self.write_reg("null.json", None, "/a")
        self.write_reg("neg.json", -1, "/a")
        self.write_reg("junk.json", "abc", "/a")
        with open(os.path.join(self.tmp, "absent.json"), "w") as f:
            json.dump({"kind": "interactive", "cwd": "/a"}, f)
        consumers, alert = d.scan_sessions()
        self.assertEqual(consumers, {os.path.realpath(self.tmp)})
        self.assertIsNone(alert)


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
        self.assertEqual(d.renew_workspace(self.path), "changed")
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
                     "rotate_patrol_logs"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        d.scan_sessions = lambda: (set(), None)
        d.acquire_run_lock = lambda: 1
        d.rotate_patrol_logs = lambda: None

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


if __name__ == "__main__":
    unittest.main()
