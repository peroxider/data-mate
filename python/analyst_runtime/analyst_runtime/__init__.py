"""analyst_runtime:M0 阶段的 Python 侧环境自检辅助包。

范围(§7/计划 W8):只报告内核与数据栈依赖的可导入性,绝不启动
第二个 Kernel,不承载 Agent Loop,绝不安装依赖。
"""

from .doctor import check_runtime, main

__all__ = ["check_runtime", "main"]
