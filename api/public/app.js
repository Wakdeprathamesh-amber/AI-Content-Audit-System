/* Content QC Dashboard — media + text audit UI */

const TH = {
  minW: 800,
  minH: 800,
  blur: 100,
  sharp: 50,
  wmConf: 85,
  catConf: 70,
};

let appConfig = { spreadsheetUrl: null };
let currentAuditResult = null;
let imageAnalysisCache = [];
let activeFilter = 'all';
let searchQuery = '';
let selectedScope = 'both';
let activeTab = 'overview';

async function loadPublicConfig() {
  try {
    const res = await fetch('/api/public-config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg?.thresholds) {
      TH.minW = Number(cfg.thresholds.minW ?? TH.minW);
      TH.minH = Number(cfg.thresholds.minH ?? TH.minH);
      TH.blur = Number(cfg.thresholds.blur ?? TH.blur);
      TH.sharp = Number(cfg.thresholds.sharp ?? TH.sharp);
      TH.wmConf = Number(cfg.thresholds.wmConf ?? TH.wmConf);
      TH.catConf = Number(cfg.thresholds.catConf ?? TH.catConf);
    }
    if (cfg?.spreadsheetUrl) appConfig.spreadsheetUrl = cfg.spreadsheetUrl;
  } catch {
    /* defaults */
  }
}

async function loadHealth() {
  const dbEl = document.getElementById('healthDb');
  const imgEl = document.getElementById('healthImage');
  if (!dbEl || !imgEl) return;
  try {
    const res = await fetch('/health');
    const data = await res.json();
    const dbOk = data.checks?.database === 'connected';
    const imgOk = data.checks?.imageModule === 'connected';
    dbEl.innerHTML = `<span class="dot ${dbOk ? 'ok' : 'bad'}"></span>Database`;
    imgEl.innerHTML = `<span class="dot ${imgOk ? 'ok' : 'warn'}"></span>Image module`;
  } catch {
    dbEl.innerHTML = '<span class="dot bad"></span>Database';
    imgEl.innerHTML = '<span class="dot bad"></span>Image module';
  }
}

function initScopeCards() {
  document.querySelectorAll('.scope-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedScope = card.dataset.scope;
      document.querySelectorAll('.scope-card').forEach((c) => c.classList.toggle('selected', c === card));
      document.getElementById('auditType').value = selectedScope;
      updateCheckVisibility();
    });
  });
  updateCheckVisibility();
}

function updateCheckVisibility() {
  const scope = document.getElementById('auditType')?.value || selectedScope;
  document.getElementById('mediaChecks')?.classList.toggle('hidden', scope === 'text');
  document.getElementById('textChecks')?.classList.toggle('hidden', scope === 'media');
}

let tabsBound = false;
function initTabs() {
  if (tabsBound) return;
  tabsBound = true;
  document.getElementById('resultTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('#resultTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `panel-${activeTab}`);
    });
  });
}

document.getElementById('auditType')?.addEventListener('change', (e) => {
  selectedScope = e.target.value;
  document.querySelectorAll('.scope-card').forEach((c) => {
    c.classList.toggle('selected', c.dataset.scope === selectedScope);
  });
  updateCheckVisibility();
});

document.getElementById('auditForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const propertyId = document.getElementById('propertyId').value.trim();
  const auditType = document.getElementById('auditType').value;
  const checks = Array.from(document.querySelectorAll('input[name="checks"]:checked')).map((cb) => cb.value);
  const textChecks = Array.from(document.querySelectorAll('input[name="textChecks"]:checked')).map((cb) => cb.value);

  if (!propertyId) {
    showAlert('error', 'Enter a property ID');
    return;
  }
  if ((auditType === 'media' || auditType === 'both') && !checks.length) {
    showAlert('error', 'Select at least one media check');
    return;
  }
  if ((auditType === 'text' || auditType === 'both') && !textChecks.length) {
    showAlert('error', 'Select at least one text check');
    return;
  }

  document.getElementById('loading').classList.add('active');
  document.getElementById('results').classList.remove('active');
  document.getElementById('alertError').classList.remove('active');
  document.getElementById('alertSuccess').classList.remove('active');
  document.getElementById('submitBtn').disabled = true;

  try {
    const res = await fetch('/api/v1/audits/single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId, auditType, checks, textChecks }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || err.error || 'Audit failed');
    }
    const data = await res.json();
    currentAuditResult = data.audit || data;
    document.getElementById('loading').classList.remove('active');
    displayResults(currentAuditResult);
    showAlert('success', `Audit complete — score ${currentAuditResult.qualityScore}/100`);
  } catch (err) {
    document.getElementById('loading').classList.remove('active');
    showAlert('error', err.message || 'Audit failed');
  } finally {
    document.getElementById('submitBtn').disabled = false;
  }
});

function analyzeImage(img) {
  const q = img.quality || {};
  const w = q.width ?? q.resolution?.width ?? 0;
  const h = q.height ?? q.resolution?.height ?? 0;
  const resOK = w >= TH.minW && h >= TH.minH;
  const blurOK = (q.blur ?? 0) >= TH.blur;
  const sharpOK = (q.sharpness ?? 0) >= TH.sharp;
  const wm = !!(img.watermark?.detected && (img.watermark.confidence ?? 0) >= TH.wmConf);
  const cat = img.category;
  const tagged = !!(cat && (cat.confidence ?? 0) >= TH.catConf);
  const tagWrong = cat?.is_tag_correct === false;
  const dup = !!img.isDuplicate;
  const featured = img.upstream?.isFeatured === true;

  let status = 'pass';
  if (wm || !resOK) status = 'fail';
  else if (!blurOK || !sharpOK || dup || tagWrong) status = 'warn';

  return {
    resOK,
    blurOK,
    sharpOK,
    wm,
    tagged,
    tagWrong,
    dup,
    featured,
    status,
    w,
    h,
    blur: q.blur,
    sharpness: q.sharpness,
    format: q.format,
    megapixels: q.megapixels,
    category: cat?.primary || img.upstream?.tag || '—',
    upstreamTag: img.upstream?.tag,
    isTagCorrect: cat?.is_tag_correct,
    suggested: cat?.suggested_correction,
    wmText: img.watermark?.text,
    wmConf: img.watermark?.confidence,
    catConf: cat?.confidence,
    dupOf: img.duplicateOf,
    similarity: img.similarity,
    level: img.sourceLevel || 'property',
    configName: img.configName || '',
    sourceId: img.sourceInventoryId || '',
    catReason: cat?.reasoning,
    wmReason: img.watermark?.reasoning,
  };
}

function computeMediaMetrics(result) {
  const images = result.imageResults || [];
  const analyzed = images.map((img) => ({ img, a: analyzeImage(img) }));
  const m = {
    total: images.length,
    passed: 0,
    failed: 0,
    warned: 0,
    duplicates: 0,
    watermarks: 0,
    blurry: 0,
    resolutionFail: 0,
    tagWrong: 0,
    propertyLevel: 0,
    configLevel: 0,
    critical: result.summary?.criticalIssues ?? 0,
    warnings: result.summary?.warnings ?? 0,
  };
  analyzed.forEach(({ a }) => {
    if (a.status === 'pass') m.passed++;
    else if (a.status === 'fail') m.failed++;
    else m.warned++;
    if (a.dup) m.duplicates++;
    if (a.wm) m.watermarks++;
    if (!a.blurOK) m.blurry++;
    if (!a.resOK) m.resolutionFail++;
    if (a.tagWrong) m.tagWrong++;
    if (a.level === 'property') m.propertyLevel++;
    else m.configLevel++;
  });
  return { ...m, analyzed };
}

function scoreClass(score) {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

function heroBannerClass(action) {
  if (action === 'featured_not_bedroom' || action === 'no_bedroom' || action === 'no_images') return 'critical';
  if (action === 'swap') return 'warning';
  return 'ok';
}

function heroActionLabel(action) {
  const map = {
    ok: 'Hero image OK',
    swap: 'Better bedroom available — swap recommended',
    featured_not_bedroom: 'Featured image is not a bedroom — fix required',
    no_bedroom: 'No bedroom image in gallery',
    no_images: 'No images in gallery',
  };
  return map[action] || action;
}

function findImageResultById(imageId) {
  if (!imageId || !currentAuditResult?.imageResults) return null;
  return currentAuditResult.imageResults.find((img) => img.imageId === imageId) || null;
}

function renderHeroImageCard(title, imageId, imageUrl, opts = {}) {
  if (!imageId && !imageUrl) {
    return `
      <div class="hero-image-card">
        <div class="hero-image-title">${esc(title)}</div>
        <div class="hero-image-empty">No image available</div>
      </div>`;
  }

  const img = findImageResultById(imageId);
  const aiCategory = img?.category?.primary || '—';
  const upstreamCategory = img?.upstream?.tag || '—';
  const source = opts.source || '—';

  return `
    <div class="hero-image-card">
      <div class="hero-image-title">${esc(title)}</div>
      <a href="${esc(imageUrl || '#')}" target="_blank" rel="noopener" class="hero-thumb-link">
        <img class="hero-thumb" src="${esc(imageUrl || '')}" alt="${esc(title)}" loading="lazy">
      </a>
      <div class="hero-image-meta">
        <div><strong>ID:</strong> <code>${esc(imageId || '—')}</code></div>
        <div><strong>Source:</strong> ${esc(source)}</div>
        <div><strong>Upstream tag (hero rule):</strong> ${esc(upstreamCategory)}</div>
        <div><strong>AI category (media row):</strong> ${esc(aiCategory)}</div>
      </div>
      <div class="hero-image-actions">
        <a class="meta-link" href="${esc(imageUrl || '#')}" target="_blank" rel="noopener">Open image</a>
      </div>
    </div>`;
}

function renderHeroComparison(hero) {
  if (!hero) return '';

  const categoryMismatchNote =
    hero.action === 'featured_not_bedroom'
      ? `<div class="hero-note">Hero rule uses <strong>upstream featured tag</strong>, while Media list shows <strong>AI category</strong>. If these differ, review both before deciding.</div>`
      : '';

  const swapHint =
    hero.action === 'swap' || hero.action === 'featured_not_bedroom'
      ? `<div class="hero-swap-arrow">Swap current → recommended</div>`
      : '';

  return `
    <div class="hero-comparison">
      <div class="hero-comparison-head">
        <strong>${esc(heroActionLabel(hero.action))}</strong>
        ${hero.reason ? `<div class="hero-comparison-reason">${esc(hero.reason)}</div>` : ''}
      </div>
      ${categoryMismatchNote}
      <div class="hero-comparison-grid">
        ${renderHeroImageCard(
          'Current featured image',
          hero.currentHeroImageId,
          hero.currentHeroUrl,
          { source: hero.currentHeroSource }
        )}
        ${swapHint}
        ${renderHeroImageCard(
          `Recommended bedroom ${hero.recommendedHeroScore != null ? `(score ${hero.recommendedHeroScore}/100)` : ''}`,
          hero.recommendedHeroImageId,
          hero.recommendedHeroUrl
        )}
      </div>
    </div>`;
}

function configActionBadge(action) {
  if (action === 'ok') return 'verified';
  if (action === 'swap') return 'missing_evidence';
  return 'conflict';
}

function renderConfigHeroCards(configs) {
  if (!configs?.length) return '';
  return `
    <div class="config-hero-cards">
      ${configs
        .map(
          (c) => `
        <div class="config-hero-card">
          <div class="config-hero-top">
            <div class="config-name">${esc(c.configName)}</div>
            <span class="status-badge ${configActionBadge(c.action)}">${esc(c.action)}</span>
          </div>
          <div class="config-hero-reason">${esc(c.reason || '')}</div>
          <div class="config-hero-grid">
            ${renderHeroImageCard('Current', c.currentHeroImageId, c.currentHeroUrl, { source: c.currentHeroSource })}
            ${renderHeroImageCard(
              `Recommended${c.recommendedHeroScore != null ? ` (${c.recommendedHeroScore}/100)` : ''}`,
              c.recommendedHeroImageId,
              c.recommendedHeroUrl
            )}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

function displayResults(result) {
  document.getElementById('results').classList.add('active');
  activeFilter = 'all';
  searchQuery = '';
  const searchEl = document.getElementById('imageSearch');
  if (searchEl) searchEl.value = '';

  const auditType = result.auditType || 'media';
  const hasMedia = auditType === 'media' || auditType === 'both';
  const hasText = auditType === 'text' || auditType === 'both';

  configureResultTabs(hasMedia, hasText);
  renderOverview(result, hasMedia, hasText);
  if (hasMedia) {
    const metrics = computeMediaMetrics(result);
    imageAnalysisCache = metrics.analyzed;
    renderMediaKpis(metrics);
    renderFilters(metrics);
    renderImageList();
  } else {
    imageAnalysisCache = [];
    document.getElementById('kpiGrid').innerHTML = '';
    document.getElementById('imageList').innerHTML = '';
  }
  if (hasText) renderTextPanel(result);
  renderAllIssues(result, hasMedia, hasText);

  const sheetsLink = document.getElementById('sheetsLink');
  if (sheetsLink) {
    if (appConfig.spreadsheetUrl) {
      sheetsLink.href = appConfig.spreadsheetUrl;
      sheetsLink.classList.remove('hidden');
    } else {
      sheetsLink.classList.add('hidden');
    }
  }

  document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
}

function configureResultTabs(hasMedia, hasText) {
  const tabs = [
    { id: 'overview', label: 'Overview', show: true },
    { id: 'media', label: 'Media', show: hasMedia },
    { id: 'text', label: 'Text', show: hasText },
    { id: 'issues', label: 'Issues', show: true },
  ];
  document.getElementById('resultTabs').innerHTML = tabs
    .filter((t) => t.show)
    .map(
      (t, i) =>
        `<button type="button" class="tab ${i === 0 ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`
    )
    .join('');

  ['overview', 'media', 'text', 'issues'].forEach((id) => {
    const panel = document.getElementById(`panel-${id}`);
    if (!panel) return;
    const show = tabs.find((t) => t.id === id)?.show;
    panel.classList.toggle('hidden', !show);
    panel.classList.toggle('active', id === 'overview' && show);
  });

  activeTab = 'overview';
  initTabs();
  document.querySelectorAll('#resultTabs .tab').forEach((t, i) => {
    t.classList.toggle('active', i === 0);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'panel-overview' && !p.classList.contains('hidden'));
  });
}

function renderOverview(result, hasMedia, hasText) {
  const score = result.qualityScore ?? 0;
  const breakdown = result.scoreBreakdown;
  const meta = result.propertyMeta || {};
  const hero = result.hero;

  let breakdownHtml = '';
  if (breakdown && (hasMedia && hasText)) {
    breakdownHtml = `
      <div class="score-breakdown">
        <div class="breakdown-row"><span>Media (${Math.round((breakdown.mediaWeight ?? 0.65) * 100)}%)</span><strong>${breakdown.mediaScore ?? '—'}</strong></div>
        <div class="breakdown-row"><span>Text (${Math.round((breakdown.textWeight ?? 0.35) * 100)}%)</span><strong>${breakdown.textScore ?? '—'}</strong></div>
        <div class="breakdown-row"><span>Combined</span><strong>${breakdown.combinedScore ?? score}</strong></div>
      </div>`;
  } else if (hasText && result.textResults) {
    breakdownHtml = `<div class="score-breakdown"><div class="breakdown-row"><span>Text score</span><strong>${result.textResults.summary?.score ?? '—'}</strong></div></div>`;
  } else if (hasMedia && breakdown?.mediaScore != null) {
    breakdownHtml = `<div class="score-breakdown"><div class="breakdown-row"><span>Media score</span><strong>${breakdown.mediaScore}</strong></div></div>`;
  }

  const links = [];
  if (meta.amberUrl) links.push(`<a class="meta-link" href="${esc(meta.amberUrl)}" target="_blank" rel="noopener">Amber listing</a>`);
  if (meta.url) links.push(`<a class="meta-link" href="${esc(meta.url)}" target="_blank" rel="noopener">Source (PMG)</a>`);

  const location = [meta.city, meta.region, meta.country].filter(Boolean).join(', ');

  let heroHtml = '';
  if (hero && hasMedia) {
    heroHtml = `
      <div class="hero-banner ${heroBannerClass(hero.action)}">
        ${renderHeroComparison(hero)}
      </div>`;
  }

  let configHeroesHtml = '';
  const configs = result.configHeroes || [];
  if (configs.length && hasMedia) {
    configHeroesHtml = `
      <div class="config-heroes-table">
        <div class="panel-title" style="margin-top:16px">Config heroes</div>
        ${renderConfigHeroCards(configs)}
      </div>`;
  }

  document.getElementById('overviewContent').innerHTML = `
    <div class="overview-grid">
      <div>
        <h3 style="font-size:20px;font-weight:600;margin-bottom:4px">${esc(result.propertyName)}</h3>
        <p class="sub" style="font-size:13px;color:var(--muted)">
          ID ${esc(result.propertyId)}
          ${location ? ` · ${esc(location)}` : ''}
          · ${new Date(result.timestamp).toLocaleString()}
        </p>
        <div class="meta-links">${links.join('')}</div>
        ${heroHtml}
        ${configHeroesHtml}
      </div>
      <div class="score-card ${scoreClass(score)}">
        <div class="value">${score}</div>
        <div class="label">Quality score</div>
        ${breakdownHtml}
      </div>
    </div>`;
}

function renderMediaKpis(m) {
  const cards = [
    { filter: 'all', label: 'Total', val: m.total, cls: 'neutral' },
    { filter: 'passed', label: 'Passed', val: m.passed, cls: 'pass' },
    { filter: 'failed', label: 'Failed', val: m.failed, cls: 'fail' },
    { filter: 'warned', label: 'Warnings', val: m.warned, cls: 'warn' },
    { filter: 'duplicates', label: 'Duplicates', val: m.duplicates, cls: m.duplicates ? 'warn' : 'neutral' },
    { filter: 'watermarks', label: 'Watermarks', val: m.watermarks, cls: m.watermarks ? 'fail' : 'neutral' },
    { filter: 'blurry', label: 'Blurry', val: m.blurry, cls: m.blurry ? 'warn' : 'neutral' },
    { filter: 'resolution', label: 'Low res', val: m.resolutionFail, cls: m.resolutionFail ? 'fail' : 'neutral' },
    { filter: 'tagWrong', label: 'Wrong tag', val: m.tagWrong, cls: m.tagWrong ? 'warn' : 'neutral' },
    { filter: 'property', label: 'Property', val: m.propertyLevel, cls: 'neutral' },
    { filter: 'config', label: 'Config', val: m.configLevel, cls: 'neutral' },
  ];
  document.getElementById('kpiGrid').innerHTML = cards
    .map(
      (c) => `
    <div class="kpi ${c.cls} clickable ${activeFilter === c.filter ? 'active' : ''}" data-filter="${c.filter}">
      <div class="num">${c.val}</div>
      <div class="lbl">${c.label}</div>
    </div>`
    )
    .join('');

  document.querySelectorAll('#kpiGrid .kpi.clickable').forEach((el) => {
    el.addEventListener('click', () => {
      const f = el.dataset.filter;
      activeFilter = activeFilter === f ? 'all' : f;
      document.querySelectorAll('#kpiGrid .kpi.clickable').forEach((k) => {
        k.classList.toggle('active', k.dataset.filter === activeFilter);
      });
      document.querySelectorAll('.filter-chip').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === activeFilter);
      });
      renderImageList();
    });
  });
}

function renderFilters(m) {
  const chips = [
    { id: 'all', label: `All (${m.total})` },
    { id: 'failed', label: 'Failed' },
    { id: 'warned', label: 'Warnings' },
    { id: 'passed', label: 'Passed' },
    { id: 'property', label: 'Property' },
    { id: 'config', label: 'Config' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'watermarks', label: 'Watermarks' },
  ];
  document.getElementById('filterChips').innerHTML = chips
    .map((c) => `<button type="button" class="filter-chip ${activeFilter === c.id ? 'active' : ''}" data-filter="${c.id}">${c.label}</button>`)
    .join('');

  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-chip').forEach((b) => b.classList.toggle('active', b.dataset.filter === activeFilter));
      document.querySelectorAll('#kpiGrid .kpi.clickable').forEach((k) => k.classList.toggle('active', k.dataset.filter === activeFilter));
      renderImageList();
    });
  });
}

function matchesFilter(a) {
  switch (activeFilter) {
    case 'passed':
      return a.status === 'pass';
    case 'failed':
      return a.status === 'fail';
    case 'warned':
      return a.status === 'warn';
    case 'duplicates':
      return a.dup;
    case 'watermarks':
      return a.wm;
    case 'blurry':
      return !a.blurOK;
    case 'resolution':
      return !a.resOK;
    case 'tagWrong':
      return a.tagWrong;
    case 'property':
      return a.level === 'property';
    case 'config':
      return a.level === 'config';
    default:
      return true;
  }
}

function matchesSearch(img, a) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  const hay = [img.imageId, img.imageUrl, a.configName, a.sourceId, a.category, a.upstreamTag].join(' ').toLowerCase();
  return hay.includes(q);
}

function renderImageList() {
  const list = document.getElementById('imageList');
  const filtered = imageAnalysisCache.filter(({ img, a }) => matchesFilter(a) && matchesSearch(img, a));
  document.getElementById('emptyFilter').style.display = filtered.length ? 'none' : 'block';
  list.innerHTML = filtered.map(({ img, a }) => renderImageRow(img, a)).join('');
  list.querySelectorAll('.image-row-main').forEach((row) => {
    row.addEventListener('click', () => row.closest('.image-row').classList.toggle('expanded'));
  });
}

function renderImageRow(img, a) {
  const border = a.status === 'fail' ? 'fail-border' : a.status === 'warn' ? 'warn-border' : 'pass-border';
  const overallLabel = a.status === 'pass' ? 'PASS' : a.status === 'fail' ? 'FAIL' : 'WARN';
  const pills = [
    pill('Resolution', a.resOK),
    pill('Blur', a.blurOK),
    pill('Sharp', a.sharpOK),
    pill('Watermark', !a.wm),
    pill('Tag', !a.tagWrong && a.tagged, a.tagWrong ? 'warn' : null),
    a.dup ? pill('Duplicate', false, 'fail') : '',
  ].join('');
  const levelTag =
    a.level === 'config'
      ? `<span class="tag config">Config · ${esc(a.configName || a.sourceId)}</span>`
      : `<span class="tag property">Property</span>`;

  return `
    <div class="image-row ${border}">
      <div class="image-row-main">
        <img class="thumb" src="${esc(img.imageUrl)}" alt="" loading="lazy" onerror="this.style.opacity='0.3'">
        <div class="img-info">
          <div class="id-line">${esc(img.imageId)}</div>
          <div class="url-line" title="${esc(img.imageUrl)}">${esc(img.imageUrl)}</div>
          <div class="meta-line">
            ${levelTag}
            <span class="tag category">${esc(a.category)}</span>
            <span class="tag">${a.w}×${a.h}</span>
            ${a.featured ? '<span class="tag">Featured</span>' : ''}
          </div>
        </div>
        <div class="row-status-col" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:flex-end">
          <div class="check-pills">${pills}</div>
          <span class="row-overall ${a.status}">${overallLabel}</span>
        </div>
      </div>
      <div class="image-row-detail">
        <div class="detail-grid">
          <div class="detail-item"><label>Resolution</label><div class="val">${a.w} × ${a.h} px</div></div>
          <div class="detail-item"><label>Blur / sharp</label><div class="val">${fmt(a.blur)} / ${fmt(a.sharpness)}</div></div>
          <div class="detail-item"><label>Watermark</label><div class="val">${a.wm ? esc(a.wmText || 'Detected') : 'None'}</div></div>
          <div class="detail-item"><label>Category</label><div class="val">${esc(a.category)}</div></div>
          <div class="detail-item"><label>Upstream</label><div class="val">${esc(a.upstreamTag || '—')}</div></div>
          ${a.dup ? `<div class="detail-item"><label>Duplicate</label><div class="val">${esc(a.dupOf)}</div></div>` : ''}
        </div>
      </div>
    </div>`;
}

function renderTextPanel(result) {
  const text = result.textResults;
  const container = document.getElementById('textContent');
  if (!text) {
    container.innerHTML = '<div class="empty-state">No text results</div>';
    return;
  }
  const s = text.summary || {};
  const factByClaim = new Map((text.factChecks || []).map((f) => [f.claimId, f]));
  const claims = text.extraction?.claims || [];

  const kpiHtml = `
    <div class="text-kpi-grid">
      <div class="kpi neutral"><div class="num">${s.totalClaims ?? 0}</div><div class="lbl">Claims</div></div>
      <div class="kpi pass"><div class="num">${s.verifiedClaims ?? 0}</div><div class="lbl">Verified</div></div>
      <div class="kpi fail"><div class="num">${s.conflictingClaims ?? 0}</div><div class="lbl">Conflicts</div></div>
      <div class="kpi warn"><div class="num">${s.missingEvidenceClaims ?? 0}</div><div class="lbl">Unverified</div></div>
      <div class="kpi"><div class="num">${s.score ?? 0}</div><div class="lbl">Text score</div></div>
    </div>`;

  const claimsRows = claims
    .map((c) => {
      const fact = factByClaim.get(c.claimId);
      const status = fact?.status || '—';
      const badgeClass = status === 'verified' ? 'verified' : status === 'conflict' ? 'conflict' : 'missing_evidence';
      return `<tr>
        <td><span class="tag">${esc(c.claimType)}</span></td>
        <td>${esc(c.claimLabel)}</td>
        <td>${esc(c.claimValue)}</td>
        <td>${esc(c.sourceSection)}</td>
        <td><span class="status-badge ${badgeClass}">${esc(status)}</span></td>
        <td style="font-size:12px;color:var(--muted)">${fact?.notes ? esc(fact.notes) : fact?.evidenceSnippet ? esc(String(fact.evidenceSnippet).slice(0, 120)) : '—'}</td>
      </tr>`;
    })
    .join('');

  const missing = text.extraction?.missingInformation || [];
  const missingHtml = missing.length
    ? `<div class="panel-title" style="margin-top:20px">Missing information</div>
       <table class="data-table"><thead><tr><th>Section</th><th>Item</th><th>Reason</th></tr></thead>
       <tbody>${missing.map((m) => `<tr><td>${esc(m.section)}</td><td>${esc(m.item)}</td><td>${esc(m.reason)}</td></tr>`).join('')}</tbody></table>`
    : '';

  const textIssues = (text.issues || []).slice(0, 50);
  const issuesHtml = textIssues.length
    ? `<div class="panel-title" style="margin-top:20px">Text findings</div>${textIssues.map((i) => issueBlock(i)).join('')}`
    : '';

  container.innerHTML = `${kpiHtml}
    <div class="panel-title">Claims & fact checks</div>
    <table class="data-table">
      <thead><tr><th>Type</th><th>Claim</th><th>Value</th><th>Section</th><th>PMG</th><th>Notes</th></tr></thead>
      <tbody>${claimsRows || '<tr><td colspan="6">No claims</td></tr>'}</tbody>
    </table>${missingHtml}${issuesHtml}`;
}

function renderAllIssues(result, hasMedia, hasText) {
  const mediaIssues = hasMedia ? result.issues || [] : [];
  const textIssues = hasText ? result.textResults?.issues || [] : [];
  const all = [
    ...mediaIssues.map((i) => ({ ...i, source: 'media' })),
    ...textIssues.map((i) => ({ ...i, source: 'text' })),
  ];
  const list = document.getElementById('issuesList');
  const countEl = document.getElementById('issueCount');
  if (!all.length) {
    list.innerHTML = '<div class="empty-state">No issues reported</div>';
    if (countEl) countEl.textContent = '0';
    return;
  }
  if (countEl) countEl.textContent = String(all.length);
  list.innerHTML = all
    .map(
      (issue) => `
    <div class="issue-item ${issue.severity}">
      <div class="sev">${issue.severity} · ${issue.source}${issue.imageId ? ' · ' + esc(issue.imageId) : ''}${issue.category ? ' · ' + esc(issue.category) : ''}</div>
      <div>${esc(issue.description)}</div>
      ${issue.recommendation ? `<div style="margin-top:6px;color:var(--muted);font-size:12px">${esc(issue.recommendation)}</div>` : ''}
    </div>`
    )
    .join('');
}

function issueBlock(issue) {
  return `
    <div class="issue-item ${issue.severity}">
      <div class="sev">${issue.severity}${issue.category ? ' · ' + esc(issue.category) : ''}</div>
      <div>${esc(issue.description)}</div>
      ${issue.recommendation ? `<div style="margin-top:6px;color:var(--muted);font-size:12px">${esc(issue.recommendation)}</div>` : ''}
    </div>`;
}

function pill(label, ok, force) {
  const cls = force || (ok ? 'pass' : 'fail');
  return `<span class="pill ${cls}">${label} ${ok ? '✓' : '✗'}</span>`;
}

document.getElementById('imageSearch')?.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderImageList();
});

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function fmt(n) {
  if (n == null) return '—';
  return typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(1)) : n;
}

function showAlert(type, msg) {
  const el = document.getElementById(type === 'error' ? 'alertError' : 'alertSuccess');
  el.textContent = msg;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 6000);
}

function resetForm() {
  document.getElementById('auditForm').reset();
  document.getElementById('results').classList.remove('active');
  currentAuditResult = null;
  imageAnalysisCache = [];
  selectedScope = 'both';
  document.querySelectorAll('.scope-card').forEach((c) => c.classList.toggle('selected', c.dataset.scope === 'both'));
  updateCheckVisibility();
}

function downloadJSON() {
  if (!currentAuditResult) return;
  const blob = new Blob([JSON.stringify(currentAuditResult, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `audit-${currentAuditResult.propertyId}-${currentAuditResult.auditId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

window.resetForm = resetForm;
window.downloadJSON = downloadJSON;

void loadPublicConfig().then(() => {
  loadHealth();
  initScopeCards();
  initTabs();
  setInterval(loadHealth, 60000);
});
