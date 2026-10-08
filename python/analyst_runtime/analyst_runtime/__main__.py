"""`python -m analyst_runtime` 入口:自检、数据格式检查与 Cell 执行的子命令分发。"""

import sys

from . import doctor, inspect_parquet, run_cell


def dispatch(argv: list[str]) -> int:
    if not argv:
        return doctor.main([])
    command, rest = argv[0], argv[1:]
    if command == "doctor":
        return doctor.main(argv)  # doctor 的 parser 自带 command 位置参数
    if command == "inspect-parquet":
        return inspect_parquet.main(rest)
    if command == "run-cell":
        return run_cell.main(rest)
    sys.stderr.write(f"未知子命令: {command}\n可用子命令: doctor, inspect-parquet, run-cell\n")
    return 2


if __name__ == "__main__":
    sys.exit(dispatch(sys.argv[1:]))
