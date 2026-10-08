"""§12 Cell 执行桥:运行一段 Python 代码并输出结构化结果。

首选 jupyter_client + ipykernel(单次执行:启动 → 执行 → 收集输出 → 关停),
不跨调用保留变量状态;持久 Kernel 生命周期由 DSH Notebook 插件承接。
内核栈缺失时回退 direct-exec(进程内 exec,无超时中断能力,由父进程
超时兜底),并在报告中如实标注 backend 字段。本命令绝不安装依赖。
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
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
            "backend": "jupyter",
            "outputs": outputs,
            "execution_count": reply["content"].get("execution_count"),
        }
    finally:
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001 — 关停失败不影响结果输出
            pass


def run_cell_direct(code: str, _timeout: float) -> dict[str, Any]:
    """direct-exec 回退:进程内 exec,捕获 stdout/stderr 与末尾表达式值。

    无法实现内核级中断(超时由父进程杀掉子进程兜底);报告 backend 如实标注。
    """
    namespace: dict[str, Any] = {"__name__": "__analyst_cell__"}
    outputs: list[dict[str, Any]] = []
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        module = ast.parse(code, "<cell>", "exec")
        tail_expr = None
        if module.body and isinstance(module.body[-1], ast.Expr):
            tail_expr = module.body.pop()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exec(compile(module, "<cell>", "exec"), namespace)  # noqa: S102 — 受控执行用户 Cell
            if tail_expr is not None:
                value = eval(  # noqa: S307 — 同上
                    compile(ast.Expression(tail_expr.value), "<cell>", "eval"), namespace
                )
                outputs.append(
                    {
                        "type": "execute_result",
                        "data": {"text/plain": repr(value)},
                        "execution_count": 1,
                    }
                )
        if stdout.getvalue():
            outputs.insert(0, {"type": "stream", "name": "stdout", "text": stdout.getvalue()})
        if stderr.getvalue():
            outputs.insert(0, {"type": "stream", "name": "stderr", "text": stderr.getvalue()})
        return {"ok": True, "backend": "direct-exec", "outputs": outputs, "execution_count": 1}
    except Exception:  # noqa: BLE001 — 异常按 error 输出回传,与 Jupyter error 消息同构
        outputs.append(
            {
                "type": "error",
                "ename": type(sys.exc_info()[1]).__name__,
                "evalue": str(sys.exc_info()[1]),
                "traceback": traceback.format_exception(*sys.exc_info()),
            }
        )
        return {"ok": False, "backend": "direct-exec", "outputs": outputs}


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
        import jupyter_client  # noqa: F401

        report = run_cell(code, args.timeout)
    except ImportError:
        # 内核栈缺失:回退进程内 direct-exec,backend 字段如实标注
        report = run_cell_direct(code, args.timeout)
    except Exception as error:  # noqa: BLE001 — 统一转为结构化失败输出
        report = {"ok": False, "reason": f"内核执行失败: {error}"}

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
