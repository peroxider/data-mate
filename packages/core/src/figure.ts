import type { TrainingResult } from '@data-analyst/contracts';

// ---------------------------------------------------------------------------
// §24 M2 基础解释图:标准化系数水平条形图(线性/逻辑回归的特征在训练时
// 已标准化,系数量级可比)。只做量级展示,不做因果或重要性承诺;逻辑回归
// 系数符号表示对正类概率方向的贡献。无可视化内容时返回 null,不伪造图形。
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderCoefficientSvg(training: TrainingResult): string | null {
  const features = training.model.feature_order;
  const coefficients = training.model.coefficients;
  if (features.length === 0 || features.length !== coefficients.length) return null;

  const items = features
    .map((name, index) => ({ name, value: coefficients[index] ?? 0 }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const maxAbs = Math.max(...items.map((item) => Math.abs(item.value)));
  if (!(maxAbs > 0)) return null;

  const labelWidth = 140;
  const chartWidth = 640;
  const barMaxWidth = chartWidth - labelWidth - 90;
  const barHeight = 24;
  const gap = 8;
  const height = items.length * (barHeight + gap);

  const bars = items
    .map((item, index) => {
      const y = index * (barHeight + gap);
      const width = Math.max(1, (Math.abs(item.value) / maxAbs) * barMaxWidth);
      const fill = item.value >= 0 ? '#3567b0' : '#b03535';
      return `<g transform="translate(0,${y})">
<text x="${labelWidth - 8}" y="${barHeight / 2 + 5}" text-anchor="end" font-size="13">${escapeXml(item.name)}</text>
<rect x="${labelWidth}" y="0" width="${width.toFixed(2)}" height="${barHeight}" fill="${fill}"></rect>
<text x="${(labelWidth + width + 6).toFixed(2)}" y="${barHeight / 2 + 5}" font-size="12">${item.value.toFixed(4)}</text>
</g>`;
    })
    .join('');

  const caption =
    training.task === 'classification'
      ? '标准化系数条形图:蓝色为正方向贡献,红色为负方向贡献(逻辑回归,量级仅作解释参考)'
      : '标准化系数条形图:特征每变化 1 个标准差对应目标的变化量(线性回归)';
  return `<svg width="${chartWidth}" height="${height + 18}" role="img" aria-label="标准化系数条形图">
${bars}
<text x="${labelWidth}" y="${height + 14}" font-size="11" fill="#555">${escapeXml(caption)}</text>
</svg>`;
}
