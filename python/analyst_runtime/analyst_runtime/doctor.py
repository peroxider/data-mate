"""§7/计划 W8 的 Python 运行时环境自检。

只读探测:报告 Notebook 内核栈(ipykernel / jupyter_client / nbformat)
与数据栈(pandas / numpy)的可导入性与版本。缺依赖时输出 warn 并退出 0
——安装属环境准备,本命令绝不安装任何东西(§7)。
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from typing import Any

# dsh-notebook 的 Python 侧内核栈 + 数据栈(设计 §12、上游 dsh-notebook 0.2.4)
PROBED_MODULES = ("ipykernel", "jupyter_client", "nbformat", "pandas", "numpy")


def check_runtime() -> dict[str, Any]:
    """探测内核与数据栈依赖,返回与 CLI doctor 一致的 {checks: [...]} 结构。"""
    checks: list[dict[str, str]] = []
    for module_name in PROBED_MODULES:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            checks.append(
                {
                    "name": module_name,
                    "status": "warn",
                    "detail": "模块缺失(环境准备项,本命令不安装依赖)",
                }
            )
        else:
            version = getattr(module, "__version__", "unknown")
            checks.append(
                {"name": module_name, "status": "pass", "detail": f"{module_name} {version}"}
            )
    return {"checks": checks}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m analyst_runtime",
        description="M0 Python 运行时自检:只读探测依赖可导入性,绝不安装依赖",
    )
    parser.add_argument("command", choices=["doctor"], help="子命令")
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON")
    args = parser.parse_args(argv)

    report = check_runtime()
    if args.json:
        json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        marks = {"pass": "OK", "warn": "!!", "fail": "XX"}
        for check in report["checks"]:
            sys.stdout.write(f"[{marks[check['status']]}] {check['name']}: {check['detail']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
