"""Unit tests for doorman. Run: /usr/bin/python3 -m unittest discover -s tests

Zero third-party dependencies; the binary under test has no .py extension, so
it is loaded explicitly via SourceFileLoader.
"""

import argparse
import datetime
import json
import os
import tempfile
import time
import unittest
from unittest import mock
from importlib.machinery import SourceFileLoader

BIN = os.path.join(os.path.dirname(__file__), "..", "bin", "doorman")
d = SourceFileLoader("doorman", os.path.abspath(BIN)).load_module()

NOW = datetime.datetime(2026, 9, 20, 15, 47)  # Sunday
WS_PATH = "/x"


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


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg_path = os.path.join(self.tmp, "config.json")
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        json.dump({"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                   "leadSeconds": 600, "provider": "fake"},
                  open(self.cfg_path, "w"))
        self.alive_pids = set()
        self.next_pid = 100

        class FakeProvider:
            consumer = False

            def discover(self, roots, depth):
                yield (WS_PATH, "x")

            def read_tasks(self, ws):
                return [{"cron": "*/5 * * * *", "createdAt": 0}]

            def has_consumer(self, ws):
                return FakeProvider.consumer

            def argv(self, ws, log):
                return []

        self.FakeProvider = FakeProvider
        d.PROVIDERS["fake"] = FakeProvider
        self.FakeProvider.consumer = False
        d.alive = lambda pid: pid in self.alive_pids

        def fake_spawn(provider, ws):
            pid = self.next_pid
            self.next_pid += 1
            self.alive_pids.add(pid)
            return pid

        d.spawn_session = fake_spawn
        d.acquire_run_lock = lambda: 1
        self.args = argparse.Namespace(config=self.cfg_path)

    def state(self):
        if not os.path.exists(d.STATE_PATH):
            return {}
        return json.load(open(d.STATE_PATH))

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
        json.dump(self.state(), open(d.STATE_PATH, "w"))
        self.FakeProvider.consumer = True
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["pid"], pid1)
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)

        # 3: dies while needed → fails=1, respawned
        self.FakeProvider.consumer = False
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
        json.dump(s, open(d.STATE_PATH, "w"))
        self.patrol()
        ent = self.state()[WS_PATH]
        self.assertEqual(ent["fails"], 0)
        self.assertIn(ent["pid"], self.alive_pids)

        # 7: a pure user session (no state) is never tracked
        os.remove(d.STATE_PATH)
        self.FakeProvider.consumer = True
        self.patrol()
        self.assertNotIn(WS_PATH, self.state())

        # 8: user session closes → clean spawn
        self.FakeProvider.consumer = False
        self.patrol()
        self.assertEqual(self.state()[WS_PATH]["fails"], 0)


if __name__ == "__main__":
    unittest.main()
