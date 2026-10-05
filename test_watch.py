import os
from pathlib import Path
import tempfile
import unittest

from watch import Change, ChangeMusic, ProjectWatcher, changed_lines, musical_line


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "main.py"
        self.file.write_text("x = 1\n")
        self.watcher = ProjectWatcher(self.root)

    def settle(self, start=1):
        self.assertEqual(self.watcher.poll(start), [])
        return self.watcher.poll(start + .5)

    def test_baseline_and_touch_are_silent(self):
        self.assertEqual(self.watcher.poll(0), [])
        os.utime(self.file, ns=(1_000_000_000, 1_000_000_000))
        self.assertEqual(self.settle(), [])

    def test_change_new_delete_and_atomic_replace(self):
        replacement = self.root / "swap.tmp"
        replacement.write_text("def selam():\n    return 'şarkı'\n")
        replacement.replace(self.file)
        changes = self.settle()
        self.assertEqual(len(changes), 1)
        self.assertIn("def selam():", changes[0].lines)
        added = self.root / "app.ts"
        added.write_text("const greet = () => 'hello';\n")
        self.assertEqual(self.settle(2)[0].path, Path("app.ts"))
        added.unlink()
        self.assertTrue(self.settle(3)[0].deleted)
        self.assertEqual(self.watcher.poll(4), [])

    def test_burst_coalesces_and_watcher_does_not_write(self):
        self.file.write_text("x = 2\n")
        self.assertEqual(self.watcher.poll(1), [])
        self.file.write_text("x = 3\n")
        self.assertEqual(self.watcher.poll(1.2), [])
        stat = self.file.stat()
        changes = self.watcher.poll(1.7)
        self.assertEqual(changes[0].lines, ["x = 3"])
        self.assertEqual(self.file.read_text(), "x = 3\n")
        self.assertEqual(self.file.stat().st_mtime_ns, stat.st_mtime_ns)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["main.py"])

    def test_excludes_dependencies_hidden_binary_and_links(self):
        for folder in ("node_modules", ".git", "dist", "__pycache__"):
            directory = self.root / folder
            directory.mkdir()
            (directory / "noise.py").write_text("print(1)")
        (self.root / ".secret.py").write_text("secret")
        (self.root / "binary.py").write_bytes(b"\x00\xff")
        (self.root / "link.py").symlink_to(self.file)
        (self.root / "bundle.min.js").write_text("generated")
        self.assertEqual(self.settle(), [])
        self.assertEqual(len(self.watcher.baseline), 1)

    def test_limit_is_explicit(self):
        (self.root / "two.py").write_text("x=2")
        with self.assertRaisesRegex(RuntimeError, "sınırı"):
            ProjectWatcher(self.root, max_files=1)

    def test_large_patch_has_bounded_music_and_returns_to_silence(self):
        lines, count = changed_lines("", "\n".join(f"x{i}=1" for i in range(10000)))
        self.assertEqual(count, 10000)
        self.assertEqual(len(lines), 24)
        music = ChangeMusic()
        self.assertEqual(music.tick(0), [])
        music.accept([Change(Path("main.py"), lines, count)], 1)
        notes = []
        for i in range(600):
            notes.extend(music.tick(1 + i * .025))
        self.assertGreater(len(notes), 10)
        self.assertEqual(music.tick(20), [])
        self.assertLessEqual(music.until, 9)

    def test_cross_language_patterns(self):
        for line in ("export function greet() {", "func greet() {", "fn greet() {", "const greet = () => {"):
            self.assertEqual(musical_line(line), "def greet")
        self.assertEqual(musical_line("foreach (var x in xs) {"), "for item")
        self.assertEqual(musical_line("switch (value) {"), "if condition")


if __name__ == "__main__":
    unittest.main()
