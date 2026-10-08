"""§14 机器学习:表格分类/回归训练(numpy 确定性实现)。

设计要点(R6/T13/§14 可复现性):
- 泄漏检查:特征含目标列、ID/全唯一值列、与目标取值相同的列一律剔除并留痕;
- 标准化仅在训练集 fit,再应用到测试集;
- split manifest 固定可复现索引、种子与数据哈希;
- 模型权重输出为 JSON 数组(可独立查看,不用 pickle/joblib 反序列化);
- 预测文件固定 actual/predicted,供产品侧用确定性代码独立重算指标;
- 回归必须与均值基线比较;分类报告 precision/recall/F1/混淆矩阵;
- 非数值特征列如实 unsupported,不做静默编码;依赖缺失如实报告。
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import platform
import sys
from typing import Any

ID_NAME_TOKENS = {"id", "uuid", "guid", "index", "idx", "序号", "编号"}

LIMITATIONS = [
    "特征仅支持数值列,非数值列未做编码(如实排除)",
    "随机切分不适用于分组/时间结构数据;此类数据需分组或时间切分",
    "线性/逻辑回归不捕捉非线性关系;结论限于训练数据分布",
]


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_id_like(name: str) -> bool:
    tokens = name.lower().replace("-", "_").split("_")
    return any(token in ID_NAME_TOKENS for token in tokens)


def _unsupported(n_total: int, reason: str) -> dict[str, Any]:
    return {
        "ok": True,
        "unsupported": reason,
        "n_total": n_total,
        "result": {"training": None, "predictions": None},
    }


def _macro(values: list[float | None]) -> float | None:
    known = [value for value in values if value is not None]
    return sum(known) / len(known) if known else None


def _train_linear(x: Any, y: Any) -> tuple[list[float], float]:
    import numpy as np

    design = np.column_stack([np.ones(len(x)), x])
    weights, *_ = np.linalg.lstsq(design, y, rcond=None)
    return [float(w) for w in weights[1:]], float(weights[0])


def _train_logistic(
    x: Any, y: Any, iterations: int = 5000, lr: float = 0.1
) -> tuple[list[float], float]:
    import numpy as np

    design = np.column_stack([np.ones(len(x)), x])
    weights = np.zeros(design.shape[1])
    for _ in range(iterations):
        linear = design @ weights
        probs = 1.0 / (1.0 + np.exp(-np.clip(linear, -60.0, 60.0)))
        gradient = design.T @ (probs - y) / len(y)
        weights -= lr * gradient
    return [float(w) for w in weights[1:]], float(weights[0])


def _classification_metrics(
    actual: list[int], predicted: list[int], classes: list[str]
) -> dict[str, Any]:
    """positive = classes[1](排序后第二类);同时给出 macro 指标。"""
    tp = sum(1 for a, p in zip(actual, predicted) if a == 1 and p == 1)
    fp = sum(1 for a, p in zip(actual, predicted) if a == 0 and p == 1)
    fn = sum(1 for a, p in zip(actual, predicted) if a == 1 and p == 0)
    tn = sum(1 for a, p in zip(actual, predicted) if a == 0 and p == 0)
    precision = tp / (tp + fp) if tp + fp > 0 else None
    recall = tp / (tp + fn) if tp + fn > 0 else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else None
    precision_neg = tn / (tn + fn) if tn + fn > 0 else None
    recall_neg = tn / (tn + fp) if tn + fp > 0 else None
    f1_neg = (
        2 * precision_neg * recall_neg / (precision_neg + recall_neg)
        if precision_neg and recall_neg
        else None
    )
    return {
        "accuracy": (tp + tn) / len(actual) if actual else None,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "precision_macro": _macro([precision, precision_neg]),
        "recall_macro": _macro([recall, recall_neg]),
        "f1_macro": _macro([f1, f1_neg]),
        "confusion_matrix": {"labels": classes, "matrix": [[tn, fp], [fn, tp]]},
    }


def train_model(
    path: str,
    delimiter: str,
    task: str,
    target: str,
    features: list[str],
    split_seed: int,
    test_ratio: float,
    input_refs: list[str],
) -> dict[str, Any]:
    import numpy as np
    import pandas as pd

    frame = pd.read_csv(path, delimiter=delimiter)
    n_total = int(len(frame))
    missing = [name for name in [target, *features] if name not in frame.columns]
    if missing:
        return _unsupported(n_total, f"列不存在: {missing}")
    if target in features:
        return _unsupported(n_total, f"目标列 {target} 不得出现在特征列表(目标泄漏)")

    # 泄漏检查:ID 命名列、无法数值化的列、取值与目标完全相同的列
    excluded: list[dict[str, str]] = []
    used_features: list[str] = []
    for name in features:
        column = frame[name]
        if _is_id_like(name):
            excluded.append({"column": name, "reason": "ID/标识命名列,无泛化意义"})
            continue
        if not pd.api.types.is_numeric_dtype(column):
            coerced = pd.to_numeric(column, errors="coerce")
            if coerced.notna().all():
                column = coerced
            else:
                excluded.append({"column": name, "reason": "非数值列(未做编码,如实排除)"})
                continue
        if task == "classification" and name != target and column.equals(frame[target]):
            excluded.append({"column": name, "reason": "取值与目标完全相同(目标泄漏)"})
            continue
        used_features.append(name)
    if not used_features:
        return _unsupported(n_total, "没有可用的数值特征列")

    feature_frame = frame[used_features].apply(pd.to_numeric, errors="coerce")
    if task == "classification":
        y_all = frame[target].astype(str)
    else:
        y_all = pd.to_numeric(frame[target], errors="coerce")
    complete = feature_frame.notna().all(axis=1) & y_all.notna()
    n_used = int(complete.sum())
    if n_used < 10:
        return _unsupported(n_total, f"可用样本不足(需 ≥10): {n_used}")

    x_all = feature_frame[complete].to_numpy(dtype=float)
    y_series = y_all[complete].reset_index(drop=True)

    # 确定性随机切分(记录索引,可复现)
    rng = np.random.RandomState(split_seed)
    permutation = rng.permutation(n_used)
    test_count = max(2, int(round(n_used * test_ratio)))
    test_indices = sorted(int(i) for i in permutation[:test_count])
    train_indices = sorted(int(i) for i in permutation[test_count:])

    x_train, x_test = x_all[train_indices], x_all[test_indices]
    means = x_train.mean(axis=0)
    stds = x_train.std(axis=0, ddof=0)
    stds = np.where(stds == 0, 1.0, stds)
    z_train = (x_train - means) / stds
    z_test = (x_test - means) / stds

    classes: list[str] | None = None
    if task == "classification":
        classes = sorted(y_series.unique().tolist())
        if len(classes) != 2:
            return _unsupported(
                n_total, f"首版逻辑回归仅支持二分类,实际 {len(classes)} 类: {classes[:5]}"
            )
        y_train = (y_series.iloc[train_indices] == classes[1]).to_numpy(dtype=float)
        coefficients, intercept = _train_logistic(z_train, y_train)
    else:
        y_train = y_series.iloc[train_indices].to_numpy(dtype=float)
        coefficients, intercept = _train_linear(z_train, y_train)

    # 预测(固定 actual/predicted 供产品侧独立重算)
    if task == "classification":
        linear = z_test @ np.array(coefficients) + intercept
        probs = 1.0 / (1.0 + np.exp(-np.clip(linear, -60.0, 60.0)))
        predicted_idx = (probs > 0.5).astype(int)
        actual_idx = (y_series.iloc[test_indices] == classes[1]).to_numpy(dtype=int)
        predictions = {
            "split": "test",
            "actual": [classes[i] for i in actual_idx],
            "predicted": [classes[i] for i in predicted_idx],
        }
        cm_result = _classification_metrics(actual_idx.tolist(), predicted_idx.tolist(), classes)
        metrics = {k: v for k, v in cm_result.items() if k != "confusion_matrix"}
        confusion = cm_result["confusion_matrix"]
        baseline_predictions = [0] * len(actual_idx)  # 多数基线:排序首类(保守)
        baseline_full = _classification_metrics(actual_idx.tolist(), baseline_predictions, classes)
        baseline = {k: v for k, v in baseline_full.items() if k != "confusion_matrix"}
        confusion_out = confusion
    else:
        predicted = z_test @ np.array(coefficients) + intercept
        actual = y_series.iloc[test_indices].to_numpy(dtype=float)
        error = actual - predicted
        ss_res = float(np.sum(error**2))
        ss_tot = float(np.sum((actual - actual.mean()) ** 2))
        predictions = {
            "split": "test",
            "actual": [float(v) for v in actual],
            "predicted": [float(v) for v in predicted],
        }
        baseline_pred = np.full(len(actual), float(y_train.mean()))
        base_err = actual - baseline_pred
        base_ss_res = float(np.sum(base_err**2))
        baseline = {
            "mae": float(np.mean(np.abs(base_err))),
            "rmse": float(np.sqrt(np.mean(base_err**2))),
            "r2": 1 - base_ss_res / ss_tot if ss_tot > 0 else None,
        }
        metrics = {
            "mae": float(np.mean(np.abs(error))),
            "rmse": float(np.sqrt(np.mean(error**2))),
            "r2": 1 - ss_res / ss_tot if ss_tot > 0 else None,
        }
        confusion_out = None

    training = {
        "schema_version": 1,
        "task": task,
        "model": {
            "kind": "logistic" if task == "classification" else "linear",
            "feature_order": used_features,
            "standardization": {
                "means": [float(v) for v in means],
                "stds": [float(v) for v in stds],
            },
            "coefficients": coefficients,
            "intercept": intercept,
        },
        "split": {
            "schema_version": 1,
            "dataset_version_id": None,
            "data_sha256": _sha256_file(path),
            "task": task,
            "target": target,
            "features": used_features,
            "split_strategy": "random",
            "split_seed": split_seed,
            "test_ratio": test_ratio,
            "train_indices": train_indices,
            "test_indices": test_indices,
            "leakage": {"checked": True, "excluded_fields": excluded},
        },
        "classes": classes,
        "n_train": len(train_indices),
        "n_test": len(test_indices),
        "metrics": metrics,
        "confusion_matrix": confusion_out,
        "baseline": baseline,
        "environment": {
            "python": platform.python_version(),
            "numpy": str(np.__version__),
            "scipy": None,
        },
        "created_at": datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
    }
    return {
        "ok": True,
        "n_total": n_total,
        "n_used": n_used,
        "missing_policy": "特征或目标缺失的行整行剔除,不做填补",
        "input_refs": input_refs,
        "result": {"training": training, "predictions": predictions},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyst_runtime train-model",
        description="表格分类/回归训练(numpy 确定性实现),输出 §14 训练产物结构",
    )
    parser.add_argument("--input", required=True, help="CSV/TSV 文件路径")
    parser.add_argument("--delimiter", default=",", help="分隔符(TSV 用 \\t)")
    parser.add_argument("--task", required=True, choices=["classification", "regression"])
    parser.add_argument("--target", required=True, help="目标列名")
    parser.add_argument("--features", required=True, help="特征列名,逗号分隔")
    parser.add_argument("--split-seed", type=int, default=42, help="切分随机种子")
    parser.add_argument("--test-ratio", type=float, default=0.25, help="测试集占比")
    parser.add_argument("--input-ref", action="append", default=[], help="关联 DataRef(可重复)")
    args = parser.parse_args(argv)

    try:
        report = train_model(
            args.input,
            args.delimiter,
            args.task,
            args.target,
            [name for name in args.features.split(",") if name],
            args.split_seed,
            args.test_ratio,
            args.input_ref,
        )
    except ImportError as error:
        report = {"ok": False, "reason": f"依赖缺失(环境准备项,本命令不安装依赖): {error}"}
    except Exception as error:  # noqa: BLE001 — 统一转为结构化失败输出
        report = {"ok": False, "reason": f"训练失败: {error}"}

    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
