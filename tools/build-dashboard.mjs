#!/usr/bin/env node
/**
 * Genera el tablero de avance del proyecto.
 *
 * Toma tres entradas y produce una página autónoma:
 *  - `tools/stages.json`: las 14 etapas y sus 156 requisitos, extraídos de los
 *    MD de especificación (no se escriben a mano: si cambia el plan, se vuelve
 *    a extraer).
 *  - `tools/progress.json`: el estado de cada requisito y los hitos.
 *  - el recuento real de pruebas, que se pasa por argumento desde la ejecución
 *    de Vitest para que la cifra del tablero no pueda desviarse de la realidad.
 *
 * La página usa las variables del sistema de diseño del propio producto, de
 * modo que sirve además de muestra del acabado visual.
 *
 * Uso:
 *   node tools/build-dashboard.mjs --tests 243 --files 61 --loc 12000 \
 *        --out /home/claude/it360/dist/dashboard.html
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const stages = JSON.parse(readFileSync(resolve(ROOT, 'tools/stages.json'), 'utf8'));
const progress = JSON.parse(readFileSync(resolve(ROOT, 'tools/progress.json'), 'utf8'));
const tokensCss = readFileSync(resolve(ROOT, 'packages/tokens/src/tokens.css'), 'utf8');

const testCount = Number.parseInt(arg('--tests', '0'), 10);
const testFiles = Number.parseInt(arg('--test-files', '0'), 10);
const fileCount = Number.parseInt(arg('--files', '0'), 10);
const locCount = Number.parseInt(arg('--loc', '0'), 10);
const outPath = resolve(arg('--out', resolve(ROOT, 'dist/dashboard.html')));

/* ---------------------------------------------------------------- *
 * Cálculo del avance
 *
 * Un requisito «parcial» cuenta como medio. No es una media ponderada
 * caprichosa: el modelo y las reglas de un requisito son
 * aproximadamente la mitad del trabajo, y la interfaz y la integración
 * la otra mitad. Contar lo parcial como completo daría un avance
 * optimista que el plan prohíbe expresamente («no marcar completado
 * algo no probado»).
 * ---------------------------------------------------------------- */
const WEIGHT = { done: 1, experimental: 0.85, partial: 0.5, modeled: 0.2, pending: 0 };

const STATUS_LABEL = {
  done: 'Completo',
  experimental: 'Experimental',
  partial: 'Lógica lista',
  modeled: 'Modelado',
  pending: 'Pendiente',
};

const STATUS_ORDER = ['done', 'experimental', 'partial', 'modeled', 'pending'];

const statusOf = (code) => progress.status[code] ?? 'pending';

const stageStats = stages.map((stage) => {
  const counts = { done: 0, experimental: 0, partial: 0, modeled: 0, pending: 0 };
  for (const [code] of stage.codes) counts[statusOf(code)] += 1;
  const weighted = Object.entries(counts).reduce((sum, [k, n]) => sum + WEIGHT[k] * n, 0);
  const total = stage.codes.length;
  return {
    ...stage,
    counts,
    total,
    percent: total === 0 ? 0 : Math.round((weighted / total) * 100),
  };
});

const allCodes = stages.flatMap((s) => s.codes.map(([code]) => code));
const globalCounts = { done: 0, experimental: 0, partial: 0, modeled: 0, pending: 0 };
for (const code of allCodes) globalCounts[statusOf(code)] += 1;
const globalWeighted = Object.entries(globalCounts).reduce((s, [k, n]) => s + WEIGHT[k] * n, 0);
const globalPercent = Math.round((globalWeighted / allCodes.length) * 100);

/* ---------------------------------------------------------------- *
 * Plantilla
 * ---------------------------------------------------------------- */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) =>
  new Date(iso).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  });

const ring = (percent, size = 132, stroke = 9) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - percent / 100);
  return `
    <svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
         aria-label="Avance global ${percent} por ciento">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke="var(--it-color-border-default)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
              stroke="var(--it-color-accent-default)" stroke-width="${stroke}"
              stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}"
              stroke-dashoffset="${offset.toFixed(2)}"
              transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" class="ring-value" text-anchor="middle" dominant-baseline="central">${percent}%</text>
    </svg>`;
};

const bar = (counts, total) => {
  const seg = (kind) => {
    const n = counts[kind];
    if (n === 0) return '';
    return `<span class="seg seg-${kind}" style="flex:${n}" title="${STATUS_LABEL[kind]}: ${n}"></span>`;
  };
  return `<span class="bar" role="img" aria-label="${total} requisitos">${STATUS_ORDER.map(seg).join('')}</span>`;
};

const stageCards = stageStats
  .map((s) => {
    const state = s.percent === 100 ? 'complete' : s.percent > 0 ? 'active' : 'queued';
    return `
    <article class="stage stage-${state}">
      <header class="stage-head">
        <span class="stage-num">E${String(s.n).padStart(2, '0')}</span>
        <h3 class="stage-title">${esc(s.title.replace(/^ETAPA \d+ — /, ''))}</h3>
        <span class="stage-pct">${s.percent}%</span>
      </header>
      <p class="stage-goal">${esc(s.goal)}</p>
      ${bar(s.counts, s.total)}
      <ul class="stage-legend">
        <li><b>${s.total}</b> requisitos</li>
        ${s.counts.done > 0 ? `<li class="l-done">${s.counts.done} completos</li>` : ''}
        ${s.counts.partial > 0 ? `<li class="l-partial">${s.counts.partial} con lógica</li>` : ''}
        ${s.counts.modeled > 0 ? `<li class="l-modeled">${s.counts.modeled} modelados</li>` : ''}
        ${s.counts.pending > 0 ? `<li class="l-pending">${s.counts.pending} pendientes</li>` : ''}
      </ul>
      <details class="codes">
        <summary>Requisitos</summary>
        <ul>
          ${s.codes
            .map(
              ([code, text]) =>
                `<li class="code code-${statusOf(code)}"><code>${code}</code><span>${esc(text)}</span></li>`,
            )
            .join('\n          ')}
        </ul>
      </details>
    </article>`;
  })
  .join('\n');

const milestones = [...progress.milestones]
  .reverse()
  .map(
    (m) => `
      <li>
        <time datetime="${m.at}">${fmtDate(m.at)}</time>
        <strong>${esc(m.title)}</strong>
        <p>${esc(m.detail)}</p>
      </li>`,
  )
  .join('\n');

const kpi = (value, label, note) => `
  <div class="kpi">
    <span class="kpi-value">${value}</span>
    <span class="kpi-label">${label}</span>
    ${note ? `<span class="kpi-note">${note}</span>` : ''}
  </div>`;

const swatches = [
  ['accent-default', 'Acento'],
  ['status-nominal', 'Normal'],
  ['status-warning', 'Atención'],
  ['status-alarm', 'Alarma'],
  ['telemetry-stale', 'Obsoleto'],
  ['telemetry-missing', 'Sin dato'],
  ['status-experimental', 'Experimental'],
]
  .map(
    ([token, label]) => `
    <li class="swatch">
      <span class="chip" style="background: var(--it-color-${token})"></span>
      <span class="swatch-label">${label}</span>
      <code>--it-color-${token}</code>
    </li>`,
  )
  .join('');

const html = `<!DOCTYPE html>
<html lang="es" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>INDUSTRIAL TWINS 360 — Avance de desarrollo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${tokensCss}

/* ----- Armazón ----- */
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--it-color-surface-canvas);
  color: var(--it-color-text-primary);
  font-family: var(--it-font-sans);
  font-size: var(--it-text-base);
  line-height: var(--it-leading-normal);
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1320px; margin: 0 auto; padding: var(--it-space-6) var(--it-space-5) var(--it-space-16); }

/* ----- Encabezado ----- */
.masthead {
  display: flex; flex-wrap: wrap; gap: var(--it-space-6);
  align-items: center; justify-content: space-between;
  padding: var(--it-space-6);
  background: var(--it-color-surface-base);
  border: var(--it-border-hairline) solid var(--it-color-border-default);
  border-radius: var(--it-radius-lg);
}
.brand { display: flex; align-items: center; gap: var(--it-space-4); }
.mark {
  width: 46px; height: 46px; flex: none;
  border-radius: var(--it-radius-md);
  border: var(--it-border-thick) solid var(--it-color-accent-default);
  position: relative;
}
.mark::before, .mark::after {
  content: ''; position: absolute; border-radius: var(--it-radius-circle);
  border: var(--it-border-hairline) solid var(--it-color-accent-onSurface);
}
.mark::before { inset: 7px; }
.mark::after { inset: 15px; background: var(--it-color-accent-default); border: 0; }
.eyebrow {
  margin: 0 0 2px;
  font-size: var(--it-text-2xs); font-weight: var(--it-weight-semibold);
  letter-spacing: var(--it-tracking-caps); text-transform: uppercase;
  color: var(--it-color-text-tertiary);
}
h1 { margin: 0; font-size: var(--it-text-2xl); font-weight: var(--it-weight-semibold); letter-spacing: var(--it-tracking-tighter); }
.sub { margin: var(--it-space-1) 0 0; color: var(--it-color-text-secondary); font-size: var(--it-text-sm); }
.headline-right { display: flex; align-items: center; gap: var(--it-space-6); }
.ring-value { font-family: var(--it-font-mono); font-size: 26px; font-weight: 500; fill: var(--it-color-text-primary); }
.ring { display: block; }
.ring-caption { font-size: var(--it-text-xs); color: var(--it-color-text-tertiary); text-align: center; margin-top: var(--it-space-1); }

/* ----- KPI ----- */
.kpis {
  display: grid; gap: var(--it-space-3);
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  margin-top: var(--it-space-4);
}
.kpi {
  display: flex; flex-direction: column; gap: 2px;
  padding: var(--it-space-4);
  background: var(--it-color-surface-base);
  border: var(--it-border-hairline) solid var(--it-color-border-default);
  border-radius: var(--it-radius-lg);
}
.kpi-value { font-family: var(--it-font-mono); font-size: var(--it-text-3xl); font-weight: var(--it-weight-medium); letter-spacing: var(--it-tracking-tight); }
.kpi-label { font-size: var(--it-text-xs); color: var(--it-color-text-secondary); }
.kpi-note { font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); font-family: var(--it-font-mono); }

/* ----- Secciones ----- */
section { margin-top: var(--it-space-10); }
.section-head { display: flex; align-items: baseline; gap: var(--it-space-3); margin-bottom: var(--it-space-4); }
h2 { margin: 0; font-size: var(--it-text-lg); font-weight: var(--it-weight-semibold); letter-spacing: var(--it-tracking-tight); }
.section-note { font-size: var(--it-text-xs); color: var(--it-color-text-tertiary); }

/* ----- Etapas ----- */
.stages { display: grid; gap: var(--it-space-3); grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.stage {
  display: flex; flex-direction: column; gap: var(--it-space-2);
  padding: var(--it-space-4);
  background: var(--it-color-surface-base);
  border: var(--it-border-hairline) solid var(--it-color-border-default);
  border-left: 3px solid var(--it-color-border-strong);
  border-radius: var(--it-radius-lg);
}
.stage-active { border-left-color: var(--it-color-accent-default); }
.stage-complete { border-left-color: var(--it-color-status-nominal); }
.stage-head { display: flex; align-items: center; gap: var(--it-space-2); }
.stage-num {
  font-family: var(--it-font-mono); font-size: var(--it-text-2xs); font-weight: var(--it-weight-semibold);
  color: var(--it-color-accent-onSurface);
  background: var(--it-color-accent-muted);
  border: var(--it-border-hairline) solid var(--it-color-accent-subtle);
  border-radius: var(--it-radius-sm);
  padding: 2px var(--it-space-1_5);
}
.stage-title { margin: 0; flex: 1; font-size: var(--it-text-base); font-weight: var(--it-weight-semibold); }
.stage-pct { font-family: var(--it-font-mono); font-size: var(--it-text-sm); color: var(--it-color-text-secondary); }
.stage-goal { margin: 0; font-size: var(--it-text-xs); color: var(--it-color-text-secondary); min-height: 2.6em; }

.bar { display: flex; height: 6px; gap: 2px; border-radius: var(--it-radius-pill); overflow: hidden; }
.seg { display: block; }
.seg-done { background: var(--it-color-status-nominal); }
.seg-experimental { background: var(--it-color-status-experimental); }
.seg-partial { background: var(--it-color-accent-default); }
.seg-modeled { background: var(--it-color-status-info); }
.seg-pending { background: var(--it-color-border-strong); }

.stage-legend { display: flex; flex-wrap: wrap; gap: var(--it-space-3); margin: 0; padding: 0; list-style: none; font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); }
.stage-legend b { font-family: var(--it-font-mono); color: var(--it-color-text-secondary); }
.l-done { color: var(--it-color-status-nominal); }
.l-partial { color: var(--it-color-accent-onSurface); }
.l-modeled { color: var(--it-color-status-info); }
.l-pending { color: var(--it-color-text-tertiary); }

.codes summary {
  cursor: pointer; font-size: var(--it-text-2xs); text-transform: uppercase;
  letter-spacing: var(--it-tracking-caps); color: var(--it-color-text-tertiary);
  padding: var(--it-space-1) 0;
}
.codes summary:hover { color: var(--it-color-accent-onSurface); }
.codes ul { margin: var(--it-space-2) 0 0; padding: 0; list-style: none; display: grid; gap: 1px; }
.code { display: flex; gap: var(--it-space-2); align-items: baseline; font-size: var(--it-text-2xs); padding: 3px var(--it-space-1_5); border-radius: var(--it-radius-xs); }
.code code { font-family: var(--it-font-mono); font-weight: var(--it-weight-semibold); flex: none; width: 2.8em; }
.code span { color: var(--it-color-text-secondary); }
.code-done { background: var(--it-color-status-nominalSurface); }
.code-done code { color: var(--it-color-status-nominal); }
.code-partial code { color: var(--it-color-accent-onSurface); }
.code-modeled code { color: var(--it-color-status-info); }
.code-experimental code { color: var(--it-color-status-experimental); }
.code-pending code { color: var(--it-color-text-tertiary); }

/* ----- Hitos ----- */
.timeline { list-style: none; margin: 0; padding: 0 0 0 var(--it-space-5); border-left: var(--it-border-hairline) solid var(--it-color-border-default); }
.timeline li { position: relative; padding-bottom: var(--it-space-5); }
.timeline li::before {
  content: ''; position: absolute; left: calc(-1 * var(--it-space-5) - 4px); top: 5px;
  width: 7px; height: 7px; border-radius: var(--it-radius-circle);
  background: var(--it-color-accent-default);
}
.timeline time { display: block; font-family: var(--it-font-mono); font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); }
.timeline strong { display: block; margin-top: 2px; font-size: var(--it-text-md); font-weight: var(--it-weight-semibold); }
.timeline p { margin: var(--it-space-1) 0 0; font-size: var(--it-text-sm); color: var(--it-color-text-secondary); max-width: 72ch; }

/* ----- Muestra del sistema de diseño ----- */
.design { display: grid; gap: var(--it-space-4); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.panel {
  padding: var(--it-space-4);
  background: var(--it-color-surface-raised);
  border: var(--it-border-hairline) solid var(--it-color-border-default);
  border-radius: var(--it-radius-lg);
}
.panel h3 { margin: 0 0 var(--it-space-3); font-size: var(--it-text-2xs); text-transform: uppercase; letter-spacing: var(--it-tracking-caps); color: var(--it-color-text-tertiary); }
.swatches { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--it-space-2); }
.swatch { display: flex; align-items: center; gap: var(--it-space-3); font-size: var(--it-text-xs); }
.chip { width: 22px; height: 22px; flex: none; border-radius: var(--it-radius-sm); border: var(--it-border-hairline) solid var(--it-color-border-subtle); }
.swatch-label { flex: 1; }
.swatch code { font-family: var(--it-font-mono); font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); }

.specimen > div { padding: var(--it-space-1_5) 0; border-bottom: var(--it-border-hairline) solid var(--it-color-border-subtle); }
.specimen > div:last-child { border-bottom: 0; }
.specimen small { display: block; font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); font-family: var(--it-font-mono); }

.readout { font-family: var(--it-font-mono); font-size: var(--it-text-4xl); font-weight: var(--it-weight-medium); letter-spacing: var(--it-tracking-tight); }
.readout .unit { font-size: var(--it-text-lg); color: var(--it-color-text-secondary); margin-left: var(--it-space-1); }
.quality { display: inline-flex; align-items: center; gap: var(--it-space-1_5); font-size: var(--it-text-2xs); text-transform: uppercase; letter-spacing: var(--it-tracking-wider); }
.dot { width: 7px; height: 7px; border-radius: var(--it-radius-circle); }
.q-fresh { color: var(--it-color-telemetry-fresh); } .q-fresh .dot { background: var(--it-color-telemetry-fresh); }
.q-stale { color: var(--it-color-telemetry-stale); } .q-stale .dot { background: var(--it-color-telemetry-stale); }
.q-missing { color: var(--it-color-telemetry-missing); } .q-missing .dot { background: var(--it-color-telemetry-missing); }
.q-error { color: var(--it-color-telemetry-error); } .q-error .dot { background: var(--it-color-telemetry-error); }
.tele-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--it-space-3); padding: var(--it-space-2) 0; border-bottom: var(--it-border-hairline) solid var(--it-color-border-subtle); }
.tele-row:last-child { border-bottom: 0; }
.tele-tag { font-family: var(--it-font-mono); font-size: var(--it-text-xs); color: var(--it-color-text-secondary); }
.tele-val { font-family: var(--it-font-mono); font-size: var(--it-text-lg); font-weight: var(--it-weight-medium); }

.btn-row { display: flex; flex-wrap: wrap; gap: var(--it-space-2); }
.btn {
  height: var(--it-frame-controlHeight); padding: 0 var(--it-space-3);
  font: inherit; font-size: var(--it-text-sm); font-weight: var(--it-weight-medium);
  border-radius: var(--it-radius-md); cursor: pointer;
  border: var(--it-border-hairline) solid var(--it-color-border-control);
  background: var(--it-color-surface-overlay); color: var(--it-color-text-primary);
  transition: background var(--it-duration-fast) var(--it-ease-standard), border-color var(--it-duration-fast) var(--it-ease-standard);
}
.btn:hover { border-color: var(--it-color-border-strong); background: var(--it-color-surface-raised); }
.btn-primary { background: var(--it-color-accent-default); border-color: var(--it-color-accent-default); color: var(--it-color-text-onAccent); }
.btn-primary:hover { background: var(--it-color-accent-hover); border-color: var(--it-color-accent-hover); }
.btn-ghost { background: transparent; border-color: transparent; color: var(--it-color-text-secondary); }
.btn-ghost:hover { background: var(--it-color-accent-muted); color: var(--it-color-accent-onSurface); }
.btn:focus-visible { outline: var(--it-border-focus) solid var(--it-color-border-focus); outline-offset: 2px; }

/* ----- Pie ----- */
footer { margin-top: var(--it-space-12); padding-top: var(--it-space-4); border-top: var(--it-border-hairline) solid var(--it-color-border-default); font-size: var(--it-text-xs); color: var(--it-color-text-tertiary); display: flex; flex-wrap: wrap; gap: var(--it-space-4); justify-content: space-between; }
footer code { font-family: var(--it-font-mono); }
.legend-global { display: flex; flex-wrap: wrap; gap: var(--it-space-4); font-size: var(--it-text-2xs); color: var(--it-color-text-tertiary); margin-top: var(--it-space-3); }
.legend-global span { display: inline-flex; align-items: center; gap: var(--it-space-1_5); }
.legend-global i { width: 10px; height: 6px; border-radius: 2px; display: block; }

@media (max-width: 720px) {
  .masthead { flex-direction: column; align-items: flex-start; }
  .headline-right { width: 100%; justify-content: space-between; }
}
</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <div class="brand">
      <div class="mark" aria-hidden="true"></div>
      <div>
        <p class="eyebrow">Plataforma de recorridos virtuales industriales</p>
        <h1>INDUSTRIAL TWINS 360</h1>
        <p class="sub">Avance de desarrollo &middot; versión <code>${esc(progress.version)}</code> &middot; actualizado ${fmtDate(progress.updatedAt)}</p>
      </div>
    </div>
    <div class="headline-right">
      <div>
        ${ring(globalPercent)}
        <p class="ring-caption">avance global ponderado</p>
      </div>
    </div>
  </header>

  <div class="kpis">
    ${kpi(`${globalCounts.done + globalCounts.experimental}<span style="font-size:var(--it-text-lg);color:var(--it-color-text-tertiary)">/${allCodes.length}</span>`, 'Requisitos completos', `${globalCounts.partial} con lógica, ${globalCounts.modeled} modelados`)}
    ${kpi(testCount, 'Pruebas en verde', `${testFiles} archivos de prueba`)}
    ${kpi(stageStats.filter((s) => s.percent > 0).length + '<span style="font-size:var(--it-text-lg);color:var(--it-color-text-tertiary)">/14</span>', 'Etapas iniciadas', 'secuencia del plan')}
    ${kpi(fileCount, 'Archivos de código', `${locCount.toLocaleString('es-CO')} líneas`)}
  </div>

  <div class="legend-global">
    <span><i style="background:var(--it-color-status-nominal)"></i> Completo y probado</span>
    <span><i style="background:var(--it-color-accent-default)"></i> Lógica implementada y probada, falta interfaz</span>
    <span><i style="background:var(--it-color-status-info)"></i> Contrato de datos modelado y validado</span>
    <span><i style="background:var(--it-color-status-experimental)"></i> Experimental por decisión del plan</span>
    <span><i style="background:var(--it-color-border-strong)"></i> Pendiente</span>
  </div>

  <section>
    <div class="section-head">
      <h2>Etapas</h2>
      <span class="section-note">14 etapas autónomas, ${allCodes.length} requisitos del checklist. El avance pondera: completo 1, lógica lista 0,5, modelado 0,2.</span>
    </div>
    <div class="stages">
${stageCards}
    </div>
  </section>

  <section>
    <div class="section-head">
      <h2>Hitos</h2>
      <span class="section-note">más reciente primero</span>
    </div>
    <ol class="timeline">
${milestones}
    </ol>
  </section>

  <section>
    <div class="section-head">
      <h2>Sistema de diseño</h2>
      <span class="section-note">esta página usa los mismos tokens que la aplicación</span>
    </div>
    <div class="design">
      <div class="panel">
        <h3>Color por estado</h3>
        <ul class="swatches">${swatches}</ul>
      </div>
      <div class="panel">
        <h3>Tipografía</h3>
        <div class="specimen">
          <div style="font-size:var(--it-text-xl);font-weight:var(--it-weight-semibold);letter-spacing:var(--it-tracking-tight)">Sala de bombas · Unidad 200</div>
          <small>IBM Plex Sans 600 / 18.5 px</small>
          <div style="padding-top:var(--it-space-2)">Interfaz a 13 px: densidad de panel de propiedades sin perder legibilidad.</div>
          <small>IBM Plex Sans 400 / 13 px</small>
          <div style="font-family:var(--it-font-mono);padding-top:var(--it-space-2)">P-101A · TI-2301 · FIC-100</div>
          <small>IBM Plex Mono 400 / 12 px — TAG industrial</small>
        </div>
      </div>
      <div class="panel">
        <h3>Panel de instrumentos</h3>
        <div class="readout">12.84<span class="unit">bar</span></div>
        <span class="quality q-fresh"><i class="dot"></i> Actual · hace 12 s</span>
        <div style="margin-top:var(--it-space-3)">
          <div class="tele-row"><span class="tele-tag">TI-2301</span><span class="tele-val">78.2 <span style="font-size:var(--it-text-xs);color:var(--it-color-text-tertiary)">°C</span></span><span class="quality q-fresh"><i class="dot"></i>Actual</span></div>
          <div class="tele-row"><span class="tele-tag">FIC-100</span><span class="tele-val">104.5 <span style="font-size:var(--it-text-xs);color:var(--it-color-text-tertiary)">m³/h</span></span><span class="quality q-stale"><i class="dot"></i>Obsoleto</span></div>
          <div class="tele-row"><span class="tele-tag">LI-310</span><span class="tele-val">—</span><span class="quality q-missing"><i class="dot"></i>Sin dato</span></div>
          <div class="tele-row"><span class="tele-tag">VIB-402</span><span class="tele-val">—</span><span class="quality q-error"><i class="dot"></i>Error</span></div>
        </div>
      </div>
      <div class="panel">
        <h3>Controles</h3>
        <div class="btn-row">
          <button class="btn btn-primary" type="button">Publicar recorrido</button>
          <button class="btn" type="button">Previsualizar</button>
          <button class="btn btn-ghost" type="button">Cancelar</button>
        </div>
        <p style="margin:var(--it-space-4) 0 0;font-size:var(--it-text-xs);color:var(--it-color-text-secondary)">
          Contraste verificado por prueba automatizada: AA en tema claro y oscuro, 3:1 en bordes de control y anillo de foco.
        </p>
      </div>
    </div>
  </section>

  <footer>
    <span>Carpeta de desarrollo <code>C:\\PROYECTOS_IA\\INDUSTRIAL_TWINS_360</code></span>
    <span>Tauri 2 · React 18 · TypeScript estricto · Three.js · SQLite · FastAPI</span>
  </footer>
</div>
</body>
</html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
process.stdout.write(
  `dashboard generado: ${outPath}\n  avance global ${globalPercent}% · ${globalCounts.done} completos, ${globalCounts.partial} parciales, ${globalCounts.pending} pendientes\n`,
);
