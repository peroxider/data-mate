"""§12 Cell 执行桥:经 jupyter_client 驱动 ipykernel 运行一段代码。

单次执行语义(启动 → 执行 → 收集输出 → 关停),不跨调用保留变量状态;
持久 Kernel 生命周期由 DSH Notebook 插件承接。内核栈缺失时如实报告
(环境准备项,本命令绝不安装依赖)。
"""

from __future__ import annotations

import argparse
import json
import sys
from queue import Empty
from typing import Any


def run_cell(code: str, timeout: float) -> dict[str, Any]:
    from jupyter_client.manager import start_new_kernel

    km, kc = start_new_kernel(kernel_name="python3")
    outputs: list[dict[str, Any]] = []
    try:
        msg_id = kc.execute(code)
        while True:
            try:
                msg = kc.get_iopub_msg(timeout=timeout)
            except Empty:
                return {
                    "ok": False,
                    "reason": f"Cell 执行超时({timeout}s);内核已关停",
                    "outputs": outputs,
                }
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            msg_type = msg["msg_type"]
            content = msg["content"]
            if msg_type == "stream":
                outputs.append(
                    {"type": "stream", "name": content.get("name", "stdout"), "text": content.get("text", "")}
                )
            elif msg_type == "execute_result":
                outputs.append(
                    {
                        "type": "execute_result",
                        "data": content.get("data", {}),
                        "execution_count": content.get("execution_count"),
                    }
                )
            elif msg_type == "display_data":
                outputs.append({"type": "display_data", "data": content.get("data", {})})
            elif msg_type == "error":
                outputs.append(
                    {
                        "type": "error",
                        "ename": content.get("ename", "Error"),
                        "evalue": content.get("evalue", ""),
                        "traceback": content.get("traceback", []),
                    }
                )
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break
        reply = kc.get_shell_msg(timeout=timeout)
        status = reply["content"].get("status", "error")
        return {
            "ok": status == "ok",
            "outputs": outputs,
            "execution_count": reply["content"].get("execution_count"),
        }
    finally:
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001 — 关停失败不影响结果输出
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyst_runtime run-cell",
        description="经 jupyter_client 单次执行一段 Python 代码并输出结构化结果",
    )
    parser.add_argument("--code-file", required=True, help="待执行的代码文件路径")
    parser.add_argument("--timeout", type=float, default=60.0, help="执行超时秒数")
    args = parser.parse_args(argv)

    try:
        with open(args.code_file, encoding="utf-8") as handle:
            code = handle.read()
    except OSError as error:
        json.dump({"ok": False, "reason": f"代码文件读取失败: {error}"}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    try:
        import ipykernel  # noqa: F401
        import jupyter_client  # noqa: F401

        report = run_cell(code, args.timeout)
    except ImportError:
        report = {
            "ok": False,
            "reason": "ipykernel/jupyter_client 未安装(环境准备项,本命令不安装依赖)",
        }
    except Exception as error:  # noqa: BLE001 — 统一转为结构化失败输出
        report = {"ok": False, "reason": f"内核执行失败: {error}"}

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
