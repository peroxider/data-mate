"""§11 导入过程:Parquet 只读检查。

解析行数与列类型,输出结构化 JSON;绝不修改输入文件,缺失 pyarrow 时
如实报告(安装属环境准备,本命令绝不安装依赖)。
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def inspect_parquet(path: str) -> dict[str, Any]:
    import pyarrow.parquet as pq  # 延迟导入:缺失时走 ENVIRONMENT_INCOMPLETE 分支

    reader = pq.ParquetFile(path)
    columns = [
        {"name": field.name, "type": str(field.type)}
        for field in reader.schema_arrow
    ]
    return {
        "ok": True,
        "format": "parquet",
        "row_count": reader.metadata.num_rows,
        "columns": columns,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyst_runtime inspect-parquet",
        description="只读解析 Parquet 行数与列类型,绝不修改文件",
    )
    parser.add_argument("--input", required=True, help="Parquet 文件路径")
    args = parser.parse_args(argv)

    try:
        report = inspect_parquet(args.input)
    except ImportError:
        report = {
            "ok": False,
            "reason": "pyarrow 未安装(环境准备项,本命令不安装依赖)",
        }
    except Exception as error:  # noqa: BLE001 — 统一转为结构化失败输出
        report = {"ok": False, "reason": f"解析失败: {error}"}

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
