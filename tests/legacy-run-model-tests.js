const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'n6-build-preview.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
if (!source) throw new Error('No inline script found');

// Load the actual model functions while skipping DOM rendering/listener startup.
const marker = "  $$('.lab-tab').forEach";
const cut = source.indexOf(marker);
if (cut < 0) throw new Error('UI startup marker not found');
const exportCode = `\n  globalThis.__n6 = {limits,psus,coolers,gpus,rams,accessories,sataDeviceCount,ramModuleCount,hasHba,backplaneHarnessCount,psuPlacement,rearFanAvailable,coolerPlanningLimit,caseFanGroupCount,powerModel,fitModel,gpuVerdict,priceModel};\n})();`;
const context = {
  console,
  Math,
  Set,
  document: {
    getElementById() {
      return { querySelector() { return null; }, querySelectorAll() { return []; } };
    }
  }
};
vm.createContext(context);
vm.runInContext(source.slice(0, cut) + exportCode, context, {filename: 'n6-build-preview.inline.js'});
const m = context.__n6;

function normalizedInput(input) {
  const boot = input.boot || 'bay';
  return {...input, disks: Math.min(Number(input.disks || 1), boot === 'bay' ? 8 : 9)};
}

function configFrom(input) {
  const i = normalizedInput(input);
  const psuKey = i.psuKey || 'focus850';
  const secondaryPsuKey = i.secondaryPsuKey || 'sf750';
  const coolerKey = i.coolerKey || 'axp90';
  const gpuKey = i.gpuKey || 'none';
  const ramKey = i.ramKey || 'd16';
  const psuPosition = i.psuPosition || 'auto';
  const cooler = m.coolers[coolerKey];
  const frontRequested = cooler.fit === 'front240' || Boolean(i.frontFans);
  const frontSfx = m.psus[psuKey].form === 'SFX' && psuPosition !== 'bottom';
  return {
    psuKey,
    secondaryPsuKey,
    coolerKey,
    gpuKey,
    ramKey,
    psuPosition,
    psu: m.psus[psuKey],
    secondaryPsu: m.psus[secondaryPsuKey],
    dualStart: i.dualStart || 'sync',
    cooler,
    gpu: m.gpus[gpuKey],
    ram: m.rams[ramKey],
    disks: i.disks,
    ambient: 25,
    pl1: 90,
    pl2: 125,
    boot: i.boot || 'bay',
    hbaMode: i.hbaMode || 'auto',
    fan: 'balanced',
    workload: 'idle',
    frontRequested,
    front: frontRequested && !frontSfx,
    rear: Boolean(i.rearFan),
    drive: Boolean(i.driveFans),
    side: Boolean(i.sideFans),
    preserve: i.preserveHba !== false
  };
}

const topology = {
  rearUpperATX: 'rear_upper_atx',
  frontSFX: 'front_sfx',
  bottomSFX: 'bottom_sfx',
  rearUpperATX_plus_bottomSFX: 'rear_upper_atx_plus_bottom_sfx',
  frontSFX_plus_bottomSFX: 'front_sfx_plus_bottom_sfx',
  invalidATXBottom: 'invalid_atx_bottom'
};

const failures = [];
let assertions = 0;
function check(id, name, actual, expected) {
  if (expected === undefined) return;
  assertions++;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({id, name, actual, expected});
}

const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-scenarios.json'), 'utf8'));
for (const scenario of matrix.scenarios) {
  const raw = scenario.input;
  const c = configFrom(raw);
  const e = scenario.expected;
  const fit = m.fitModel(c);
  const normalized = raw.disks !== c.disks;
  const expectedSata = e.sataDevicesAfterNormalization ?? e.sataDevices;
  const expectedHba = e.hbaPresent;
  if (e.normalized && typeof e.normalized === 'object') {
    const actualNormalized = {};
    if ('disks' in e.normalized) actualNormalized.disks = c.disks;
    if ('frontFans' in e.normalized) actualNormalized.frontFans = c.front;
    check(scenario.id, 'normalized', actualNormalized, e.normalized);
  } else check(scenario.id, 'normalized', normalized, e.normalized);
  check(scenario.id, 'dataHddMax', c.boot === 'bay' ? 8 : 9, e.dataHddMax);
  check(scenario.id, 'sataDevices', m.sataDeviceCount(c), expectedSata);
  check(scenario.id, 'hbaPresent', m.hasHba(c), expectedHba);
  check(scenario.id, 'psuTopology', topology[m.psuPlacement(c)], e.psuTopology);
  check(scenario.id, 'frontFansEffective', c.front, e.frontFansEffective);
  check(scenario.id, 'rearFanAvailable', m.rearFanAvailable(c), e.rearFanAvailable);
  check(scenario.id, 'coolerPlanningLimitMm', m.coolerPlanningLimit(c), e.coolerPlanningLimitMm);
  check(scenario.id, 'ramHeightMm', c.ram.height, e.ramHeightMm);
  if (e.gpuHbaCoexistence) {
    const coexist = m.hasHba(c) ? (c.gpu.slots <= 2 ? 'yes' : 'no') : c.preserve && c.gpu.slots <= 2 ? 'reserved_envelope_preserved' : 'not_applicable';
    check(scenario.id, 'gpuHbaCoexistence', coexist, e.gpuHbaCoexistence);
  }
  if (e.action === 'reject') check(scenario.id, 'rejectedOrNormalized', fit.level === 'bad' || normalized, true);
  if (e.verdict === 'bad') check(scenario.id, 'verdictBad', fit.level, 'bad');
}

// Direct P0 regression assertions against the actual model.
const p0 = [
  ['8 HDD + bay boot uses 9 SATA and HBA', () => {const c=configFrom({disks:8,boot:'bay'});return m.sataDeviceCount(c)===9&&m.hasHba(c);}],
  ['9 HDD + bay boot normalizes to 8 data drives', () => configFrom({disks:9,boot:'bay'}).disks===8],
  ['9 HDD + M.2 boot keeps 9 data drives and HBA', () => {const c=configFrom({disks:9,boot:'m2'});return c.disks===9&&m.hasHba(c);}],
  ['A4000 one-slot coexists with required HBA', () => {const c=configFrom({disks:8,boot:'bay',gpuKey:'a4000'});return m.hasHba(c)&&m.gpuVerdict(c.gpu,c).level!=='bad';}],
  ['three-slot RTX 3090 conflicts with HBA', () => {const c=configFrom({disks:9,boot:'m2',gpuKey:'rtx3090'});return m.gpuVerdict(c.gpu,c).level==='bad';}],
  ['front SFX + 240 AIO is rejected', () => {const c=configFrom({psuKey:'sf750',psuPosition:'auto',coolerKey:'aio240'});return m.fitModel(c).level==='bad';}],
  ['dual PSU load is split across main and drive rails', () => {const c=configFrom({psuPosition:'dual',disks:9,boot:'m2'}),p=m.powerModel(c);return p.dual&&p.mainDc>0&&p.driveDc>0&&p.wall===p.mainWall+p.driveWall;}],
  ['unknown secondary PSU blocks direct purchase', () => {const c=configFrom({psuPosition:'dual',secondaryPsuKey:'unknown450'});return m.fitModel(c).level==='bad';}],
  ['price increases by at least eight HDD mid-prices from 1 to 9', () => {const a=configFrom({disks:1,boot:'m2'}),b=configFrom({disks:9,boot:'m2'});return m.priceModel(b,false,9)-m.priceModel(a,false,1)>=8*4500;}],
  ['two DIMMs are represented as two modules', () => m.ramModuleCount(configFrom({ramKey:'d16x2'}))===2],
  ['DDR5-8000 is warning-only planning, not verified speed', () => {const c=configFrom({ramKey:'xmp8000'}),f=m.fitModel(c);return f.level==='warn'&&f.warnings.some(x=>x.includes('8000'));}],
  ['thermal copy is explicitly non-CFD and non-measured', () => /非 CFD/.test(html)&&/非实测/.test(html)]
];
for (const [name, fn] of p0) check('P0', name, Boolean(fn()), true);

const report = {
  generatedAt: new Date().toISOString(),
  scenarios: matrix.scenarios.length,
  assertions,
  p0Assertions: p0.length,
  failures
};
fs.writeFileSync(path.join(__dirname, 'model-test-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
