"""Stage the pinned review utilities in a fresh directory for this job."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import tempfile


def stage_tools():
    action = Path(__file__).resolve().parent
    source = action.parents[1] / "review"
    manifest = (action / "tools.sha256").read_bytes()
    if hashlib.sha256(manifest).hexdigest() != os.environ["EXPECTED_MANIFEST_SHA256"]:
        raise ValueError("Не совпала контрольная сумма манифеста утилит")

    entries = manifest.decode("ascii").splitlines()
    if not entries:
        raise ValueError("Манифест утилит пуст")
    target = Path(tempfile.mkdtemp(prefix="review-tools-", dir=os.environ["RUNNER_TEMP"]))
    try:
        for entry in entries:
            match = re.fullmatch(r"([0-9a-f]{64})  ([a-z0-9-]+\.mjs)", entry)
            if not match:
                raise ValueError("Некорректная запись в манифесте утилит")
            checksum, name = match.groups()
            path = source / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f"Отсутствует обычный файл {name}")
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != checksum:
                raise ValueError(f"Не совпала контрольная сумма {name}")
            with (target / name).open("xb") as staged:
                staged.write(content)
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as env:
            env.write(f"REVIEW_TOOLS_DIR={target}\n")
    except Exception:
        shutil.rmtree(target)
        raise


if __name__ == "__main__":
    stage_tools()
