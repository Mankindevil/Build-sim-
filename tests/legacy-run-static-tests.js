const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'n6-build-preview.html'), 'utf8');
const standalonePath = path.join(root, 'n6-build-preview-standalone.html');
const standalone = fs.existsSync(standalonePath) ? fs.readFileSync(standalonePath, 'utf8') : '';
const failures = [];
let assertions = 0;
function expect(name, ok, detail='') { assertions++; if (!ok) failures.push({name, detail}); }

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
expect('one inline script', scripts.length === 1, scripts.length);
for (const [index, script] of scripts.entries()) {
  try { new Function(script); expect(`script ${index} syntax`, true); }
  catch (error) { expect(`script ${index} syntax`, false, error.stack); }
}

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const idSet = new Set(ids);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
expect('no duplicate DOM ids', duplicateIds.length === 0, duplicateIds);

const queriedIds = [...html.matchAll(/\$\('#([^']+)'\)/g)].map(m => m[1]).filter(id => /^[A-Za-z][\w-]*$/.test(id));
const missingQueriedIds = [...new Set(queriedIds.filter(id => !idSet.has(id)))];
expect('all literal #id queries resolve', missingQueriedIds.length === 0, missingQueriedIds);

const localPaths = [...html.matchAll(/['"]((?:assets|references)\/[A-Za-z0-9_./-]+)['"]/g)].map(m => m[1]);
const missingLocalPaths = [...new Set(localPaths.filter(rel => !fs.existsSync(path.join(root, rel))))];
expect('all local assets and references exist', missingLocalPaths.length === 0, missingLocalPaths);

expect('no false official blueprint overlay claim', !html.includes('官方图纸叠加'));
expect('fan is not assumed bundled', html.includes('N6 手册只列安装位') && !html.includes('硬盘舱原配'));
expect('thermal map says non-CFD', html.includes('非 CFD') && html.includes('非实测'));
expect('3D drag handler present', html.includes("addEventListener('pointerdown'") && html.includes("addEventListener('pointermove'"));
expect('3D zoom handler present', html.includes("addEventListener('wheel'"));
expect('3D reset controls present', idSet.has('spatial-reset') && html.includes("addEventListener('dblclick',resetSpatialView)"));
expect('official evidence view present', idSet.has('reference-view') && idSet.has('reference-select'));
expect('RAM and both M.2 parts displayed', html.includes('DDR5 DIMM') && html.includes('980 PRO #1') && html.includes('980 PRO #2'));
expect('DDR4 hard incompatibility disclosed', html.includes('不兼容 DDR4') && html.includes('RDIMM'));
expect('dual PSU selectors wired', ['secondary-psu-select','dual-start-select'].every(id => html.includes(`'${id}'`)));
expect('custom GPU dimensions and budget wired', ['gpu-custom-length','gpu-custom-slots','gpu-custom-tgp','gpu-custom-vram','gpu-custom-price'].every(id => html.includes(`'${id}'`)));
expect('mobile breakpoint at 480px', /@media \(max-width: 480px\)/.test(html));
expect('mobile grids use minmax zero', /max-width: 480px[\s\S]{0,600}minmax\(0,1fr\)/.test(html));
expect('wide tables are scroll containers', /\.table-responsive\s*\{[^}]*overflow-x:\s*auto/.test(html));
expect('price table has history column', html.includes('可信历史价'));
expect('unknown history is explicit', html.includes("'未知'"));
expect('standalone generated', standalone.includes('<iframe') && standalone.includes('NAS 模拟装机台'));
expect('standalone embeds local images', !/(?:assets)\/[A-Za-z0-9_./-]+/.test(standalone) && standalone.includes('data:image/'));

const report = {generatedAt: new Date().toISOString(), assertions, failures};
fs.writeFileSync(path.join(__dirname, 'static-test-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
