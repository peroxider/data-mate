import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { brand } from './brand.js';

export interface RuntimePatch {
  packageName: string;
  version: string;
  file: string;
  transform: (source: string) => string;
}

function replaceOnce(source: string, before: string | RegExp, after: string): string {
  const matches = typeof before === 'string'
    ? source.split(before).length - 1
    : [...source.matchAll(new RegExp(before.source, 'g'))].length;
  if (matches !== 1) throw new Error(`Runtime patch anchor changed: expected 1 match, found ${matches}: ${before}`);
  return source.replace(before, after);
}

export function patchHtmlPreview(source: string): string {
  if (source.includes('data-mate:html-srcdoc')) return source;
  // Keep the Blob as the revision key and its existing cleanup, but do not
  // navigate an embedded browser to a parent-created Blob URL. The document
  // remains in an opaque sandbox; no allow-same-origin permission is added.
  source = replaceOnce(source, /const html = createHtmlDocument\(bundle\);/, 'const html = createHtmlDocument(bundle); // data-mate:html-srcdoc');
  source = replaceOnce(source, /setFrame\(\{\s*data,\s*readRelated,\s*url\s*\}\);/, 'setFrame({ data, readRelated, url, html });');
  return replaceOnce(source, 'src: frame.url,', 'srcDoc: frame.html,');
}

export function patchNotebook(source: string): string {
  if (source.includes('data-mate:notebook-json')) return source;
  source = replaceOnce(source, /metadata: state\.notebook\.metadata,\s*cells: state\.notebook\.cells,\s*kernel: \{/, `metadata: state.notebook.metadata,
        // data-mate:notebook-json: execution jobs are private, not JSON data.
        cells: state.notebook.cells.map(function (cell) {
          const { _runJob, ...publicCell } = cell
          return publicCell
        }),
        kernel: {`);
  return replaceOnce(source,
    '(args, sid) => createSessionMethods(sid).kernelRestartAndRunAll(args)',
    '(args, sid) => createSessionMethods(sid).kernelRestartAndRunAll(Object.assign({}, args || {}, { wait: true }))');
}

export function patchGenuiSource(source: string): string {
  if (source.includes('data-mate:table-details-flag')) return source;
  return replaceOnce(source,
    "} else if (type === 'table' && Array.isArray(out.details)) {",
    `} else if (type === 'table' && typeof out.details === 'boolean') {
    // data-mate:table-details-flag: a display hint carries no row detail data.
    delete out.details
  } else if (type === 'table' && Array.isArray(out.details)) {`);
}

export function patchGenuiHost(source: string): string {
  if (source.includes('data-mate:table-details-flag')) return source;
  return replaceOnce(source,
    'else if (type === "table" && Array.isArray(out.details)) {',
    `else if (type === "table" && typeof out.details === "boolean") {
    // data-mate:table-details-flag
    delete out.details;
  } else if (type === "table" && Array.isArray(out.details)) {`);
}

export function patchGenuiBrowser(source: string): string {
  if (source.includes('data-mate:table-details-flag')) return source;
  // The pinned release minifies local identifiers; capture both identifiers
  // from the normalization branch instead of coupling to their spelling.
  return replaceOnce(source,
    /else if\(([\w$]+)===`table`&&Array\.isArray\(([\w$]+)\.details\)\)(?=\{let [\w$]+=\{columns:\2\.columns,rows:\2\.rows,types:\2\.types\};\2\.details=\2\.details\.map)/,
    'else if($1===`table`&&typeof $2.details===`boolean`)delete $2.details;/* data-mate:table-details-flag */else if($1===`table`&&Array.isArray($2.details))');
}

/** 品牌定制:对话首屏大标题(中英两个 locale 条目)。manifest/标题见
 * patchHtmlTitle/patchManifestName;可见名称本体在品牌插件(packaging/brand)。 */
export function patchConversationHero(source: string): string {
  if (source.includes('data-mate:hero-headline')) return source;
  source = replaceOnce(source, '"hero.headline": "探索未至之境"', `"hero.headline": "${brand.heroHeadlineZh}" /* data-mate:hero-headline */`);
  return replaceOnce(source, '"Into the Unknown"', `"${brand.heroHeadlineEn}"`);
}

export function patchHtmlTitle(source: string): string {
  if (source.includes('data-mate:html-title')) return source;
  return replaceOnce(source, `<title>${brand.officialProductName}</title>`, `<title>${brand.productName}</title> <!-- data-mate:html-title -->`);
}

/** webmanifest 是 JSON,不能加注释;用非标准字段做幂等标记(PWA 清单忽略未知键)。 */
export function patchManifestName(source: string): string {
  if (source.includes('"x-data-mate"')) return source;
  return replaceOnce(source, `"name": "${brand.officialProductName}"`, `"name": "${brand.productName}",\n  "x-data-mate": "brand"`);
}

const genui = { packageName: '@changfenhuang/dsh-genui', version: '0.11.4' };
export const runtimePatches: RuntimePatch[] = [
  { packageName: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', version: '0.2.0-rc.2', file: 'lib/client.js', transform: patchHtmlPreview },
  { packageName: '@beihaizb/dsh-notebook', version: '0.2.4', file: 'lib/index.js', transform: patchNotebook },
  { packageName: '@deepseek-ai/dsh-client-ui-conversation', version: '0.2.0-rc.2', file: 'lib/client.js', transform: patchConversationHero },
  { packageName: '@deepseek-ai/dsh-web-frontend', version: '0.2.0-rc.2', file: 'dist/index.html', transform: patchHtmlTitle },
  { packageName: '@deepseek-ai/dsh-web-frontend', version: '0.2.0-rc.2', file: 'dist/manifest.webmanifest', transform: patchManifestName },
  { ...genui, file: 'src/client/genui-runtime/normalize.ts', transform: patchGenuiSource },
  { ...genui, file: 'lib/index.js', transform: patchGenuiHost },
  { ...genui, file: 'lib/client.js', transform: patchGenuiBrowser },
  { ...genui, file: 'lib/assets/standalone-runtime.js', transform: patchGenuiBrowser },
];

const sha256 = (source: string) => createHash('sha256').update(source).digest('hex');

/** Validate every version/anchor before changing any file. Atomic replacement
 * also breaks pnpm hardlinks rather than altering its shared package store. */
export function applyRuntimePatches(profile: string, apply = false) {
  const planned = runtimePatches.map((patch) => {
    const root = join(profile, 'node_modules', patch.packageName);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    if (manifest.version !== patch.version) throw new Error(`Unsupported ${patch.packageName}@${manifest.version}; expected ${patch.version}`);
    const path = join(root, patch.file);
    const before = readFileSync(path, 'utf8');
    const after = patch.transform(before);
    return { ...patch, path, before, after };
  });
  const results = planned.map(({ packageName, file, before, after }) => ({
    packageName, file, changed: before !== after, beforeSha256: sha256(before), afterSha256: sha256(after),
  }));
  if (apply) {
    const backupRoot = join(profile, '.data-mate-runtime-patches');
    for (const patch of planned) {
      if (patch.before === patch.after) continue;
      const backup = join(backupRoot, patch.packageName, patch.file);
      mkdirSync(dirname(backup), { recursive: true });
      if (!existsSync(backup)) writeFileSync(backup, patch.before);
      const temporary = `${patch.path}.data-mate-tmp`;
      writeFileSync(temporary, patch.after);
      renameSync(temporary, patch.path);
    }
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(join(backupRoot, 'manifest.json'), JSON.stringify(results, null, 2) + '\n');
  }
  return results;
}
