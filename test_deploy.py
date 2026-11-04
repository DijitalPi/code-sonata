"""The backup and restore scripts of orchestra/deploy, run on folders of this test, with failures put in their way."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest

DEPLOY = Path(__file__).with_name("orchestra") / "deploy"
ORDERS = {"orders": [{"id": "o-" + "1" * 24, "state": "live", "email": "buyer@example.test"}], "events": [], "coupons": []}
AUCTION = {"auction": None, "bids": [], "old": [], "past": []}


class DeployScripts(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data, self.backups, self.bin = self.root / "data", self.root / "backups", self.root / "bin"
        for d in (self.data / "seats", self.bin):
            d.mkdir(parents=True)
        self.write(self.data, ORDERS, AUCTION, b"logo")

    @staticmethod
    def write(at, orders, auction, logo):
        (at / "orders.json").write_text(json.dumps(orders))
        (at / "auction.json").write_text(json.dumps(auction))
        (at / "seats").mkdir(exist_ok=True)
        (at / "seats" / "o-1.webp").write_bytes(logo)

    def wrap(self, name, script):
        """A command of this name earlier in PATH: script is sh, $REAL is the real command."""
        real = shutil.which(name)
        path = self.bin / name
        path.write_text(f"#!/bin/sh\nREAL={real}\n{script}\n")
        path.chmod(0o755)

    def run_script(self, name, *args):
        env = {**os.environ, "DATA": str(self.data), "BACKUPS": str(self.backups), "REMOTE": "",
               "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}
        return subprocess.run(["sh", "-c", 'umask 022; exec sh "$0" "$@"', str(DEPLOY / name), *args],
                              env=env, capture_output=True, text=True, timeout=60)

    def archive(self, files, folder="2026-11-04"):
        """A .tgz with one folder holding files {name: bytes}."""
        out = self.root / "a.tgz"
        src = self.root / "src" / folder
        src.mkdir(parents=True)
        for name, content in files.items():
            (src / name).parent.mkdir(parents=True, exist_ok=True)
            (src / name).write_bytes(content)
        with tarfile.open(out, "w:gz") as t:
            t.add(src, arcname=folder)
        return out

    def snapshot(self):
        return {str(p.relative_to(self.data)): p.read_bytes() for p in sorted(self.data.rglob("*")) if p.is_file()}

    def others_can_read(self):
        """Files or folders under BACKUPS that another user of the machine could open."""
        return [str(p) for p in [self.backups, *self.backups.rglob("*")] if p.exists() and p.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO)]

    # ---------- backup ----------
    def test_a_backup_is_one_archive_only_its_owner_reads(self):
        done = self.run_script("backup.sh")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([p.name for p in self.backups.iterdir()], [Path(done.stdout.strip()).name])
        self.assertEqual(self.others_can_read(), [])

    def test_a_backup_that_fails_leaves_nothing_another_user_could_read(self):
        """tar writes the archive, then fails (a full disk): no readable archive or copy stays behind (G4)."""
        self.wrap("tar", '"$REAL" "$@"\nexit 23')
        done = self.run_script("backup.sh")
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.others_can_read(), [])
        self.assertEqual(list(self.backups.glob("*.tgz")), [], "a failed archive is not taken for a backup")

    # ---------- restore ----------
    def test_a_restore_puts_the_archive_in_and_keeps_what_it_replaced(self):
        new = {**ORDERS, "events": [{"what": "restored"}]}
        a = self.archive({"orders.json": json.dumps(new).encode(), "auction.json": json.dumps(AUCTION).encode(), "seats/o-1.webp": b"new"})
        done = self.run_script("restore.sh", str(a))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads((self.data / "orders.json").read_text()), new)
        self.assertEqual((self.data / "seats" / "o-1.webp").read_bytes(), b"new")
        before = [p for p in self.root.iterdir() if p.name.startswith("data.before-")]
        self.assertEqual(len(before), 1)
        self.assertEqual((before[0] / "seats" / "o-1.webp").read_bytes(), b"logo")

    def test_a_broken_archive_changes_nothing(self):
        """Files that are not whole are refused before anything moves (G5)."""
        was = self.snapshot()
        for files in ({"orders.json": b"not-json"}, {"orders.json": b"{}"}, {"orders.json": json.dumps(ORDERS).encode(), "auction.json": b""},
                      {"auction.json": json.dumps(AUCTION).encode()}):
            a = self.archive(files)
            done = self.run_script("restore.sh", str(a))
            self.assertNotEqual(done.returncode, 0, files)
            self.assertEqual(self.snapshot(), was, files)
            shutil.rmtree(self.root / "src"); a.unlink()

    def test_a_restore_that_stops_half_way_puts_the_old_files_back(self):
        """The logos cannot be moved in after the ledgers were: the volume is as it was (G5)."""
        a = self.archive({"orders.json": json.dumps(ORDERS).encode(), "auction.json": json.dumps(AUCTION).encode(), "seats/o-1.webp": b"new"})
        was = self.snapshot()
        self.wrap("mv", f'case "$1" in *.new/seats) exit 28;; esac\nexec "$REAL" "$@"')
        done = self.run_script("restore.sh", str(a))
        self.assertNotEqual(done.returncode, 0)
        self.assertEqual(self.snapshot(), was)


if __name__ == "__main__":
    unittest.main()
