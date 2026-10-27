// 产品品牌单一来源:runtime-patches 的文案锚点替换与 profile:assemble 的
// 品牌插件安装都从这里取值。插件源码(packaging/brand/dsh-brand-analyst)
// 内的可见字符串(logo 旁名称)需与此处 productName 保持一致。
export const brand = {
  /** 替换掉的官方产品名(dsh-web-frontend 标题/manifest 锚点)。 */
  officialProductName: 'DeepSeek Harness',
  /** 展示用产品名。 */
  productName: 'Data Analyst',
  /** 对话首屏大标题(原"探索未至之境")。 */
  heroHeadlineZh: '让数据开口说话',
  /** 英文 locale 对应文案(原"Into the Unknown")。 */
  heroHeadlineEn: 'Let the data speak',
} as const;
