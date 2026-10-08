"""§14 统计比较:两独立样本 Welch t 检验,输出 §14 stats.json 结构。

统计与 ML 算法使用成熟 Python 库(scipy);依赖缺失时如实报告
(环境准备项,本命令绝不安装依赖)。方法不适用(组数≠2、样本不足、
非数值列)时返回 unsupported,不挑选能产生显著结果的方法。
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

LIMITATIONS = [
    "两独立样本比较不表达因果",
    "p 值不是原假设为真的概率;显著性与业务影响需分别说明",
    "Welch 检验不假设方差齐性,但不解决非独立样本/重复测量问题",
    "正态性未做正式检验,小样本下 t 检验结论应谨慎解释",
]


def _unsupported(n_total: int, reason: str, input_refs: list[str]) -> dict[str, Any]:
    return {
        "ok": True,
        "unsupported": reason,
        "stats": {
            "schema_version": 1,
            "analysis_type": "two_group_comparison",
            "input_refs": input_refs,
            "population_scope": "input_file",
            "n_total": n_total,
            "n_used": 0,
            "missing_policy": "组列或值列缺失的行不计入 n_used",
            "method": "unsupported",
            "parameters": {},
            "statistics": {},
            "uncertainty": {},
            "assumptions_checked": {},
            "limitations": LIMITATIONS,
        },
    }


def stats_compare(
    path: str,
    group_col: str,
    value_col: str,
    alpha: float,
    delimiter: str,
    input_refs: list[str],
) -> dict[str, Any]:
    import numpy as np
    import pandas as pd
    from scipy import stats as sps

    frame = pd.read_csv(path, delimiter=delimiter)
    if group_col not in frame.columns or value_col not in frame.columns:
        return _unsupported(len(frame), f"列不存在: {group_col}/{value_col}", input_refs)

    values = pd.to_numeric(frame[value_col], errors="coerce")
    usable = frame[group_col].notna() & values.notna()
    n_total = int(len(frame))
    data = pd.DataFrame({"group": frame.loc[usable, group_col].astype(str), "value": values[usable]})

    groups = sorted(data["group"].unique().tolist())
    if len(groups) != 2:
        return _unsupported(
            n_total, f"两独立样本比较需要恰好 2 个组,实际 {len(groups)} 个: {groups[:5]}", input_refs
        )

    a = data.loc[data["group"] == groups[0], "value"].to_numpy(dtype=float)
    b = data.loc[data["group"] == groups[1], "value"].to_numpy(dtype=float)
    if len(a) < 2 or len(b) < 2:
        return _unsupported(n_total, f"每组至少需要 2 个观测:A={len(a)}, B={len(b)}", input_refs)

    result = sps.ttest_ind(a, b, equal_var=False, alternative="two-sided")
    # Welch–Satterthwaite 自由度与差值置信区间
    var_a, var_b = float(np.var(a, ddof=1)), float(np.var(b, ddof=1))
    n_a, n_b = int(a.size), int(b.size)
    se_sq = var_a / n_a + var_b / n_b
    denom = (var_a / n_a) ** 2 / (n_a - 1) + (var_b / n_b) ** 2 / (n_b - 1)
    df = float(se_sq / denom) if denom > 0 else float(n_a + n_b - 2)
    mean_diff = float(np.mean(a) - np.mean(b))
    se = float(np.sqrt(se_sq))
    t_crit = float(sps.t.ppf(1 - alpha / 2, df))
    ci = [mean_diff - t_crit * se, mean_diff + t_crit * se]
    pooled_std = float(np.sqrt(((n_a - 1) * var_a + (n_b - 1) * var_b) / (n_a + n_b - 2)))
    cohens_d = mean_diff / pooled_std if pooled_std > 0 else None

    stats_json = {
        "schema_version": 1,
        "analysis_type": "two_group_comparison",
        "input_refs": input_refs,
        "population_scope": f"file={path}; groups={groups[0]} vs {groups[1]}",
        "n_total": n_total,
        "n_used": int(len(data)),
        "missing_policy": "组列或值列缺失/非数值的行不计入 n_used,不做填补",
        "method": "welch_t_test",
        "parameters": {
            "test": "welch",
            "alternative": "two-sided",
            "equal_var": False,
            "alpha": alpha,
        },
        "statistics": {
            "group_a": groups[0],
            "group_b": groups[1],
            "n_a": n_a,
            "n_b": n_b,
            "mean_a": float(np.mean(a)),
            "mean_b": float(np.mean(b)),
            "mean_diff": mean_diff,
            "cohens_d": cohens_d,
            "t_stat": float(result.statistic),
            "p_value": float(result.pvalue),
            "df_welch": df,
        },
        "uncertainty": {"ci95_mean_diff": ci},
        "assumptions_checked": {
            "independence": "假设行间独立,未做正式检验",
            "variance_homogeneity": "Welch 方法不要求",
            "var_ratio": (var_a / var_b) if var_b > 0 else None,
        },
        "limitations": LIMITATIONS,
    }
    return {"ok": True, "stats": stats_json}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyst_runtime stats-compare",
        description="两独立样本 Welch t 检验,输出 §14 stats.json 结构",
    )
    parser.add_argument("--input", required=True, help="CSV/TSV 文件路径")
    parser.add_argument("--group-col", required=True, help="分组列名")
    parser.add_argument("--value-col", required=True, help="数值列名")
    parser.add_argument("--alpha", type=float, default=0.05, help="显著性水平")
    parser.add_argument("--delimiter", default=",", help="分隔符(TSV 用 \\t)")
    parser.add_argument("--input-ref", action="append", default=[], help="关联 DataRef(可重复)")
    args = parser.parse_args(argv)

    try:
        report = stats_compare(
            args.input, args.group_col, args.value_col, args.alpha, args.delimiter, args.input_ref
        )
    except ImportError as error:
        report = {"ok": False, "reason": f"依赖缺失(环境准备项,本命令不安装依赖): {error}"}
    except Exception as error:  # noqa: BLE001 — 统一转为结构化失败输出
        report = {"ok": False, "reason": f"统计计算失败: {error}"}

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
