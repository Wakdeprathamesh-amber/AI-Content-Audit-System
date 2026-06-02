import { google } from 'googleapis';
import { AuditResult, HeroAudit } from '../../../shared/types';
import { categoriesMatchForAudit } from '../../../shared/imageCategories';
import { config } from '../config';

const GOOGLE_SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Build GoogleAuth from either inline service-account JSON or a key-file path.
 *
 * Hosts like Render inject secrets as env vars, not files, so we accept the raw
 * JSON via GOOGLE_SHEETS_CREDENTIALS_JSON (preferred) or — for backwards-compat —
 * JSON pasted into GOOGLE_SHEETS_CREDENTIALS_PATH. Otherwise the value is treated
 * as a file path. Parse failures never echo the credential text (it contains a
 * private key) — only a generic message is thrown.
 */
function buildGoogleAuth() {
  const { credentialsJson, credentialsPath } = config.googleSheets;
  const inline = credentialsJson.trim() || (credentialsPath.trim().startsWith('{') ? credentialsPath.trim() : '');
  if (inline) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(inline);
    } catch {
      throw new Error(
        'Invalid Google service-account JSON in GOOGLE_SHEETS_CREDENTIALS_JSON/PATH (could not parse).'
      );
    }
    return new google.auth.GoogleAuth({ credentials, scopes: GOOGLE_SHEETS_SCOPES });
  }
  return new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: GOOGLE_SHEETS_SCOPES });
}

/**
 * Human-readable label for the hero-audit verdict.
 * The score and source are inlined so the supply team can scan the column.
 */
function formatHeroAction(hero: HeroAudit | undefined): string {
  if (!hero) return '';
  const score = hero.recommendedHeroScore != null ? ` (score ${hero.recommendedHeroScore}/100)` : '';
  const sourceNote =
    hero.currentHeroSource === 'position_0_fallback'
      ? ' [no featured flag, used images[0]]'
      : hero.currentHeroSource === 'config_featured_fallback'
        ? ' [no property featured flag, used config featured]'
        : '';
  switch (hero.action) {
    case 'ok':
      return `✅ OK${score}${sourceNote}`;
    case 'swap':
      return `🔄 SWAP → ${hero.recommendedHeroImageId ?? '?'}${score}${sourceNote}`;
    case 'no_bedroom':
      return `🔴 NO BEDROOM CANDIDATE${sourceNote}`;
    case 'featured_not_bedroom':
      return `🔴 FEATURED NOT BEDROOM${sourceNote}`;
    case 'no_images':
      return '🔴 NO IMAGES';
    default:
      return '';
  }
}

/**
 * Render a canonical lowercase_underscore tag for human display in the sheet.
 *   "bedroom"     -> "Bedroom"
 *   "floor_plan"  -> "Floor Plan"
 *   "common_area" -> "Common Area"
 * Internal storage stays canonical; this is purely a display concern.
 */
function displayCategory(tag: string | null | undefined): string {
  if (!tag) return 'Unknown';
  return tag
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ''))
    .join(' ');
}

/**
 * "Upstream Tag" cell: shows whatever the DB stored on images[].type, plus a
 * ⚠️ marker when our categorizer disagrees. Empty when upstream had no tag.
 */
function formatUpstreamTag(
  upstreamTag: string | null | undefined,
  ourTag: string | null | undefined
): string {
  if (!upstreamTag) return '';
  if (!ourTag) return upstreamTag;
  return categoriesMatchForAudit(upstreamTag, ourTag)
    ? upstreamTag
    : `${upstreamTag} ⚠️ ours: ${ourTag}`;
}

/**
 * "Upstream Blur" cell. Tri-state input (null = upstream didn't run on this image).
 * Append ⚠️ when our verdict disagrees with upstream's.
 *   ourBlurOk = true  → we say NOT blurry
 *   ourBlurOk = false → we say BLURRY
 */
function formatUpstreamBlur(
  upstreamBlurred: boolean | null | undefined,
  ourBlurOk: boolean | undefined
): string {
  if (upstreamBlurred === null || upstreamBlurred === undefined) return '';
  const upstreamSaysBlurry = upstreamBlurred === true;
  const label = upstreamSaysBlurry ? 'BLURRY' : 'OK';
  if (ourBlurOk === undefined) return label;
  const weSayBlurry = !ourBlurOk;
  return upstreamSaysBlurry === weSayBlurry ? label : `${label} ⚠️`;
}

/**
 * "Upstream Watermark" cell. Same shape as the blur version.
 */
function formatUpstreamWatermark(
  upstreamWmPresent: boolean | null | undefined,
  ourWmDetected: boolean | undefined
): string {
  if (upstreamWmPresent === null || upstreamWmPresent === undefined) return '';
  const label = upstreamWmPresent ? 'WATERMARK' : 'OK';
  if (ourWmDetected === undefined) return label;
  return upstreamWmPresent === ourWmDetected ? label : `${label} ⚠️`;
}

function formatFeaturedFlag(isFeatured: boolean | undefined): string {
  return isFeatured ? '⭐ FEATURED' : '';
}

/**
 * GoogleSheetsWriter
 *
 * Tabs:
 *   - "Property Summary"  → ONE row per property (latest snapshot). Upserts.
 *   - "Property History"  → Append-only history of every audit run.
 *   - "Image Details"     → ONE row per (propertyId, imageId). Upserts.
 *   - "Action Items"      → Replaces this audit's previous action items for the property.
 *   - "System Rules & Logic" → Generated from runtime config — single source of truth.
 */
export class GoogleSheetsWriter {
  private sheets: any;
  private spreadsheetId: string;

  private readonly SUMMARY_TAB = 'Property Summary';
  private readonly HISTORY_TAB = 'Property History';
  private readonly IMAGES_TAB = 'Image Details';
  private readonly ACTIONS_TAB = 'Action Items';
  private readonly RULES_TAB = 'System Rules & Logic';
  private readonly TEXT_SUMMARY_TAB = 'Text Summary';
  private readonly TEXT_DETAILS_TAB = 'Text Details';
  private readonly TEXT_ACTIONS_TAB = 'Text Action Items';
  private readonly TEXT_MISSING_INFO_TAB = 'Text Missing Info';

  constructor(spreadsheetId: string) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = google.sheets({ version: 'v4', auth: buildGoogleAuth() });
  }

  // ---- Public ----

  async writeAuditResult(auditResult: AuditResult): Promise<void> {
    console.log(`Writing audit ${auditResult.auditId} to Google Sheets...`);
    await this.writePropertySummary(auditResult);
    await this.writePropertyHistory(auditResult);
    await this.writeImageDetails(auditResult);
    await this.writeActionItems(auditResult);
    if (auditResult.textResults) {
      await this.writeTextSummary(auditResult);
      await this.writeTextDetails(auditResult);
      await this.writeTextActionItems(auditResult);
      await this.writeTextMissingInfo(auditResult);
    }
    await this.ensureRulesSheet();
    console.log(`✅ Audit ${auditResult.auditId} written to Google Sheets`);
  }

  private a1(sheetName: string, range: string): string {
    return `'${sheetName.replace(/'/g, "''")}'!${range}`;
  }

  private normalizeReadRange(range: string): string {
    const m = range.match(/^([A-Z]+):([A-Z]+)$/i);
    if (!m) return range;
    return `${m[1]}1:${m[2]}`;
  }

  async initializeSheets(): Promise<void> {
    console.log('Initializing Google Sheets…');
    for (const tab of [
      this.SUMMARY_TAB,
      this.HISTORY_TAB,
      this.IMAGES_TAB,
      this.ACTIONS_TAB,
      this.RULES_TAB,
      this.TEXT_SUMMARY_TAB,
      this.TEXT_DETAILS_TAB,
      this.TEXT_ACTIONS_TAB,
      this.TEXT_MISSING_INFO_TAB,
    ]) {
      await this.createSheetIfNotExists(tab);
    }

    await this.writeHeaders(this.SUMMARY_TAB, [
      'Property ID',
      'Property Name',
      // Geographic + reference context — added for at-a-glance navigation.
      'Property URL',
      'Amber URL',
      'City',
      'Country',
      'Region',
      'Overall Status',
      'Quality Score',
      'Action Required',
      'Critical Issues',
      'Warnings',
      'Total Images',
      'Failed Images',
      'Watermarks',
      'Low Resolution',
      'Duplicates',
      'Last Audit',
      'Audit ID',
      'Current Hero',
      'Recommended Hero',
      'Hero Action',
    ]);
    await this.writeHeaders(this.HISTORY_TAB, [
      'Timestamp',
      'Audit ID',
      'Property ID',
      'Property Name',
      // Geographic + reference context — same fields as the Summary tab.
      'Property URL',
      'Amber URL',
      'City',
      'Country',
      'Region',
      'Quality Score',
      'Critical Issues',
      'Warnings',
      'Total Images',
      'Passed Images',
      'Hero Action',
      'Current Hero ID',
      'Recommended Hero ID',
    ]);
    await this.writeHeaders(this.IMAGES_TAB, [
      // identity
      'Property ID',
      'Property Name',
      'Image ID',
      'Level',
      'Source Inventory ID',
      'Config Name',
      'Thumbnail',
      'Image URL',
      // technical metadata (from our analyzer)
      'Width',
      'Height',
      'Megapixels',
      'Format',
      'File Size (KB)',
      // quality verdicts
      '✅ Resolution OK',
      '✅ Not Blurry',
      '✅ Sharp Enough',
      '❌ Watermark',
      'Watermark Text',
      'Watermark Confidence',
      // categorization (ours)
      'Category',
      '✅ Categorized',
      // upstream comparison block — diagnostic only
      '⭐ Featured (DB)',
      'Upstream Tag',
      'Upstream Blur',
      'Upstream Watermark',
      // verdict + meta
      '❌ Duplicate',
      'Overall Status',
      'Action',
      'Last Audit',
    ]);
    await this.writeHeaders(this.ACTIONS_TAB, [
      'Priority',
      'Property ID',
      'Property Name',
      'Image ID',
      'Issue Type',
      'Issue',
      'Action Required',
      'Image URL',
      'Audit ID',
    ]);
    await this.writeHeaders(this.TEXT_SUMMARY_TAB, [
      'Property ID',
      'Property Name',
      'Text QC Score',
      'Total Claims',
      'Verified Claims',
      'Conflicting Claims',
      'Missing Evidence Claims',
      'Missing Fields',
      'Critical Issues',
      'Warnings',
      'Audit ID',
      'Last Audit',
    ]);
    await this.writeHeaders(this.TEXT_DETAILS_TAB, [
      'Property ID',
      'Property Name',
      'Claim ID',
      'Claim Type',
      'Claim Label',
      'Claim Value',
      'Unit',
      'Source Section',
      'Source Text',
      'Verification Status',
      'Confidence',
      'Evidence URL',
      'Evidence Snippet',
      'Fact Check Source',
      'Verification Mode',
      'Evidence Type',
      'Fact Check Notes',
      'Diff Type',
      'Suggested Fix',
      'Audit ID',
      'Last Audit',
    ]);
    await this.writeHeaders(this.TEXT_ACTIONS_TAB, [
      'Priority',
      'Property ID',
      'Property Name',
      'Claim ID',
      'Source Section',
      'Issue Category',
      'Diff Type',
      'Issue',
      'Action Required',
      'Evidence URL',
      'Audit ID',
    ]);
    await this.writeHeaders(this.TEXT_MISSING_INFO_TAB, [
      'Property ID',
      'Property Name',
      'Section',
      'Missing Item',
      'Reason',
      'Severity',
      'Audit ID',
      'Last Audit',
    ]);
    await this.regenerateRulesSheet(); // Always regenerate from config.
    console.log('✅ Google Sheets initialized');
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      console.log(`✅ Connected to Google Sheet: ${response.data.properties.title}`);
      return true;
    } catch (error: any) {
      console.error('❌ Failed to connect to Google Sheets:', error.message);
      return false;
    }
  }

  // ---- Writers ----

  private async writePropertySummary(audit: AuditResult): Promise<void> {
    const t = config.thresholds;
    const crit = audit.issues.filter((i) => i.severity === 'critical').length;
    const warn = audit.issues.filter((i) => i.severity === 'warning').length;
    const failed = audit.imageResults.filter((r) => !r.quality?.passed).length;
    const watermarks = audit.imageResults.filter((r) => r.watermark?.detected).length;
    const lowRes = audit.imageResults.filter(
      (r) =>
        r.quality &&
        (r.quality.resolution.width < t.minResolutionWidth ||
          r.quality.resolution.height < t.minResolutionHeight)
    ).length;
    const dups = audit.imageResults.filter((r) => r.isDuplicate).length;

    let overall = '✅ GOOD';
    if (crit >= 5) overall = '🔴 CRITICAL';
    else if (crit > 0 || warn > 3) overall = '⚠️ NEEDS ATTENTION';

    const hero = audit.hero;
    const currentHeroThumb = hero?.currentHeroUrl ? `=IMAGE("${hero.currentHeroUrl}")` : '';
    const recommendedHeroThumb = hero?.recommendedHeroUrl
      ? `=IMAGE("${hero.recommendedHeroUrl}")`
      : '';
    const heroActionLabel = formatHeroAction(hero);
    const meta = audit.propertyMeta;

    const row = [
      audit.propertyId,
      audit.propertyName,
      // Geographic + reference URLs — empty cells when the row lacks the data.
      meta?.url ?? '',
      meta?.amberUrl ?? '',
      meta?.city ?? '',
      meta?.country ?? '',
      meta?.region ?? '',
      overall,
      audit.qualityScore,
      crit > 0 ? 'YES' : 'NO',
      crit,
      warn,
      audit.summary.totalImages,
      failed,
      watermarks,
      lowRes,
      dups,
      new Date(audit.timestamp).toISOString(),
      audit.auditId,
      currentHeroThumb,
      recommendedHeroThumb,
      heroActionLabel,
    ];

    await this.upsertRow(this.SUMMARY_TAB, /* keyCol */ 0, audit.propertyId, row, 22);
  }

  private async writePropertyHistory(audit: AuditResult): Promise<void> {
    const hero = audit.hero;
    const meta = audit.propertyMeta;
    const row = [
      new Date(audit.timestamp).toISOString(),
      audit.auditId,
      audit.propertyId,
      audit.propertyName,
      meta?.url ?? '',
      meta?.amberUrl ?? '',
      meta?.city ?? '',
      meta?.country ?? '',
      meta?.region ?? '',
      audit.qualityScore,
      audit.summary.criticalIssues,
      audit.summary.warnings,
      audit.summary.totalImages,
      audit.summary.passedImages,
      formatHeroAction(hero),
      hero?.currentHeroImageId ?? '',
      hero?.recommendedHeroImageId ?? '',
    ];
    await this.appendRow(this.HISTORY_TAB, row, 'A:Q');
  }

  private async writeImageDetails(audit: AuditResult): Promise<void> {
    const t = config.thresholds;
    // For upsert efficiency, fetch existing keys once.
    const existing = await this.readColumn(this.IMAGES_TAB, 'A:C'); // Property ID + Property Name + Image ID
    const keyToRow = new Map<string, number>();
    existing.forEach((rowVals, idx) => {
      if (idx === 0) return; // header
      const key = `${rowVals[0] ?? ''}::${rowVals[2] ?? ''}`;
      keyToRow.set(key, idx + 1); // 1-based sheet row
    });

    const updates: Array<{ range: string; values: any[][] }> = [];
    const appends: any[][] = [];

    for (const img of audit.imageResults) {
      const resOK =
        img.quality &&
        img.quality.resolution.width >= t.minResolutionWidth &&
        img.quality.resolution.height >= t.minResolutionHeight;
      const notBlurry = img.quality && img.quality.blur >= t.blur;
      const sharp = img.quality && img.quality.sharpness >= t.sharpness;
      const watermark = !!img.watermark?.detected;
      const watermarkText = img.watermark?.text || '';
      const watermarkConfidence = img.watermark?.confidence != null ? `${img.watermark.confidence}%` : '';
      const categorized = img.category && img.category.confidence >= t.categoryConfidence;
      const dup = !!img.isDuplicate;

      let status = '✅ PASS';
      let action = 'None';
      if (watermark) {
        status = '🔴 FAIL';
        action = 'Remove watermark or replace image';
      } else if (resOK === false) {
        status = '🔴 FAIL';
        const w = img.quality?.resolution.width || 0;
        const h = img.quality?.resolution.height || 0;
        action = `Replace with higher resolution (current: ${w}x${h}, min: ${t.minResolutionWidth}x${t.minResolutionHeight})`;
      } else if (notBlurry === false) {
        status = '⚠️ WARNING';
        action = 'Retake photo (blurry)';
      } else if (dup) {
        status = '⚠️ WARNING';
        action = `Remove duplicate (same as ${img.duplicateOf})`;
      } else if (sharp === false) {
        status = '⚠️ WARNING';
        action = 'Consider retaking (low sharpness)';
      }

      // File-level metadata captured by the Python downloader.
      const width = img.quality?.width ?? img.quality?.resolution.width ?? '';
      const height = img.quality?.height ?? img.quality?.resolution.height ?? '';
      const megapixels = img.quality?.megapixels ?? '';
      const format = img.quality?.format ?? '';
      const fileSizeKb =
        img.quality?.file_size_bytes != null
          ? Math.round(img.quality.file_size_bytes / 1024)
          : '';

      // =IMAGE() lets Sheets render the photo inline. USER_ENTERED makes the
      // string evaluate as a formula. Empty URL → empty cell, not #ERROR.
      const thumbnail = img.imageUrl ? `=IMAGE("${img.imageUrl}")` : '';

      // Upstream comparison cells (diagnostic only — Content QC never trusts
      // upstream, but surfaces mismatches so the team can see where the
      // upstream pipeline disagrees with us).
      const upstream = img.upstream;
      const ourCategory = img.category?.primary;
      const ourBlurOk = img.quality ? img.quality.blur >= t.blur : undefined;
      const ourWmDetected = img.watermark?.detected;
      const featuredCell = formatFeaturedFlag(upstream?.isFeatured);
      const upstreamTagCell = formatUpstreamTag(upstream?.tag, ourCategory);
      const upstreamBlurCell = formatUpstreamBlur(upstream?.blurred, ourBlurOk);
      const upstreamWatermarkCell = formatUpstreamWatermark(upstream?.watermarkPresent, ourWmDetected);

      const row = [
        // identity (A-H)
        audit.propertyId,
        audit.propertyName,
        img.imageId,
        img.sourceLevel ?? '',
        img.sourceInventoryId ?? '',
        img.configName ?? '',
        thumbnail,
        img.imageUrl,
        // technical (I-M)
        width,
        height,
        megapixels,
        format,
        fileSizeKb,
        // quality verdicts (N-S)
        resOK ? 'YES' : 'NO',
        notBlurry ? 'YES' : 'NO',
        sharp ? 'YES' : 'NO',
        watermark ? 'YES' : 'NO',
        watermarkText,
        watermarkConfidence,
        // categorization (T-U)
        displayCategory(ourCategory),
        categorized ? 'YES' : 'NO',
        // upstream comparison block (V-Y)
        featuredCell,
        upstreamTagCell,
        upstreamBlurCell,
        upstreamWatermarkCell,
        // verdict + meta (Z-AC)
        dup ? 'YES' : 'NO',
        status,
        action,
        new Date(audit.timestamp).toISOString(),
      ];

      const key = `${audit.propertyId}::${img.imageId}`;
      const existingRowNum = keyToRow.get(key);
      if (existingRowNum) {
        updates.push({
          range: this.a1(this.IMAGES_TAB, `A${existingRowNum}:AC${existingRowNum}`),
          values: [row],
        });
      } else {
        appends.push(row);
      }
    }

    if (updates.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates,
        },
      });
    }
    if (appends.length > 0) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(this.IMAGES_TAB, 'A:AC'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: appends },
      });
    }
  }

  private async writeActionItems(audit: AuditResult): Promise<void> {
    // Remove prior action items for this property (so the tab reflects the latest audit).
    await this.deleteRowsByColumnMatch(this.ACTIONS_TAB, /* col B = Property ID */ 1, audit.propertyId);

    const rows: any[][] = [];
    // Action Items is the actionable fix list — only critical/warning belong here.
    // Informational notes (e.g. "could not verify", low-confidence category) stay
    // in the Image/Text Details tabs, not the action list.
    audit.issues
      .filter((issue) => issue.severity !== 'info')
      .forEach((issue) => {
        const priority = issue.severity === 'critical' ? '🔴 CRITICAL' : '⚠️ WARNING';
        const image = audit.imageResults.find((r) => r.imageId === issue.imageId);
        const imageUrl = image?.imageUrl || '';
        rows.push([
          priority,
          audit.propertyId,
          audit.propertyName,
          issue.imageId || '',
          issue.category,
          issue.description,
          issue.recommendation || '',
          imageUrl,
          audit.auditId,
        ]);
      });
    rows.sort((a, b) => {
      if (a[0] === '🔴 CRITICAL' && b[0] !== '🔴 CRITICAL') return -1;
      if (a[0] !== '🔴 CRITICAL' && b[0] === '🔴 CRITICAL') return 1;
      return 0;
    });

    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(this.ACTIONS_TAB, 'A:I'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }

  private async writeTextSummary(audit: AuditResult): Promise<void> {
    if (!audit.textResults) return;
    const text = audit.textResults;
    const critical = text.issues.filter((issue) => issue.severity === 'critical').length;
    const warnings = text.issues.filter((issue) => issue.severity === 'warning').length;

    const row = [
      audit.propertyId,
      audit.propertyName,
      text.summary.score,
      text.summary.totalClaims,
      text.summary.verifiedClaims,
      text.summary.conflictingClaims,
      text.summary.missingEvidenceClaims,
      text.summary.missingFields,
      critical,
      warnings,
      audit.auditId,
      new Date(audit.timestamp).toISOString(),
    ];

    await this.upsertRow(this.TEXT_SUMMARY_TAB, 0, audit.propertyId, row, 12);
  }

  private async writeTextDetails(audit: AuditResult): Promise<void> {
    if (!audit.textResults) return;

    const text = audit.textResults;
    const factByClaimId = new Map(text.factChecks.map((fact) => [fact.claimId, fact]));
    const issueByClaimId = new Map(
      text.issues.filter((issue) => issue.claimId).map((issue) => [issue.claimId as string, issue])
    );

    const existing = await this.readColumn(this.TEXT_DETAILS_TAB, 'A:C');
    const keyToRow = new Map<string, number>();
    existing.forEach((values, idx) => {
      if (idx === 0) return;
      keyToRow.set(`${values[0] ?? ''}::${values[2] ?? ''}`, idx + 1);
    });

    const updates: Array<{ range: string; values: any[][] }> = [];
    const appends: any[][] = [];

    for (const claim of text.extraction.claims) {
      const fact = factByClaimId.get(claim.claimId);
      const issue = issueByClaimId.get(claim.claimId);
      const row = [
        audit.propertyId,
        audit.propertyName,
        claim.claimId,
        claim.claimType,
        claim.claimLabel,
        claim.claimValue,
        claim.unit || '',
        claim.sourceSection,
        claim.sourceText,
        fact?.status || 'unknown',
        fact?.confidence ?? 0,
        fact?.evidenceUrl || '',
        fact?.evidenceSnippet || '',
        fact?.source || 'none',
        fact?.verificationMode || 'no_url',
        fact?.evidenceSource?.type || 'none',
        fact?.notes || '',
        issue?.diffType || '',
        issue?.recommendation || '',
        audit.auditId,
        new Date(audit.timestamp).toISOString(),
      ];

      const key = `${audit.propertyId}::${claim.claimId}`;
      const existingRowNum = keyToRow.get(key);
      if (existingRowNum) {
        updates.push({
          range: this.a1(this.TEXT_DETAILS_TAB, `A${existingRowNum}:U${existingRowNum}`),
          values: [row],
        });
      } else {
        appends.push(row);
      }
    }

    if (updates.length > 0) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates,
        },
      });
    }

    if (appends.length > 0) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(this.TEXT_DETAILS_TAB, 'A:U'),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: appends },
      });
    }
  }

  private async writeTextActionItems(audit: AuditResult): Promise<void> {
    if (!audit.textResults) return;
    await this.deleteRowsByColumnMatch(this.TEXT_ACTIONS_TAB, 1, audit.propertyId);

    const factByClaimId = new Map(audit.textResults.factChecks.map((fact) => [fact.claimId, fact]));
    const rows = audit.textResults.issues
      .filter((issue) => issue.severity !== 'info')
      .map((issue) => {
        const fact = issue.claimId ? factByClaimId.get(issue.claimId) : null;
        const priority = issue.severity === 'critical' ? '🔴 CRITICAL' : '⚠️ WARNING';
        return [
          priority,
          audit.propertyId,
          audit.propertyName,
          issue.claimId || '',
          issue.sourceSection || '',
          issue.category,
          issue.diffType || '',
          issue.description,
          issue.recommendation || '',
          fact?.evidenceUrl || '',
          audit.auditId,
        ];
      });

    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(this.TEXT_ACTIONS_TAB, 'A:K'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }

  private async writeTextMissingInfo(audit: AuditResult): Promise<void> {
    if (!audit.textResults) return;
    await this.deleteRowsByColumnMatch(this.TEXT_MISSING_INFO_TAB, 0, audit.propertyId);

    const rows =
      audit.textResults.extraction.missingInformation?.map((item) => [
        audit.propertyId,
        audit.propertyName,
        item.section,
        item.item,
        item.reason,
        item.severity,
        audit.auditId,
        new Date(audit.timestamp).toISOString(),
      ]) || [];

    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(this.TEXT_MISSING_INFO_TAB, 'A:H'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }

  // ---- Upsert / append primitives ----

  private async appendRow(sheetName: string, row: any[], range: string): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(sheetName, range),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  private async readColumn(sheetName: string, range: string): Promise<string[][]> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(sheetName, this.normalizeReadRange(range)),
      });
      return response.data.values ?? [];
    } catch (error: any) {
      // If sheet is empty, Google may return 400 — treat as empty.
      console.warn(`readColumn(${sheetName}, ${range}) failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Upsert a row by matching `keyCol` (0-based) against `keyValue`. If a match
   * exists, the row is replaced in-place; otherwise the row is appended.
   */
  private async upsertRow(
    sheetName: string,
    keyCol: number,
    keyValue: string,
    row: any[],
    numCols: number
  ): Promise<void> {
    const lastCol = String.fromCharCode('A'.charCodeAt(0) + numCols - 1);
    const range = `A:${lastCol}`;
    const existing = await this.readColumn(sheetName, range);
    let foundRowNum: number | undefined;
    for (let i = 1; i < existing.length; i++) {
      if ((existing[i][keyCol] ?? '') === keyValue) {
        foundRowNum = i + 1;
        break;
      }
    }
    if (foundRowNum !== undefined) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(sheetName, `A${foundRowNum}:${lastCol}${foundRowNum}`),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
    } else {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: this.a1(sheetName, range),
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });
    }
  }

  /**
   * Delete rows where column `col` (0-based) equals `value`. Returns the number deleted.
   */
  private async deleteRowsByColumnMatch(
    sheetName: string,
    col: number,
    value: string
  ): Promise<number> {
    const existing = await this.readColumn(sheetName, 'A:Z');
    const indicesToDelete: number[] = [];
    for (let i = 1; i < existing.length; i++) {
      if ((existing[i][col] ?? '') === value) indicesToDelete.push(i); // 0-based, includes header offset
    }
    if (indicesToDelete.length === 0) return 0;

    const sheetId = await this.getSheetId(sheetName);
    // Delete from the bottom up so earlier indices stay valid.
    const requests = indicesToDelete
      .sort((a, b) => b - a)
      .map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }));

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
    return indicesToDelete.length;
  }

  // ---- Sheet management ----

  private async createSheetIfNotExists(sheetName: string): Promise<void> {
    const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const exists = spreadsheet.data.sheets.some((s: any) => s.properties.title === sheetName);
    if (exists) return;
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    console.log(`✅ Created sheet: ${sheetName}`);
  }

  private async writeHeaders(sheetName: string, headers: string[]): Promise<void> {
    const existing = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(sheetName, 'A1:Z1'),
    });
    const existingRow = (existing.data.values && existing.data.values.length > 0 ? existing.data.values[0] : []) || [];
    const headerIsSame =
      existingRow.length === headers.length &&
      headers.every((header, idx) => (existingRow[idx] || '').trim() === header.trim());
    if (headerIsSame) {
      console.log(`Headers already up to date in ${sheetName}, skipping…`);
      return;
    }
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(sheetName, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers] },
    });
    const sheetId = await this.getSheetId(sheetName);
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.2, green: 0.2, blue: 0.2 },
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    bold: true,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
        ],
      },
    });
    console.log(`✅ Headers written to ${sheetName}`);
  }

  private async getSheetId(sheetName: string): Promise<number> {
    const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s: any) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
    return sheet.properties.sheetId;
  }

  /**
   * Ensure the rules sheet exists; do not overwrite existing content here so we
   * don't slam Sheets on every audit. Use `regenerateRulesSheet()` to refresh.
   */
  private async ensureRulesSheet(): Promise<void> {
    try {
      const spreadsheet = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      const exists = spreadsheet.data.sheets.some(
        (s: any) => s.properties.title === this.RULES_TAB
      );
      if (!exists) {
        await this.createSheetIfNotExists(this.RULES_TAB);
        await this.regenerateRulesSheet();
      }
    } catch (error: any) {
      console.error('Failed to ensure rules sheet:', error.message);
    }
  }

  /**
   * Build the System Rules sheet from runtime `config` so docs and runtime
   * cannot drift. Call this from `initializeSheets()` and from a maintenance
   * script after any threshold change.
   */
  async regenerateRulesSheet(): Promise<void> {
    const t = config.thresholds;
    const sheetName = this.RULES_TAB;
    await this.createSheetIfNotExists(sheetName);

    const rows: any[][] = [
      ['AI Content Audit System — Rules & Logic (auto-generated from runtime config)'],
      ['Last Updated:', new Date().toISOString()],
      [''],
      ['📋 HOW TO USE THIS SYSTEM'],
      [''],
      ['Tab', 'Purpose', 'Who Uses It'],
      ['Property Summary', 'Latest snapshot per property (upsert) — incl. current vs recommended hero', 'Supply Team, PMG, Management'],
      ['Property History', 'Append-only audit history (every run) — incl. hero action history', 'Tech Team, QA'],
      ['Image Details', 'Per-image checks + upstream comparison (upsert by image)', 'Supply Team'],
      ['Action Items', 'Latest prioritised fix list per property', 'Supply Team, Photographers'],
      ['System Rules & Logic', 'Live rules & thresholds (this sheet)', 'Business Team, Tech Team'],
      [''],
      ['📐 SHEET COLUMNS — full schema (kept in sync with code)'],
      [''],
      ['Property Summary tab (A:V, 22 cols)'],
      ['A Property ID', 'B Property Name', 'C Property URL (source_link)'],
      ['D Amber URL (amberstudent.com/places/<canonical_name>)', 'E City', 'F Country'],
      ['G Region', 'H Overall Status', 'I Quality Score'],
      ['J Action Required', 'K Critical Issues', 'L Warnings'],
      ['M Total Images', 'N Failed Images', 'O Watermarks'],
      ['P Low Resolution', 'Q Duplicates', 'R Last Audit'],
      ['S Audit ID', 'T Current Hero (thumbnail)', 'U Recommended Hero (thumbnail)'],
      ['V Hero Action', '', ''],
      [''],
      ['Property History tab (A:Q, 17 cols, append-only)'],
      ['A Timestamp', 'B Audit ID', 'C Property ID'],
      ['D Property Name', 'E Property URL', 'F Amber URL'],
      ['G City', 'H Country', 'I Region'],
      ['J Quality Score', 'K Critical Issues', 'L Warnings'],
      ['M Total Images', 'N Passed Images', 'O Hero Action'],
      ['P Current Hero ID', 'Q Recommended Hero ID', ''],
      [''],
      ['Image Details tab (A:AC, 29 cols)'],
      ['A Property ID', 'B Property Name', 'C Image ID'],
      ['D Level (property|config)', 'E Source Inventory ID', 'F Config Name'],
      ['G Thumbnail (=IMAGE)', 'H Image URL', 'I Width (px)'],
      ['J Height (px)', 'K Megapixels', 'L Format (JPEG/PNG/WEBP/AVIF)'],
      ['M File Size (KB)', 'N ✅ Resolution OK', 'O ✅ Not Blurry'],
      ['P ✅ Sharp Enough', 'Q ❌ Watermark', 'R Watermark Text'],
      ['S Watermark Confidence', 'T Category (ours)', 'U ✅ Categorized'],
      ['V ⭐ Featured (DB)', 'W Upstream Tag', 'X Upstream Blur'],
      ['Y Upstream Watermark', 'Z ❌ Duplicate', 'AA Overall Status'],
      ['AB Action', 'AC Last Audit', ''],
      [''],
      ['Action Items tab (A:I, 9 cols, replaces this audit\'s items per property)'],
      ['A Priority', 'B Property ID', 'C Property Name'],
      ['D Image ID', 'E Issue Type', 'F Issue'],
      ['G Action Required', 'H Image URL', 'I Audit ID'],
      [''],
      ['🔧 ACTIVE THRESHOLDS (from .env at last service restart)'],
      [''],
      ['Threshold', 'Current Value', 'What It Means'],
      ['Minimum Resolution Width', `${t.minResolutionWidth} px`, 'Below this → critical issue'],
      ['Minimum Resolution Height', `${t.minResolutionHeight} px`, 'Below this → critical issue'],
      [
        'Recommended Resolution Width',
        `${t.recommendedResolutionWidth} px`,
        'Target for the full-credit score',
      ],
      [
        'Recommended Resolution Height',
        `${t.recommendedResolutionHeight} px`,
        'Target for the full-credit score',
      ],
      [
        'Blur Threshold',
        `${t.blur}`,
        'Below this → flagged as blurry. Method: NORMALIZED Laplacian variance — image is resized to a 1024px long-edge and divided by mean luminance, so scores are comparable across photos of any size or exposure.',
      ],
      [
        'Sharpness Threshold',
        `${t.sharpness}`,
        'Below this → flagged as low sharpness (warning)',
      ],
      [
        'Duplicate Similarity',
        `${t.duplicateSimilarity}%`,
        'At/above this similarity → flagged duplicate',
      ],
      [
        'Category Confidence',
        `${t.categoryConfidence}%`,
        'Below this → flagged as low-confidence categorization',
      ],
      [
        'Watermark Confidence',
        `${t.watermarkConfidence}%`,
        'Below this → NOT flagged as watermark',
      ],
      ['Parallel Batch Size', `${config.parallelImageBatchSize}`, 'Images analysed in parallel'],
      [
        'Cache Enabled',
        `${config.cacheEnabled}`,
        'Skips OpenAI calls for known image hashes',
      ],
      ['Cache TTL', `${config.cacheTtlSeconds}s`, 'How long a cached result stays valid'],
      [''],
      ['🎯 QUALITY SCORE FORMULA (matches code in ExecutionEngine.ts)'],
      [''],
      ['Component', 'Weight', 'Source'],
      ['Resolution', '40%', 'Scaled vs MIN and RECOMMENDED resolution thresholds'],
      [
        'Watermark',
        '40%',
        'Inverted confidence: detected→100−confidence, otherwise 100',
      ],
      ['Sharpness', '20%', 'Direct sharpness score 0–100'],
      ['Duplicate penalty', '×0.9', 'Applied to duplicate images'],
      ['Low-category-confidence penalty', '×0.95', 'When category < threshold above'],
      ['Consistency bonus', '+2', 'If std-dev of per-image scores < 10'],
      [
        'Bulk low-quality penalty',
        '×(1 − rate×0.3)',
        'When > 30% of images score below 30',
      ],
      [''],
      ['Score Range', 'Status', 'Action Required'],
      ['90–100', '✅ Excellent', 'NO'],
      ['70–89', '✅ Good', 'NO'],
      ['50–69', '⚠️ Needs Attention', 'MAYBE'],
      ['0–49', '🔴 Critical', 'YES'],
      [''],
      ['🏷️ CATEGORIES (lowercase_underscore — matches inventories.images[].type)'],
      [''],
      ['Canonical Tag', 'Display Name', 'What It Includes'],
      ['bedroom', 'Bedroom', 'ANY interior photo where a bed is the main subject (studio, PBSA room, ensuite, apartment bedroom). Use for all lettable sleeping spaces.'],
      ['kitchen', 'Kitchen', 'Cooking areas with appliances, counters, cabinets'],
      ['bathroom', 'Bathroom', 'Toilets, sinks, showers, bathtubs, ensuite wash areas'],
      ['common_area', 'Common Area', 'INDOOR shared/living: lounge, dining, hallway, study area — NOT gym/pool/lobby facilities'],
      ['amenities', 'Amenities', 'Facility spaces: gym, pool, laundry, cinema, game room, parking — NOT a flat living room'],
      ['floor_plan', 'Floor Plan', 'Architectural floor plans, layouts, blueprints only'],
      ['exterior', 'Exterior', 'OUTDOOR or from outside: façade, entrance, courtyard, terrace with sky — NOT indoor lobby'],
      ['room', 'Room (legacy DB)', 'Legacy upstream tag only (~3% of images). Hero QC treats room = bedroom. AI outputs bedroom; prefer retagging to bedroom.'],
      ['other', 'Other', 'AI fallback only when none of the above fit. Not stored in production DB.'],
      [''],
      ['📦 DATA SOURCE (inventories cluster)'],
      [''],
      ['Scope', 'Property root row (parent_id IS NULL) + all config children (parent_id = root id).'],
      ['SQL', 'WHERE id = $root OR parent_id = $root ORDER BY property row first, then configs.'],
      ['Dedup', 'Same image URL appearing on property + config is audited once.'],
      ['Config ID input', 'Passing a config inventory id resolves to its parent property cluster automatically.'],
      [
        'Eligibility',
        'Audits run ONLY on properties with inventories.status = "active". Soft-deleted/draft/inactive rows are rejected by the API with HTTP 422 (code: PROPERTY_NOT_ACTIVE).',
      ],
      [
        'Geographic context',
        'City / Country / Region columns are parsed from inventories.location (Google Places JSON: locality / country / state).',
      ],
      [
        'Property URL',
        'Sourced from inventories.source_link — the third-party reference URL Amber catalogued the listing from (PMG for UK student accommodation, syndicators elsewhere). Empty when no source link is stored.',
      ],
      [
        'Amber URL',
        'Deterministically built from inventories.canonical_name as https://amberstudent.com/places/<canonical_name> — the customer-facing Amber page for the property.',
      ],
      [''],
      ['⭐ HERO / FEATURED BEDROOM (3 layers)'],
      [''],
      ['Scope', 'Property gallery (search hero) + each config gallery (room-type hero on property page).'],
      ['Layer 1 (critical)', 'Featured/hero upstream tag must be bedroom or legacy room. Else: featured_not_bedroom in Action Items + Hero Action on Summary.'],
      ['Layer 2 (warning)', 'Featured is bedroom but another AI-bedroom scores higher → SWAP suggestion.'],
      ['Layer 3', 'Same rules per config — see Action Items prefixed Config "name".'],
      [''],
      ['Step', 'Logic'],
      [
        'Current hero',
        'Per gallery: first featured=true image, else images[0]. Property scope = root row only for Summary Hero Action.',
      ],
      [
        'Recommended hero',
        `Best AI-tagged ${(process.env.HERO_EXPECTED_CATEGORY || 'bedroom').toLowerCase()} in that gallery. Score = 50% resolution + 50% sharpness; watermark = disqualify.`,
      ],
      ['Hero Action column', 'Meaning'],
      ['✅ OK', 'Current hero is already the best bedroom candidate.'],
      ['🔄 SWAP → <id>', 'Featured is bedroom but a better bedroom exists (enhancement).'],
      ['🔴 FEATURED NOT BEDROOM', 'Featured upstream tag is not bedroom/room — must fix before publish.'],
      ['🔴 NO BEDROOM CANDIDATE', `No usable AI-bedroom in gallery (watermarked or none detected).`],
      ['🔴 NO IMAGES', 'Gallery has zero images.'],
      ['[no featured flag, used images[0]]', 'No featured flag — audit assumed images[0] as current hero.'],
      [''],
      ['🔍 UPSTREAM COMPARISON (Image Details) — diagnostic only'],
      [''],
      [
        'Why this exists',
        'Some images already carry upstream signals (featured, blurred, watermark_present, type). Content QC NEVER trusts these — we re-verify every image independently. But we surface the upstream values side-by-side so the team can see where the upstream pipeline disagrees with our audit.',
      ],
      [''],
      ['Column', 'What it shows', 'How to read mismatches'],
      ['T Category', 'AI-chosen tag (column T).', 'Bedroom = any sleeping space with a bed.'],
      ['V ⭐ Featured (DB)', 'inventories.images[].featured on this row.', '⭐ = featured in Amber for that gallery.'],
      ['W Upstream Tag', 'inventories.images[].type from DB.', 'No ⚠️ when upstream agrees with AI. room vs bedroom = match (legacy).'],
      ['X Upstream Blur', 'Upstream blur verdict (BLURRY/OK).', '⚠️ when upstream disagrees with our blur check.'],
      ['Y Upstream Watermark', 'Upstream watermark verdict (WATERMARK/OK).', '⚠️ when upstream disagrees with our watermark check.'],
      [''],
      ['Empty cell', 'Means upstream did not run on this image (only ~5% of images in DB carry blur/watermark labels).'],
      [''],
      ['💧 WATERMARK DETECTION'],
      [''],
      ['What IS a Watermark', 'What is NOT a Watermark'],
      ['Semi-transparent text/logo overlays', 'Street signs, building names, address numbers'],
      ['Copyright symbols (©) with names', 'Posters, artwork, decorative items in room'],
      ['Website URLs overlaid on image', 'Floor plan labels, room dimensions'],
      ['Photographer credits or studio names', 'Legitimate signage (exit signs, room numbers)'],
      ['Repeated patterns or logos', 'Text on appliances, furniture, equipment'],
      ['"Sample", "Preview", "Demo" text', 'Natural reflections or shadows'],
      ['Real estate agency branding', 'Architectural features or design elements'],
      [''],
      ['Detection Method:', 'OpenAI gpt-4o-mini, image sent as base64'],
      [
        `Confidence >= ${t.watermarkConfidence}%:`,
        'Flagged as watermark (must also include written reasoning)',
      ],
      [`Confidence < ${t.watermarkConfidence}%:`, 'Not flagged (likely false positive)'],
      [''],
      ['🔄 WORKFLOW'],
      [''],
      ['Step', 'What Happens', 'Technology'],
      ['1', 'User submits property ID in the web UI', 'Express + static HTML'],
      ['2', 'API fetches property + images from Redshift (incl. upstream signals: type, featured, blurred, watermark_present)', 'pg pool'],
      ['3', 'Image module downloads image, applies EXIF, computes pHash + captures file size + format', 'Pillow + ImageHash'],
      [
        '4',
        'Cache lookup by (hash, checks, tag) — skips OpenAI on hit',
        'Python in-memory cache',
      ],
      [
        '5',
        'Quality analysis: width, height, megapixels, format, file size, normalized Laplacian-variance blur, sharpness',
        'OpenCV + Pillow',
      ],
      ['6', 'Watermark detection (base64 → OpenAI Vision)', 'gpt-4o-mini'],
      ['7', 'Categorisation (base64 → OpenAI Vision, lowercase_underscore tags)', 'gpt-4o-mini'],
      [
        '8',
        `Duplicate detection (bit-level Hamming on pHash, threshold ${t.duplicateSimilarity}%)`,
        'Pure TS',
      ],
      ['9', `Hero audit (current = featured flag OR images[0], recommended = best ${(process.env.HERO_EXPECTED_CATEGORY || 'bedroom').toLowerCase()})`, 'ExecutionEngine'],
      ['10', 'Score calculation (weighted 40/40/20 + adjustments)', 'ExecutionEngine'],
      ['11', 'Attach upstream signals to results for diagnostic display', 'ExecutionEngine'],
      [
        '12',
        'Output: JSON file + Google Sheets (Summary upsert, History append, Image Details upsert, Action Items replace)',
        'AuditResultWriter + GoogleSheetsWriter',
      ],
      [''],
      ['📝 HOW TO REQUEST CHANGES'],
      [''],
      ['What You Want', 'What to Tell Tech Team'],
      ['Stricter quality checks', `"Increase BLUR_THRESHOLD from ${t.blur} to N"`],
      [
        'Reduce false watermark detections',
        `"Increase WATERMARK_CONFIDENCE_THRESHOLD from ${t.watermarkConfidence} to N"`,
      ],
      [
        'Speed up audits',
        `"Increase PARALLEL_IMAGE_BATCH_SIZE from ${config.parallelImageBatchSize} to N"`,
      ],
      [
        'Change min resolution',
        `"Set MIN_RESOLUTION_WIDTH/HEIGHT from ${t.minResolutionWidth}/${t.minResolutionHeight} to NxN"`,
      ],
      [
        'Change duplicate sensitivity',
        `"Set DUPLICATE_SIMILARITY_THRESHOLD from ${t.duplicateSimilarity} to N"`,
      ],
      [''],
      ['💡 NOTES'],
      [''],
      ['This sheet is regenerated from runtime config via initializeSheets() or after threshold changes.'],
      ['Edit .env then restart services for changes to take effect.'],
      ['Quality scores are RELATIVE — focus on critical issues first.'],
    ];

    // Wipe before writing so stale rows don't linger. Range bumped to 400
    // because the sheet now documents per-tab column inventories + upstream
    // comparison + hero rules; older 200-row clear was leaving stale tail rows.
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(sheetName, 'A1:Z400'),
    });
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: this.a1(sheetName, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    console.log(`✅ Regenerated ${sheetName} from runtime config`);
  }
}
