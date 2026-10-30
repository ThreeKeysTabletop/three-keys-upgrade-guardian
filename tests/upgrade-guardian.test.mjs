// Three Keys Upgrade Guardian end-to-end test (GM client).
// Usage: tests/run.sh   or   node tests/upgrade-guardian.test.mjs   (env: URL, FOUNDRY_TESTS=<foundry-test/tests dir>, OUT)
// Requires a running Foundry with the module and the tkug-mock-* modules installed/enabled (tests/run.sh does that).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const FT = process.env.FOUNDRY_TESTS || join(here, '../../foundry-test/tests');
const { chromium } = createRequire(join(FT, 'package.json'))('playwright');
const base = process.env.URL || 'http://localhost:30000';
const out = process.env.OUT || join(FT, 'out', 'upgrade-guardian');
mkdirSync(out, { recursive: true });
const ID = 'three-keys-upgrade-guardian';
const OWN_MANIFEST = readFileSync(join(here, '..', 'module.json'), 'utf8');
const results = []; const errors = []; const shots = [];
let lastStep = 'start';
const ok = (name, pass, detail = '') => { lastStep = name; results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'], baseURL: base });
// External manifests (GitHub etc.) are answered locally so the run is hermetic. Our own manifest returns our module.json.
await ctx.route(url => !url.toString().startsWith(base), route => {
  const u = route.request().url();
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: u.includes('three-keys-upgrade-guardian') ? OWN_MANIFEST : '{}' });
});
// A slow manifest host, to prove timeouts are graceful.
await ctx.route('**/tkug-mock-untested/slow.json', async route => { await sleep(4000); route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }).catch(() => {}); });
await ctx.route('**/tkug-release.json', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ latest_release: { generation: 15, build: 331 } }) }));
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') errors.push(`console [after: ${lastStep}]: ${m.text()}`); });
page.on('pageerror', e => errors.push(`pageerror [after: ${lastStep}]: ${e.stack || e.message}`));
const shot = async name => { const p = join(out, `${name}.png`); await page.screenshot({ path: p }); shots.push(p); };
const statusOf = id => page.$eval(`#tkug-report tr[data-id="${id}"]`, tr => tr.dataset.status).catch(() => null);
const rowText = id => page.$eval(`#tkug-report tr[data-id="${id}"]`, tr => tr.innerText).catch(() => '');
const settle = () => page.waitForFunction(() => !document.querySelector('#tkug-report .tkug-busy')?.textContent, null, { timeout: 30000 });
const cfg = () => page.evaluate(() => game.settings.get('core', 'moduleConfiguration'));
const dialogBtn = async action => { const sel = `dialog.application button[data-action="${action}"]`; await page.waitForSelector(sel, { timeout: 10000 }); await page.locator(sel).last().click(); await sleep(800); };

try {
  await page.goto(base + '/join'); await page.waitForSelector('select[name="userId"]', { timeout: 60000 });
  const uid = await page.$eval('select[name="userId"]', s => [...s.options].find(o => o.textContent.trim() === 'Gamemaster')?.value);
  await page.selectOption('select[name="userId"]', uid); await page.click('button[name="join"]');
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 120000 });
  await sleep(2500);
  await page.evaluate(async ID => { for (const [k, v] of Object.entries({ targetVersion: '', targetSystemVersion: '', releaseApiUrl: '', fetchTimeout: 2, checklist: {}, snapshots: [], showInactive: false })) await game.settings.set(ID, k, v); }, ID);

  // ---------- startup notice ----------
  const st = await page.evaluate(ID => ({ s: game.modules.get(ID).api.startup, n: [...document.querySelectorAll('#notifications li, #notifications .notification')].map(e => e.textContent).join(' | '), active: game.modules.get(ID).active }), ID);
  ok('Module active, startup scan ran', st.active && !!st.s, JSON.stringify(st.s));
  ok('Startup notice warns about at-risk modules (mock-old)', st.s?.problems.includes('tkug-mock-old') && /Upgrade Guardian/.test(st.n), st.n.slice(0, 160));
  await shot('01-startup-notice');

  // ---------- pure logic ----------
  const logic = await page.evaluate(ID => { const a = game.modules.get(ID).api; const e = (c, v) => a.evaluate(c, v).status; return [
    e({ minimum: '13', verified: '14' }, '14.369'), e({ minimum: '13', verified: '14' }, '15.1'), e({ verified: '14.300' }, '14.369'),
    e({ minimum: '13', verified: '14', maximum: '14' }, '15'), e({ minimum: '15' }, '14.369'), e({}, '14.369'), a.cmp('14.369', '14'), a.cmp('15', '14.369')]; }, ID);
  ok('evaluate(): safe/likely/untested/blocked/blocked/untested + generation compare', JSON.stringify(logic) === JSON.stringify(['safe', 'likely', 'untested', 'blocked', 'blocked', 'untested', 0, 1]), JSON.stringify(logic));

  // ---------- GM-only entry points ----------
  const entry = await page.evaluate(async () => { const t = ui.sidebar.tabs?.settings ?? ui.settings; ui.sidebar.expand?.(); ui.sidebar.changeTab('settings', 'primary'); await new Promise(r => setTimeout(r, 800)); return { btn: !!document.querySelector('#tkug-open'), menu: game.settings.menus.has('three-keys-upgrade-guardian.report') && game.settings.menus.get('three-keys-upgrade-guardian.report').restricted }; });
  ok('Settings sidebar button and restricted settings menu exist', entry.btn && entry.menu, JSON.stringify(entry));

  // ---------- report ----------
  await page.evaluate(ID => game.settings.set(ID, 'targetVersion', '15.330'), ID);
  await page.click('#tkug-open');
  await page.waitForSelector('#tkug-report tr[data-id="tkug-mock-old"]', { timeout: 20000 });
  ok('Report opens with target from settings', (await page.inputValue('#tkug-target')) === '15.330');
  const sts = {}; for (const id of ['tkug-mock-safe', 'tkug-mock-untested', 'tkug-mock-old', 'tkug-mock-max', 'tkug-mock-sys', ID, 'dnd5e']) sts[id] = await statusOf(id);
  ok('Safe: verified 15 vs 15.330', sts['tkug-mock-safe'] === 'safe');
  ok('Untested: verified 15.300 vs 15.330', sts['tkug-mock-untested'] === 'untested');
  ok('Likely to break: verified 12 (older generation)', sts['tkug-mock-old'] === 'likely');
  ok('Blocked: maximum 14', sts['tkug-mock-max'] === 'blocked');
  ok('Dependency at risk propagates (mock-sys requires mock-max)', sts['tkug-mock-sys'] === 'likely' && /Depends on tkug-mock-max/.test(await rowText('tkug-mock-sys')));
  ok('Game system row present', !!sts.dnd5e, JSON.stringify(sts));
  const cur = await page.$eval('#tkug-report tr[data-id="tkug-mock-max"] td:nth-child(4) .tkug-badge', e => e.dataset.status);
  ok('Current-core column judged separately (mock-max safe on 14)', cur === 'safe', cur);
  ok('Compatibility min/verified/max shown', /13 \/ 14 \/ 14/.test(await rowText('tkug-mock-max')));
  ok('Deprecation warning attributed to mock-old', /deprecation warning/.test(await rowText('tkug-mock-old')) && /SomeOldApi/.test(await rowText('tkug-mock-old')), (await rowText('tkug-mock-old')).replace(/\s+/g, ' ').slice(0, 200));
  const counts = await page.$$eval('.tkug-count', es => Object.fromEntries(es.map(e => [e.dataset.count, +e.textContent])));
  ok('Summary counts', counts.safe >= 1 && counts.untested >= 1 && counts.likely >= 2 && counts.blocked >= 1, JSON.stringify(counts));
  await shot('02-report-target-15');

  // inactive modules
  await page.click('#tkug-report input.tkug-toggle-inactive'); await page.waitForSelector('#tkug-report tr[data-id="tkug-mock-dep"]', { timeout: 5000 }).catch(() => {});
  const dep = await rowText('tkug-mock-dep');
  ok('Inactive module shown on demand: missing dependency => Blocked', (await statusOf('tkug-mock-dep')) === 'blocked' && /tkug-mock-missing, which is not installed/.test(dep), dep.replace(/\s+/g, ' ').slice(0, 200));
  await shot('03-inactive-dependencies');
  await page.click('#tkug-report input.tkug-toggle-inactive'); await sleep(500);

  // system target version
  await page.fill('#tkug-target-system', '4.0'); await page.press('#tkug-target-system', 'Tab'); await settle(); await sleep(500);
  ok('Target system 4.0 blocks module needing dnd5e >= 5.0', (await statusOf('tkug-mock-sys')) === 'blocked' && /Not compatible with dnd5e 4.0/.test(await rowText('tkug-mock-sys')));
  await page.fill('#tkug-target-system', ''); await page.press('#tkug-target-system', 'Tab'); await settle(); await sleep(500);

  // ---------- manifest update check ----------
  const t0 = Date.now();
  await page.click('#tkug-report button[data-action="checkUpdates"]');
  await sleep(300); await settle(); await sleep(300);
  const dt = Date.now() - t0;
  ok('Newer version found and supports target (mock-old 2.0.0)', /2\.0\.0 supports target/.test(await rowText('tkug-mock-old')));
  ok('Up-to-date manifest reported (mock-safe)', /up to date/.test(await rowText('tkug-mock-safe')));
  ok('Slow manifest times out gracefully (2s timeout)', /could not check/.test(await rowText('tkug-mock-untested')) && dt < 8000, `${dt} ms`);
  ok('No manifest URL handled', /no manifest URL/.test(await rowText('tkug-mock-max')));
  ok('Own manifest (mocked GitHub) is up to date', /up to date/.test(await rowText(ID)));
  await shot('04-update-check');

  // ---------- detect latest ----------
  await page.evaluate(ID => game.settings.set(ID, 'releaseApiUrl', location.origin + '/tkug-release.json'), ID);
  await page.click('#tkug-report button[data-action="detect"]'); await sleep(300); await settle(); await sleep(300);
  const det = await page.evaluate(() => ({ v: document.querySelector('#tkug-target').value, src: document.querySelector('.tkug-detect-source').textContent, cu: game.data.coreUpdate }));
  ok('Detect latest uses Foundry update check, else release API (15.331)', det.cu?.version ? det.v === String(det.cu.version) : det.v === '15.331', JSON.stringify(det).slice(0, 200));
  await page.fill('#tkug-target', '15.330'); await page.press('#tkug-target', 'Tab'); await settle(); await sleep(500);

  // ---------- export ----------
  let [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#tkug-report button[data-action="exportMd"]')]);
  const md = readFileSync(await dl.path(), 'utf8'); writeFileSync(join(out, 'report.md'), md);
  ok('Markdown export', dl.suggestedFilename().endsWith('.md') && md.includes('| TKUG Mock Old') && md.includes('Likely to break') && md.includes('15.330'), dl.suggestedFilename());
  [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#tkug-report button[data-action="exportJson"]')]);
  const js = JSON.parse(readFileSync(await dl.path(), 'utf8')); writeFileSync(join(out, 'report.json'), JSON.stringify(js, null, 2));
  ok('JSON export', js.target === '15.330' && js.rows.find(r => r.id === 'tkug-mock-old')?.update?.version === '2.0.0', `${js.rows.length} rows`);
  await page.click('#tkug-report button[data-action="copy"]'); await sleep(600);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(e => 'ERR ' + e.message);
  ok('Copy to clipboard (Markdown)', clip.startsWith('# Upgrade Guardian') && clip.includes('tkug-mock-max'), clip.slice(0, 40));

  // ---------- checklist ----------
  await page.check('#tkug-report input[data-check="Backup"]'); await sleep(500);
  ok('Checklist tick saved to world setting', (await page.evaluate(ID => game.settings.get(ID, 'checklist').Backup, ID)) === true);

  // ---------- disable risky (propose, cancel, confirm) ----------
  const before = await cfg();
  await page.click('#tkug-report button[data-action="disableRisky"]');
  await page.waitForSelector('.tkug-propose input', { timeout: 10000 });
  const proposed = await page.$$eval('.tkug-propose input', is => is.map(i => i.name));
  ok('Proposes only active Likely/Blocked modules, never itself', ['tkug-mock-old', 'tkug-mock-max', 'tkug-mock-sys'].every(i => proposed.includes(i)) && !proposed.includes(ID) && !proposed.includes('tkug-mock-safe') && !proposed.includes('tkug-mock-dep'), proposed.join(','));
  await shot('05-disable-proposal');
  await dialogBtn('cancel');
  const cc = await cfg(), cs = await page.evaluate(ID => game.settings.get(ID, 'snapshots').length, ID);
  ok('Cancel changes nothing and saves no snapshot', JSON.stringify(cc) === JSON.stringify(before) && cs === 0, `snapshots=${cs} dialogs=${await page.locator('dialog.application').count()}`);
  await page.click('#tkug-report button[data-action="disableRisky"]');
  await page.waitForSelector('.tkug-propose input', { timeout: 10000 });
  await page.uncheck('.tkug-propose input[name="tkug-mock-sys"]');
  await dialogBtn('confirm');
  await page.waitForSelector('dialog.application button[data-action="no"], .application.dialog button[data-action="no"]', { timeout: 10000 });
  await shot('06-reload-prompt');
  await dialogBtn('no');
  const after = await cfg(); const snaps = await page.evaluate(ID => game.settings.get(ID, 'snapshots'), ID);
  ok('Confirm disables only ticked modules', after['tkug-mock-old'] === false && after['tkug-mock-max'] === false && after['tkug-mock-sys'] === true && after[ID] === true, JSON.stringify(after));
  ok('Snapshot of previous module list saved', snaps.length === 1 && snaps[0].config['tkug-mock-old'] === true, snaps[0]?.label);
  await shot('07-after-disable');

  // ---------- restore ----------
  await page.click('#tkug-report button[data-action="restore"]');
  await dialogBtn('yes');
  await page.waitForSelector('dialog.application button[data-action="no"], .application.dialog button[data-action="no"]', { timeout: 10000 });
  await dialogBtn('no');
  ok('Restore puts the module list back', JSON.stringify(await cfg()) === JSON.stringify(before));
  await shot('08-restored');

  // ---------- GM only ----------
  const gmOnly = await page.evaluate(ID => { const s = Object.getOwnPropertyDescriptor(game.user, 'isGM'); Object.defineProperty(game.user, 'isGM', { value: false, configurable: true });
    const r = game.modules.get(ID).api.open(); delete game.user.isGM; if (s) Object.defineProperty(game.user, 'isGM', s); return r === null; }, ID);
  ok('open() refuses non-GM users', gmOnly);
} catch (e) { errors.push(`fatal [after: ${lastStep}]: ${e.stack || e.message}`); await shot('99-fatal').catch(() => {}); }
await page.evaluate(ID => Promise.all([game.settings.set(ID, 'targetVersion', ''), game.settings.set(ID, 'releaseApiUrl', '')]), ID).catch(() => {});

await browser.close();
const failed = results.filter(r => !r.pass).length;
writeFileSync(join(out, 'results.json'), JSON.stringify({ results, errors, shots }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed, console errors: ${errors.length}`);
if (errors.length) console.log(' - ' + errors.join('\n - '));
process.exit(failed || errors.length ? 1 : 0);
