"""Unit tests for doorman. Run: /usr/bin/python3 -m unittest discover -s tests

Zero third-party dependencies; the binary under test has no .py extension, so
it is loaded explicitly via SourceFileLoader.
"""

import argparse
import datetime
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
    def test_unknown_provider_exits_cleanly(self):
        with self.assertRaises(SystemExit) as ctx:
            d.get_provider({"provider": "nope"})
        self.assertEqual(ctx.exception.code, 2)

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

    def test_satisfiable_crons_still_resolve(self):
        # The short-circuit must not swallow legal expressions, including the
        # DoM/DoW OR case where one side alone is out of range.
        self.assertEqual(d.Cron("0 12 99 * 1").next_after(NOW),
                         datetime.datetime(2026, 9, 21, 12, 0))
        self.assertEqual(d.Cron("0 0 29 2 *").next_after(NOW),
                         datetime.datetime(2028, 2, 29, 0, 0))


class TaskFileTests(unittest.TestCase):
    """read_tasks validates shape: the file is another program's output."""

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)
        os.makedirs(os.path.join(self.ws, ".claude"))
        self.provider = d.ClaudeProvider()

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
                result = self.provider.read_tasks(self.ws)
                self.assertIn(result, (None, []))

    def test_non_dict_entries_are_dropped(self):
        self.write('{"tasks": [{"cron": "0 9 * * *"}, "junk", null, 7]}')
        self.assertEqual(self.provider.read_tasks(self.ws),
                         [{"cron": "0 9 * * *"}])

    def test_missing_file_reads_as_none(self):
        self.assertIsNone(d.ClaudeProvider().read_tasks(
            os.path.join(self.ws, "nonexistent")))


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.cfg_path = os.path.join(self.tmp, "config.json")
        # Module globals are patched wholesale below; restore them so test
        # order never matters.
        for name in ("STATE_PATH", "alive", "proc_started_at",
                     "spawn_session", "stop_session", "acquire_run_lock"):
            self.addCleanup(setattr, d, name, getattr(d, name))
        d.STATE_PATH = os.path.join(self.tmp, "state.json")
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600, "provider": "fake"})
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
        # Identity fingerprints are faked as "start-<pid>": a pid that is
        # alive in the fake table reports the same value spawn recorded, and
        # a recycled pid can be simulated by rewriting state.
        d.proc_started_at = lambda pid: (
            f"start-{pid}" if pid in self.alive_pids else None)

        def fake_spawn(provider, ws):
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
        write_json(d.STATE_PATH, s)
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

        class TwoWorkspaces:
            def discover(self, roots, depth):
                yield ("/broken", "x")
                yield (WS_PATH, "x")

            def read_tasks(self, ws):
                visited.append(ws)
                if ws == "/broken":
                    raise RuntimeError("corrupt beyond read_tasks")
                return [{"cron": "*/5 * * * *", "createdAt": 0}]

            def has_consumer(self, ws):
                return False

            def argv(self, ws, log):
                return []

        d.PROVIDERS["two"] = TwoWorkspaces
        write_json(self.cfg_path,
                   {"roots": ["/x"], "maxDepth": 3, "intervalSeconds": 300,
                    "leadSeconds": 600, "provider": "two"})
        self.patrol()
        self.assertEqual(visited, ["/broken", WS_PATH])
        self.assertIn(WS_PATH, self.state())


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
