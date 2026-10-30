/**
 * Three Keys Upgrade Guardian — pre-update compatibility scanner for Foundry VTT v13/v14.
 * (c) Three Keys Tabletop, MIT License.
 */
const ID = "three-keys-upgrade-guardian";
const L = (k, d) => d ? game.i18n.format(`TKUG.${k}`, d) : game.i18n.localize(`TKUG.${k}`);
const S = k => `TKUG.Settings.${k}`;
const get = k => game.settings.get(ID, k);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const STATUS = { SAFE: "safe", UNTESTED: "untested", LIKELY: "likely", BLOCKED: "blocked" };
const RANK = { safe: 0, untested: 1, likely: 2, blocked: 3 };
const worst = (...s) => s.filter(Boolean).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), STATUS.SAFE);

/* ------------------------------------------------------------------ */
/*  Deprecation capture (installed at module load, before init)       */
/* ------------------------------------------------------------------ */
const deprecations = new Map(); // packageId -> { count, samples:Set }
const DEPRECATION_RX = /deprecat|Deprecated since|will be removed in/i;
function packagesFromText(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\/(modules|systems)\/([A-Za-z0-9_.-]+)\//g)) if (m[2] !== ID) ids.add(`${m[1] === "systems" ? "system:" : ""}${m[2]}`);
  return ids;
}
function recordDeprecation(args) {
  try {
    const text = args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : "")).join(" ");
    if (!DEPRECATION_RX.test(text)) return;
    const ids = packagesFromText(text);
    if (!ids.size) for (const id of packagesFromText(new Error().stack ?? "")) ids.add(id);
    const first = text.split("\n")[0].slice(0, 240);
    for (const id of ids) {
      const e = deprecations.get(id) ?? { count: 0, samples: new Set() };
      e.count++; if (e.samples.size < 3) e.samples.add(first);
      deprecations.set(id, e);
    }
  } catch { /* never interfere with logging */ }
}
const _warn = console.warn;
console.warn = function (...args) { recordDeprecation(args); return _warn.apply(this, args); };

/* ------------------------------------------------------------------ */
/*  Version logic                                                      */
/* ------------------------------------------------------------------ */
const parts = v => String(v ?? "").trim().replace(/^v/i, "").split(".").map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
export const generation = v => parts(v)[0] ?? 0;
/** Compare a concrete version to a compatibility spec. A one-part spec ("14") is a whole generation. */
export function cmp(version, spec) {
  const a = parts(version), b = parts(spec);
  const n = b.length === 1 ? 1 : Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}
/** Evaluate a package compatibility block against a core version. */
export function evaluate(compat = {}, version) {
  const { minimum, verified, maximum } = compat ?? {};
  if (!version) return { status: STATUS.UNTESTED, reason: L("Reason.NoTarget") };
  if (minimum && cmp(version, minimum) < 0) return { status: STATUS.BLOCKED, reason: L("Reason.BelowMinimum", { v: minimum }) };
  if (maximum && cmp(version, maximum) > 0) return { status: STATUS.BLOCKED, reason: L("Reason.AboveMaximum", { v: maximum }) };
  if (!verified) return { status: STATUS.UNTESTED, reason: L("Reason.NoVerified") };
  if (cmp(version, verified) <= 0) return { status: STATUS.SAFE, reason: L("Reason.Verified", { v: verified }) };
  if (generation(verified) < generation(version)) return { status: STATUS.LIKELY, reason: L("Reason.OlderGeneration", { v: verified }) };
  return { status: STATUS.UNTESTED, reason: L("Reason.OlderBuild", { v: verified }) };
}
/** Does a package version satisfy a relationship compatibility block (min/verified/max on the dependency's own version)? */
function satisfies(version, c = {}) {
  if (!c) return true;
  if (c.minimum && foundry.utils.isNewerVersion(c.minimum, version)) return false;
  if (c.maximum && foundry.utils.isNewerVersion(version, c.maximum)) return false;
  return true;
}
const compatOf = p => { const c = p?.compatibility ?? {}; return { minimum: c.minimum ?? "", verified: c.verified ?? "", maximum: c.maximum ?? "" }; };
const relList = r => (r ? Array.from(r) : []);

/* ------------------------------------------------------------------ */
/*  Remote manifests and core release detection                        */
/* ------------------------------------------------------------------ */
const manifestCache = new Map();
export async function fetchJson(url, timeoutSec = get("fetchTimeout")) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("no-url");
  if (globalThis.navigator?.onLine === false) throw new Error("offline");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), Math.max(1, timeoutSec) * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { throw new Error(e.name === "AbortError" ? "timeout" : (e.message || "network")); }
  finally { clearTimeout(t); }
}
async function checkUpdate(pkg, target) {
  const url = pkg.manifest;
  if (!url) return { state: "none", note: L("Update.NoManifest") };
  const key = `${url}`;
  let remote = manifestCache.get(key);
  if (!remote) {
    try { remote = { ok: true, data: await fetchJson(url) }; } catch (e) { remote = { ok: false, error: e.message }; }
    manifestCache.set(key, remote);
  }
  if (!remote.ok) return { state: "error", note: L("Update.Error", { e: remote.error }) };
  const d = remote.data ?? {};
  const version = d.version ?? "";
  const newer = !!version && foundry.utils.isNewerVersion(version, pkg.version);
  const ev = evaluate(d.compatibility ?? {}, target);
  return { state: newer ? "newer" : "current", version, compatibility: compatOf(d), targetStatus: ev.status,
    supportsTarget: ev.status === STATUS.SAFE || ev.status === STATUS.UNTESTED };
}
/** Best guess at the newest core release, without network unless releaseApiUrl is set. */
export async function detectLatestCore({ remote = true } = {}) {
  const cu = game.data?.coreUpdate;
  if (cu?.version) return { version: String(cu.version), source: "coreUpdate" };
  const url = get("releaseApiUrl");
  if (remote && url) {
    try {
      const j = await fetchJson(url); const r = j?.latest_release ?? j?.release ?? j;
      const v = r?.version ?? (r?.generation && r?.build ? `${r.generation}.${r.build}` : null);
      if (v) return { version: String(v), source: "releaseApi" };
    } catch { /* fall through */ }
  }
  const maxGen = game.release?.maxStableGeneration ?? game.data?.release?.maxStableGeneration;
  if (maxGen && maxGen > game.release.generation) return { version: String(maxGen), source: "maxGeneration" };
  return { version: game.version, source: "current" };
}

/* ------------------------------------------------------------------ */
/*  Scan                                                               */
/* ------------------------------------------------------------------ */
export async function scan({ target, targetSystem = "", remote = false, onProgress } = {}) {
  target ||= game.version;
  const sys = game.system;
  const sysVersion = targetSystem || sys.version;
  const warnings = game.data?.packageWarnings ?? {};
  const rows = [];
  const mods = [...game.modules.values()].sort((a, b) => a.title.localeCompare(b.title));
  const base = new Map();
  for (const m of mods) base.set(m.id, evaluate(m.compatibility, target));
  const mkRow = (pkg, type) => {
    const tgt = type === "system" ? evaluate(pkg.compatibility, target) : base.get(pkg.id);
    return { id: pkg.id, type, title: pkg.title, version: pkg.version, active: type === "system" ? true : !!pkg.active,
      manifest: pkg.manifest ?? "", compatibility: compatOf(pkg), current: evaluate(pkg.compatibility, game.version), target: tgt,
      issues: [], deprecations: null, update: null, status: tgt.status };
  };
  rows.push(mkRow(sys, "system"));
  for (const m of mods) {
    const row = mkRow(m, "module");
    const rel = m.relationships ?? {};
    for (const r of relList(rel.requires)) {
      const type = r.type ?? "module";
      if (type === "system") {
        if (r.id !== sys.id) row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.RequiresOtherSystem", { id: r.id }) });
        else if (!satisfies(sysVersion, r.compatibility)) row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.SystemVersion", { id: r.id, v: sysVersion }) });
        continue;
      }
      const dep = game.modules.get(r.id);
      if (!dep) { row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.MissingDependency", { id: r.id }) }); continue; }
      if (!satisfies(dep.version, r.compatibility)) row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.DependencyVersion", { id: r.id, v: dep.version }) });
      if (m.active && !dep.active) row.issues.push({ status: STATUS.LIKELY, text: L("Issue.DependencyInactive", { id: r.id }) });
      const ds = base.get(r.id)?.status;
      if (ds === STATUS.BLOCKED || ds === STATUS.LIKELY) row.issues.push({ status: STATUS.LIKELY, text: L("Issue.DependencyAtRisk", { id: r.id, s: L(`Status.${ds}`) }) });
    }
    const systems = relList(rel.systems);
    if (systems.length) {
      const mine = systems.find(s => s.id === sys.id);
      if (!mine) row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.NotForSystem", { id: sys.id }) });
      else if (!satisfies(sysVersion, mine.compatibility)) row.issues.push({ status: STATUS.BLOCKED, text: L("Issue.SystemVersion", { id: sys.id, v: sysVersion }) });
    }
    rows.push(row);
  }
  for (const row of rows) {
    const d = deprecations.get(row.type === "system" ? `system:${row.id}` : row.id);
    if (d) { row.deprecations = { count: d.count, samples: [...d.samples] }; row.issues.push({ status: STATUS.UNTESTED, text: L("Issue.Deprecations", { n: d.count }) }); }
    for (const w of [warnings[row.id]?.warning ?? [], warnings[row.id]?.error ?? []].flat()) row.issues.push({ status: STATUS.UNTESTED, text: L("Issue.PackageWarning", { w: String(w).slice(0, 200) }) });
    row.status = worst(row.target.status, ...row.issues.map(i => i.status));
  }
  if (remote) {
    const todo = rows;
    let done = 0;
    await Promise.all(todo.map(async row => {
      const pkg = row.type === "system" ? sys : game.modules.get(row.id);
      row.update = await checkUpdate(pkg, target);
      onProgress?.(++done, todo.length);
    }));
  }
  const counts = Object.fromEntries(Object.values(STATUS).map(s => [s, rows.filter(r => r.active && r.status === s).length]));
  return { generated: new Date().toISOString(), world: game.world.id, core: game.version, target, system: { id: sys.id, version: sys.version, target: sysVersion },
    remoteChecked: !!remote, counts, rows };
}
export const problems = report => report.rows.filter(r => r.active && r.type === "module" && r.id !== ID && (r.status === STATUS.BLOCKED || r.status === STATUS.LIKELY));

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */
const fmtCompat = c => `${c.minimum || "–"} / ${c.verified || "–"} / ${c.maximum || "–"}`;
export function toMarkdown(rep) {
  const lines = [`# ${L("Title")}`, "",
    `- ${L("Export.World")}: ${rep.world}`, `- ${L("Export.Core")}: ${rep.core}`, `- ${L("Export.Target")}: ${rep.target}`,
    `- ${L("Export.System")}: ${rep.system.id} ${rep.system.version}${rep.system.target !== rep.system.version ? ` → ${rep.system.target}` : ""}`,
    `- ${L("Export.Generated")}: ${rep.generated}`,
    `- ${Object.entries(rep.counts).map(([s, n]) => `${L(`Status.${s}`)}: ${n}`).join(" · ")}`, "",
    `| ${L("Col.Package")} | ${L("Col.Version")} | ${L("Col.Active")} | ${L("Col.Compat")} | ${L("Col.Current")} | ${L("Col.Target")} | ${L("Col.Update")} | ${L("Col.Notes")} |`,
    "|---|---|---|---|---|---|---|---|"];
  const cell = s => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (const r of rep.rows) {
    const up = !r.update ? "" : r.update.state === "newer" ? `${r.update.version}${r.update.supportsTarget ? " ✓" : " ✗"}` : r.update.state === "current" ? L("Update.Current") : r.update.state === "none" ? "" : L("Update.Unknown");
    lines.push(`| ${cell(`${r.title} (\`${r.id}\`)`)} | ${cell(r.version)} | ${r.active ? "✓" : ""} | ${cell(fmtCompat(r.compatibility))} | ${L(`Status.${r.current.status}`)} | **${L(`Status.${r.status}`)}** | ${cell(up)} | ${cell([r.target.reason, ...r.issues.map(i => i.text)].join("; "))} |`);
  }
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------ */
/*  Snapshots and disabling                                            */
/* ------------------------------------------------------------------ */
export async function saveSnapshot(label) {
  const snaps = foundry.utils.deepClone(get("snapshots") ?? []);
  const snap = { id: foundry.utils.randomID(), time: new Date().toISOString(), label, core: game.version,
    config: foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration")) };
  snaps.unshift(snap); await game.settings.set(ID, "snapshots", snaps.slice(0, 10));
  return snap;
}
export async function applyDisable(ids, label) {
  const snap = await saveSnapshot(label);
  const cfg = foundry.utils.deepClone(game.settings.get("core", "moduleConfiguration"));
  for (const id of ids) if (id !== ID) cfg[id] = false;
  await game.settings.set("core", "moduleConfiguration", cfg);
  return snap;
}
export async function restoreSnapshot(snapId) {
  const snap = (get("snapshots") ?? []).find(s => s.id === snapId);
  if (!snap) throw new Error("snapshot not found");
  const cfg = foundry.utils.deepClone(snap.config); cfg[ID] = true;
  await game.settings.set("core", "moduleConfiguration", cfg);
  return snap;
}
async function askReload() {
  const SC = foundry.applications.settings?.SettingsConfig;
  if (SC?.reloadConfirm) return SC.reloadConfirm({ world: true });
  const yes = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Reload.Title") }, content: `<p>${L("Reload.Content")}</p>`, rejectClose: false });
  if (yes) window.location.reload();
}

/* ------------------------------------------------------------------ */
/*  Report application                                                 */
/* ------------------------------------------------------------------ */
const CHECKLIST = ["Backup", "UserData", "ReleaseNotes", "Export", "UpdateModules", "DisableRisky", "TestCopy", "Installer"];
const { ApplicationV2 } = foundry.applications.api;
export class GuardianReport extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "tkug-report", classes: ["tkug-report"], tag: "div",
    window: { title: "TKUG.Title", icon: "fa-solid fa-shield-halved", resizable: true },
    position: { width: 980, height: 720 },
    actions: {
      rescan: GuardianReport.#onRescan, checkUpdates: GuardianReport.#onCheckUpdates, detect: GuardianReport.#onDetect,
      exportMd: GuardianReport.#onExportMd, exportJson: GuardianReport.#onExportJson, copy: GuardianReport.#onCopy,
      disableRisky: GuardianReport.#onDisable, restore: GuardianReport.#onRestore
    }
  };
  report = null; busy = ""; detected = null;
  get title() { return L("Title"); }

  async _prepareContext() {
    if (!this.detected) this.detected = await detectLatestCore({ remote: true });
    if (!this.target) this.target = get("targetVersion") || this.detected.version;
    this.targetSystem ??= get("targetSystemVersion") || "";
    if (!this.report) this.report = await scan({ target: this.target, targetSystem: this.targetSystem });
    return {};
  }
  async _renderHTML() {
    const r = this.report; const showInactive = get("showInactive");
    const badge = s => `<span class="tkug-badge tkug-${s}" data-status="${s}">${esc(L(`Status.${s}`))}</span>`;
    const rows = r.rows.filter(x => showInactive || x.active).map(x => {
      const up = x.update;
      const upHtml = !up ? `<span class="tkug-dim">${esc(L("Update.NotChecked"))}</span>`
        : up.state === "newer" ? `<span class="tkug-update ${up.supportsTarget ? "ok" : "bad"}">${esc(up.version)} ${esc(up.supportsTarget ? L("Update.Supports") : L("Update.NoSupport"))}</span>`
        : up.state === "current" ? `<span class="tkug-dim">${esc(L("Update.Current"))}</span>`
        : `<span class="tkug-dim" title="${esc(up.note)}">${esc(up.state === "none" ? L("Update.NoManifest") : L("Update.Unknown"))}</span>`;
      const notes = [x.target.reason, ...x.issues.map(i => i.text)];
      if (x.deprecations) notes.push(...x.deprecations.samples.map(s => `⚠ ${s}`));
      return `<tr data-id="${esc(x.id)}" data-type="${x.type}" data-status="${x.status}" class="${x.active ? "" : "tkug-inactive"}">
        <td><strong>${esc(x.title)}</strong><br><code>${esc(x.id)}</code>${x.type === "system" ? ` <em>(${esc(L("System"))})</em>` : ""}</td>
        <td>${esc(x.version)}</td><td class="tkug-compat">${esc(fmtCompat(x.compatibility))}</td>
        <td>${badge(x.current.status)}</td><td class="tkug-target-cell">${badge(x.status)}</td>
        <td class="tkug-update-cell">${upHtml}</td>
        <td class="tkug-notes"><ul>${notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></td></tr>`;
    }).join("");
    const checks = get("checklist") ?? {};
    const snaps = get("snapshots") ?? [];
    const risky = problems(r);
    const src = this.detected?.source && this.detected.version === this.target ? L(`Detect.${this.detected.source}`) : L("Detect.manual");
    return `<section class="tkug-body">
      <form class="tkug-controls" autocomplete="off">
        <div class="tkug-field"><label>${esc(L("CurrentCore"))}</label><span class="tkug-core">${esc(game.version)}</span></div>
        <div class="tkug-field"><label for="tkug-target">${esc(L("TargetCore"))}</label>
          <input id="tkug-target" name="target" type="text" value="${esc(this.target)}" placeholder="14.369">
          <button type="button" data-action="detect" title="${esc(L("DetectHint"))}"><i class="fa-solid fa-magnifying-glass"></i> ${esc(L("Detect.Button"))}</button>
          <span class="tkug-dim tkug-detect-source">${esc(src)}</span></div>
        <div class="tkug-field"><label for="tkug-target-system">${esc(L("TargetSystem", { id: game.system.id }))}</label>
          <input id="tkug-target-system" name="targetSystem" type="text" value="${esc(this.targetSystem)}" placeholder="${esc(game.system.version)}"></div>
      </form>
      <div class="tkug-toolbar">
        <button type="button" data-action="rescan"><i class="fa-solid fa-rotate"></i> ${esc(L("Rescan"))}</button>
        <button type="button" data-action="checkUpdates"><i class="fa-solid fa-cloud-arrow-down"></i> ${esc(L("CheckUpdates"))}</button>
        <button type="button" data-action="exportMd"><i class="fa-brands fa-markdown"></i> ${esc(L("ExportMd"))}</button>
        <button type="button" data-action="exportJson"><i class="fa-solid fa-file-code"></i> ${esc(L("ExportJson"))}</button>
        <button type="button" data-action="copy"><i class="fa-solid fa-copy"></i> ${esc(L("Copy"))}</button>
        <label class="tkug-inline"><input type="checkbox" name="showInactive" class="tkug-toggle-inactive" ${showInactive ? "checked" : ""}> ${esc(L("ShowInactive"))}</label>
        <span class="tkug-busy">${esc(this.busy)}</span>
      </div>
      <div class="tkug-summary">${Object.entries(r.counts).map(([s, n]) => `${badge(s)} <span class="tkug-count" data-count="${s}">${n}</span>`).join(" ")}
        <span class="tkug-dim">${esc(L("SummaryHint", { t: r.target }))}</span></div>
      <div class="tkug-table-wrap"><table class="tkug-table"><thead><tr>
        <th>${esc(L("Col.Package"))}</th><th>${esc(L("Col.Version"))}</th><th>${esc(L("Col.Compat"))}</th>
        <th>${esc(L("Col.Current"))}</th><th>${esc(L("Col.Target"))}</th><th>${esc(L("Col.Update"))}</th><th>${esc(L("Col.Notes"))}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <details class="tkug-checklist" open><summary>${esc(L("Checklist.Title"))}</summary>
        <ul>${CHECKLIST.map(k => `<li><label><input type="checkbox" name="check-${k}" data-check="${k}" ${checks[k] ? "checked" : ""}> ${esc(L(`Checklist.${k}`))}</label></li>`).join("")}</ul>
        <div class="tkug-actions">
          <button type="button" data-action="disableRisky" ${risky.length ? "" : "disabled"}><i class="fa-solid fa-power-off"></i> ${esc(L("Disable.Button", { n: risky.length }))}</button>
          <button type="button" data-action="restore" ${snaps.length ? "" : "disabled"}><i class="fa-solid fa-clock-rotate-left"></i> ${esc(L("Restore.Button"))}</button>
          <span class="tkug-dim">${snaps.length ? esc(L("Restore.Latest", { t: new Date(snaps[0].time).toLocaleString() })) : ""}</span>
        </div></details>
    </section>`;
  }
  _replaceHTML(result, content) { content.innerHTML = result; }
  _onRender() {
    const el = this.element;
    el.querySelector("#tkug-target")?.addEventListener("change", ev => { this.target = ev.target.value.trim() || game.version; game.settings.set(ID, "targetVersion", ev.target.value.trim()); this.rescan(); });
    el.querySelector("#tkug-target-system")?.addEventListener("change", ev => { this.targetSystem = ev.target.value.trim(); game.settings.set(ID, "targetSystemVersion", this.targetSystem); this.rescan(); });
    el.querySelector(".tkug-toggle-inactive")?.addEventListener("change", ev => game.settings.set(ID, "showInactive", ev.target.checked).then(() => this.render()));
    el.querySelectorAll("input[data-check]").forEach(cb => cb.addEventListener("change", () => {
      const c = foundry.utils.deepClone(get("checklist") ?? {}); c[cb.dataset.check] = cb.checked; game.settings.set(ID, "checklist", c);
    }));
    el.querySelector("form.tkug-controls")?.addEventListener("submit", ev => ev.preventDefault());
  }
  async rescan({ remote = this.report?.remoteChecked ?? false } = {}) {
    this.busy = remote ? L("Busy.Updates") : L("Busy.Scan");
    if (this.rendered) await this.render();
    this.report = await scan({ target: this.target, targetSystem: this.targetSystem, remote,
      onProgress: (d, n) => { const s = this.element?.querySelector(".tkug-busy"); if (s) s.textContent = `${L("Busy.Updates")} ${d}/${n}`; } });
    this.busy = "";
    if (this.rendered) await this.render();
    return this.report;
  }
  static #onRescan() { return this.rescan(); }
  static #onCheckUpdates() { manifestCache.clear(); return this.rescan({ remote: true }); }
  static async #onDetect() { this.detected = await detectLatestCore({ remote: true }); this.target = this.detected.version; await game.settings.set(ID, "targetVersion", ""); return this.rescan(); }
  static #onExportMd() { foundry.utils.saveDataToFile(toMarkdown(this.report), "text/markdown", `upgrade-guardian-${game.world.id}.md`); }
  static #onExportJson() { foundry.utils.saveDataToFile(JSON.stringify(this.report, null, 2), "application/json", `upgrade-guardian-${game.world.id}.json`); }
  static async #onCopy() {
    try { await game.clipboard.copyPlainText(toMarkdown(this.report)); ui.notifications.info(L("Copied")); }
    catch { ui.notifications.warn(L("CopyFailed")); }
  }
  static async #onDisable() {
    const risky = problems(this.report);
    if (!risky.length) return ui.notifications.info(L("Disable.None"));
    const list = risky.map(r => `<li><label><input type="checkbox" name="${esc(r.id)}" checked> <strong>${esc(r.title)}</strong> <span class="tkug-badge tkug-${r.status}">${esc(L(`Status.${r.status}`))}</span></label></li>`).join("");
    const ids = await foundry.applications.api.DialogV2.wait({
      window: { title: L("Disable.Title") }, classes: ["tkug-disable-dialog"], rejectClose: false,
      content: `<p>${L("Disable.Intro", { t: esc(this.report.target) })}</p><ul class="tkug-propose">${list}</ul><p class="tkug-dim">${L("Disable.Snapshot")}</p>`,
      buttons: [
        { action: "confirm", label: L("Disable.Confirm"), icon: "fa-solid fa-check", default: false,
          callback: (ev, button) => [...button.form.querySelectorAll(".tkug-propose input:checked")].map(i => i.name) },
        { action: "cancel", label: L("Cancel"), icon: "fa-solid fa-xmark", default: true, callback: () => null }
      ]
    });
    if (!Array.isArray(ids) || !ids.length) return;
    await applyDisable(ids, L("Disable.SnapshotLabel", { t: this.report.target }));
    ui.notifications.info(L("Disable.Done", { n: ids.length }));
    await this.render();
    return askReload();
  }
  static async #onRestore() {
    const snap = (get("snapshots") ?? [])[0]; if (!snap) return;
    const yes = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Restore.Title") }, rejectClose: false,
      content: `<p>${L("Restore.Content", { t: esc(new Date(snap.time).toLocaleString()), l: esc(snap.label) })}</p>` });
    if (!yes) return;
    await restoreSnapshot(snap.id); ui.notifications.info(L("Restore.Done"));
    await this.render();
    return askReload();
  }
}

/* ------------------------------------------------------------------ */
/*  Settings, entry points, startup notice                             */
/* ------------------------------------------------------------------ */
class OpenReport extends ApplicationV2 { async render() { open(); return this; } }
let app = null;
export function open() {
  if (!game.user.isGM) { ui.notifications.warn(L("GMOnly")); return null; }
  app ??= new GuardianReport(); app.report = null; app.render({ force: true }); return app;
}

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(ID, key, { name: S(`${key}.Name`), hint: S(`${key}.Hint`), ...data });
  game.settings.registerMenu(ID, "report", { name: S("report.Name"), label: S("report.Label"), hint: S("report.Hint"), icon: "fa-solid fa-shield-halved", type: OpenReport, restricted: true });
  reg("startupNotice", { scope: "world", config: true, type: Boolean, default: true });
  reg("targetVersion", { scope: "world", config: true, type: String, default: "" });
  reg("targetSystemVersion", { scope: "world", config: true, type: String, default: "" });
  reg("releaseApiUrl", { scope: "world", config: true, type: String, default: "" });
  reg("fetchTimeout", { scope: "world", config: true, type: Number, default: 8, range: { min: 2, max: 30, step: 1 } });
  game.settings.register(ID, "showInactive", { scope: "client", config: false, type: Boolean, default: false });
  game.settings.register(ID, "checklist", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(ID, "snapshots", { scope: "world", config: false, type: Array, default: [] });
  game.modules.get(ID).api = { open, scan, evaluate, cmp, detectLatestCore, toMarkdown, problems, applyDisable, restoreSnapshot, saveSnapshot,
    deprecations, STATUS, get app() { return app; } };
});

Hooks.on("renderSettings", (_app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("#tkug-open")) return;
  const btn = document.createElement("button"); btn.type = "button"; btn.id = "tkug-open";
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${esc(L("Open"))}`;
  btn.addEventListener("click", () => open());
  const anchor = root.querySelector("section.settings, #settings-game, section.documentation") ?? root.querySelector("section") ?? root;
  anchor.append(btn);
});

Hooks.once("ready", async () => {
  if (!game.user.isGM || !get("startupNotice")) return;
  try {
    const target = get("targetVersion") || (await detectLatestCore({ remote: false })).version;
    const rep = await scan({ target, targetSystem: get("targetSystemVersion") });
    const bad = problems(rep);
    game.modules.get(ID).api.startup = { target, problems: bad.map(r => r.id) };
    if (bad.length) ui.notifications.warn(L("Startup", { n: bad.length, t: target }), { permanent: false });
  } catch (e) { _warn.call(console, `${ID} | startup scan failed`, e); }
});
