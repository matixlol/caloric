#!/usr/bin/env python3
"""Keep pulls on the canonical source and pushes on the development fork."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
def git(*args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

actual = "https://github.com/matixlol/caloric.git"
fork = "https://github.com/poasterbot/caloric.git"
remotes = git("remote").splitlines()
for name, url in [("origin", actual), ("upstream", actual), ("fork", fork)]:
    git("remote", "set-url" if name in remotes else "add", name, url)
    # Remove a leftover push URL that could silently target the wrong repository.
    subprocess.run(["git", "-C", str(root), "config", "--unset-all", f"remote.{name}.pushurl"], capture_output=True)
git("config", "branch.main.remote", "origin")
git("config", "branch.main.merge", "refs/heads/main")
git("config", "branch.main.pushRemote", "fork")
git("config", "remote.pushDefault", "fork")
git("config", "pull.rebase", "true")
git("config", "pull.ff", "true")
git("config", "rebase.autoStash", "true")
git("fetch", "origin", "main")
print("Pulls: matixlol/caloric main. Pushes: poasterbot/caloric. Local commits use rebase.")
