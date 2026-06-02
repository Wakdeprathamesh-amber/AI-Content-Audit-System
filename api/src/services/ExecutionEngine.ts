import { v4 as uuidv4 } from 'uuid';
import { PropertyDataReaderDB } from './PropertyDataReaderDB';
import { ImageAuditClient } from './ImageAuditClient';
import { AuditResultWriter } from './AuditResultWriter';
import { GoogleSheetsWriter } from './GoogleSheetsWriter';
import { config } from '../config';
import {
  AuditType,
  AuditResult,
  AuditOptions,
  AuditIssue,
  ImageAnalysisResult,
  PropertyImage,
  HeroAudit,
  ConfigHeroAudit,
  TextIssue,
} from '../../../shared/types';
import {
  canonicalizeAiCategory,
  categoriesMatchForAudit,
  isBedroomCategory,
} from '../../../shared/imageCategories';
import { hashSimilarityPercent } from './hashSimilarity';
import { TextQcService } from './text/TextQcService';

/**
 * Category that hero images must belong to. Overridable via env so business
 * can change the rule without a deploy.
 */
const HERO_EXPECTED_CATEGORY = (process.env.HERO_EXPECTED_CATEGORY || 'bedroom').toLowerCase();
const DEFAULT_MEDIA_CHECKS: Array<'quality' | 'watermark' | 'category'> = ['quality', 'watermark', 'category'];
const DEFAULT_TEXT_CHECKS = ['extraction', 'fact_check'] as const;

export class ExecutionEngine {
  private propertyReader: PropertyDataReaderDB;
  private imageAuditClient: ImageAuditClient;
  private resultWriter: AuditResultWriter;
  private sheetsWriter?: GoogleSheetsWriter;
  private textQcService: TextQcService;

  constructor(
    propertyReader: PropertyDataReaderDB,
    imageAuditClient: ImageAuditClient,
    resultWriter: AuditResultWriter,
    sheetsWriter?: GoogleSheetsWriter
  ) {
    this.propertyReader = propertyReader;
    this.imageAuditClient = imageAuditClient;
    this.resultWriter = resultWriter;
    this.sheetsWriter = sheetsWriter;
    this.textQcService = new TextQcService(propertyReader);

    console.log(`📊 Output mode: ${config.outputMode}`);
    console.log(`⚡ Parallel batch size: ${config.parallelImageBatchSize}`);
  }

  /**
   * Execute audit for a single property.
   */
  async executeSingleAudit(
    propertyId: string,
    options: AuditOptions = {}
  ): Promise<AuditResult> {
    const auditId = uuidv4();
    const startTime = Date.now();

    console.log(`Starting audit ${auditId} for property ${propertyId}`);

    try {
      const property = await this.propertyReader.getProperty(propertyId);
      if (!property) {
        throw new Error(`Property not found: ${propertyId}`);
      }
      // Content QC only audits live listings. Soft-deleted / draft / inactive
      // rows are preserved in the DB but must not be re-audited — surface a
      // clear, distinct error so the route can return 422 (not 404 or 500).
      if (property.status !== 'active') {
        const err: any = new Error(
          `Property ${propertyId} has status "${property.status}" — Content QC only audits active properties.`
        );
        err.code = 'PROPERTY_NOT_ACTIVE';
        err.propertyStatus = property.status;
        throw err;
      }
      console.log(`Property found: ${property.property_name}`);
      const auditType: AuditType = options.auditType || 'media';
      const runMedia = auditType === 'media' || auditType === 'both';
      const runText = auditType === 'text' || auditType === 'both';

      let images: PropertyImage[] = [];
      const imageResults: ImageAnalysisResult[] = [];
      const issues: AuditIssue[] = [];
      const imageHashes: Array<{ imageId: string; hash: string | null }> = [];
      let failedMediaAnalyses = 0;
      let hero: HeroAudit | undefined;
      let configHeroes: ConfigHeroAudit[] | undefined;
      let textResults: AuditResult['textResults'];

      if (runMedia) {
        images = await this.propertyReader.getPropertyImages(propertyId);
        const batchSize = this.getEffectiveBatchSize(images.length);
        const requestStaggerMs = this.getEffectiveRequestStaggerMs();
        const batchDelayMs = this.getEffectiveBatchDelayMs();

        if (images.length === 0) {
          console.warn(`No images found for property ${propertyId}`);
        }

        console.log(
          `⚡ Processing ${images.length} images in parallel (batch size: ${batchSize}, request stagger: ${requestStaggerMs}ms, batch delay: ${batchDelayMs}ms)...`
        );

        for (let i = 0; i < images.length; i += batchSize) {
          const batch = images.slice(i, i + batchSize);
          const batchNumber = Math.floor(i / batchSize) + 1;
          const totalBatches = Math.ceil(images.length / batchSize);
          console.log(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} images)...`);

          const batchPromises = batch.map(async (image, batchIndex) => {
            try {
              if (requestStaggerMs > 0) {
                const staggerForThisImage = batchIndex * requestStaggerMs;
                if (staggerForThisImage > 0) {
                  await this.sleep(staggerForThisImage);
                }
              }
              console.log(`Analyzing image: ${image.image_id}`);
              const checks =
                options.checks && options.checks.length > 0 ? options.checks : DEFAULT_MEDIA_CHECKS;
              const existingTag = image.category || undefined;
              const result = await this.imageAuditClient.analyzeImage(
                image.image_url,
                checks,
                existingTag,
                image.image_id
              );
              result.imageId = image.image_id;
              result.sourceInventoryId = image.source_inventory_id;
              result.sourceLevel = image.level;
              result.configName = image.config_name;
              // Carry every upstream signal onto the audit result so the sheet
              // can compare. Diagnostic only — we never trusted any of these.
              result.upstream = {
                tag: image.category ?? null,
                blurred: image.upstream_blurred ?? null,
                watermarkPresent: image.upstream_watermark_present ?? null,
                watermarkText: image.upstream_watermark_text ?? null,
                isFeatured: image.is_featured === true,
                ignoreAiAnalysis: image.ignore_ai_analysis === true,
              };
              const hash = result.imageHash || null;
              return { result, hash, imageId: image.image_id, error: null };
            } catch (error: any) {
              console.error(`Error analyzing image ${image.image_id}:`, error.message);
              return { result: null, hash: null, imageId: image.image_id, error: error.message };
            }
          });

          const batchResults = await Promise.all(batchPromises);

          for (const { result, hash, imageId, error } of batchResults) {
            if (result) {
              imageResults.push(result);
              if (hash) imageHashes.push({ imageId, hash });
              this.extractIssues(result, imageId, issues);
            } else if (error) {
              failedMediaAnalyses += 1;
              const classified = this.classifyImageAnalysisError(error);
              issues.push({
                severity: 'critical',
                category: classified.category,
                description: `Failed to analyze image ${imageId}: ${error}`,
                recommendation: classified.recommendation,
                imageId,
              });
            }
          }

          console.log(`✓ Batch ${batchNumber}/${totalBatches} complete`);
          if (batchDelayMs > 0 && batchNumber < totalBatches) {
            console.log(`⏳ Waiting ${batchDelayMs}ms before next image batch...`);
            await this.sleep(batchDelayMs);
          }
        }

        console.log(`✓ All ${images.length} images processed`);

        console.log(`Checking for duplicate images among ${imageHashes.length} images...`);
        const duplicateResults = this.detectDuplicates(imageHashes);

        for (const dupResult of duplicateResults) {
          if (dupResult.isDuplicate) {
            issues.push({
              severity: 'warning',
              category: 'duplicate_image',
              description: `Image is ${dupResult.similarity}% similar to image ${dupResult.duplicateOf}`,
              recommendation: 'Remove duplicate image or use a different photo',
              imageId: dupResult.imageId,
            });
            const imageResult = imageResults.find((r) => r.imageId === dupResult.imageId);
            if (imageResult) {
              imageResult.isDuplicate = true;
              imageResult.duplicateOf = dupResult.duplicateOf;
              imageResult.similarity = dupResult.similarity;
            }
          }
        }

        hero = this.computeHeroAudit(images, imageResults, issues, 'property');
        configHeroes = this.computeConfigHeroAudits(images, imageResults, issues);
      }

      if (runText) {
        const textChecks =
          options.textChecks && options.textChecks.length > 0 ? options.textChecks : [...DEFAULT_TEXT_CHECKS];
        try {
          const textOutput = await this.textQcService.run(property.property_id, textChecks);
          if (textOutput) {
            textResults = textOutput;
            this.mapTextIssuesToAuditIssues(textOutput.issues, issues);
          } else {
            issues.push({
              severity: 'critical',
              category: 'text_qc',
              description: `Failed to gather text content for property ${property.property_id}`,
              recommendation: 'Verify source text fields are available before rerunning Text QC.',
            });
          }
        } catch (error: any) {
          issues.push({
            severity: 'critical',
            category: 'text_qc',
            description: `Text QC failed for property ${property.property_id}: ${error.message}`,
            recommendation: 'Retry once dependencies are healthy and verify OpenAI/source connectivity.',
          });
        }
      }

      const mediaScore = runMedia
        ? this.calculateQualityScore(imageResults, {
            attemptedImages: images.length,
            failedAnalyses: failedMediaAnalyses,
          })
        : null;
      const textScore = runText ? Math.round(textResults?.summary.score || 0) : null;
      const qualityScore = this.calculateCombinedScore(mediaScore, textScore);
      const totalImages = runMedia ? images.length : 0;
      const passedImages = runMedia
        ? imageResults.filter((result) => this.isImagePassingSummaryThreshold(result)).length
        : 0;

      const auditResult: AuditResult = {
        auditId,
        timestamp: new Date().toISOString(),
        propertyId: property.property_id,
        propertyName: property.property_name,
        propertyMeta: {
          url: property.source_url ?? null,
          amberUrl: property.amber_url ?? null,
          city: property.city ?? null,
          country: property.country ?? null,
          region: property.region ?? null,
        },
        auditType,
        qualityScore,
        imageResults,
        issues,
        summary: {
          totalImages,
          criticalIssues: issues.filter((i) => i.severity === 'critical').length,
          warnings: issues.filter((i) => i.severity === 'warning').length,
          passedImages,
          mediaAttempted: runMedia ? images.length : 0,
          mediaAnalyzed: runMedia ? imageResults.length : 0,
          mediaFailed: runMedia ? failedMediaAnalyses : 0,
          textClaims: textResults?.summary.totalClaims ?? 0,
        },
        scoreBreakdown: {
          mediaScore,
          textScore,
          combinedScore: qualityScore,
          mediaWeight: mediaScore !== null && textScore !== null ? 0.65 : mediaScore !== null ? 1 : 0,
          textWeight: mediaScore !== null && textScore !== null ? 0.35 : textScore !== null ? 1 : 0,
        },
        hero,
        configHeroes,
        textResults,
      };

      await this.resultWriter.writeAuditResult(auditId, propertyId, auditResult);

      if (config.outputMode === 'sheets' || config.outputMode === 'both') {
        if (this.sheetsWriter) {
          try {
            await this.sheetsWriter.writeAuditResult(auditResult);
            console.log('✅ Results written to Google Sheets');
          } catch (error: any) {
            console.error('⚠️  Failed to write to Google Sheets:', error.message);
          }
        } else {
          console.warn('⚠️  Google Sheets writer not configured');
        }
      }

      if (config.outputMode === 'database' || config.outputMode === 'both') {
        console.log('⏳ Database output not yet implemented');
      }

      const duration = Date.now() - startTime;
      console.log(`Audit ${auditId} completed in ${duration}ms`);
      console.log(`Quality Score: ${qualityScore}/100`);
      console.log(
        `Issues: ${issues.length} (${auditResult.summary.criticalIssues} critical, ${auditResult.summary.warnings} warnings)`
      );

      return auditResult;
    } catch (error: any) {
      console.error(`Audit ${auditId} failed:`, error.message);
      throw error;
    }
  }

  /**
   * Detect duplicates among the given perceptual hashes.
   * Uses true bit-level Hamming similarity (see `hashSimilarity.ts`).
   */
  private detectDuplicates(
    imageHashes: Array<{ imageId: string; hash: string | null }>
  ): Array<{ imageId: string; isDuplicate: boolean; duplicateOf?: string; similarity?: number }> {
    const results: Array<{
      imageId: string;
      isDuplicate: boolean;
      duplicateOf?: string;
      similarity?: number;
    }> = [];
    const seenHashes: Array<{ imageId: string; hash: string }> = [];
    const threshold = config.thresholds.duplicateSimilarity;

    for (const { imageId, hash } of imageHashes) {
      if (!hash) {
        results.push({ imageId, isDuplicate: false });
        continue;
      }

      let maxSimilarity = 0;
      let duplicateOf: string | undefined;

      for (const seen of seenHashes) {
        const similarity = hashSimilarityPercent(hash, seen.hash);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          if (similarity >= threshold) {
            duplicateOf = seen.imageId;
          }
        }
      }

      const isDuplicate = maxSimilarity >= threshold;
      results.push({
        imageId,
        isDuplicate,
        duplicateOf,
        similarity: maxSimilarity > 0 ? Math.round(maxSimilarity * 100) / 100 : undefined,
      });

      seenHashes.push({ imageId, hash });
    }

    const duplicateCount = results.filter((r) => r.isDuplicate).length;
    console.log(
      `Duplicate detection complete: ${duplicateCount} duplicates found (threshold: ${threshold}%)`
    );

    return results;
  }

  private calculateCombinedScore(mediaScore: number | null, textScore: number | null): number {
    if (mediaScore === null && textScore === null) return 0;
    if (mediaScore !== null && textScore === null) return Math.round(mediaScore);
    if (mediaScore === null && textScore !== null) return Math.round(textScore);
    return Math.round((mediaScore as number) * 0.65 + (textScore as number) * 0.35);
  }

  private isImagePassingSummaryThreshold(result: ImageAnalysisResult): boolean {
    const t = config.thresholds;
    if (!result.quality) return false;
    const { resolution, blur, sharpness } = result.quality;
    const resolutionPass = resolution.width >= t.minResolutionWidth && resolution.height >= t.minResolutionHeight;
    const blurPass = blur >= t.blur;
    const sharpnessPass = sharpness >= t.sharpness;
    const watermarkPass = !(
      result.watermark?.detected && (result.watermark.confidence ?? 0) >= t.watermarkConfidence
    );
    return resolutionPass && blurPass && sharpnessPass && watermarkPass;
  }

  private getEffectiveBatchSize(totalImages: number): number {
    let batch = Math.max(1, config.parallelImageBatchSize);
    if (config.safeModeEnabled) {
      batch = Math.min(batch, Math.max(1, config.safeParallelImageBatchSize));
    }
    if (totalImages >= config.largePropertyImageCount) {
      batch = Math.min(batch, Math.max(1, config.largePropertyBatchSize));
    }
    return batch;
  }

  private getEffectiveRequestStaggerMs(): number {
    if (config.safeModeEnabled) {
      return Math.max(config.imageRequestStaggerMs, config.safeImageRequestStaggerMs);
    }
    return Math.max(0, config.imageRequestStaggerMs);
  }

  private getEffectiveBatchDelayMs(): number {
    if (config.safeModeEnabled) {
      return Math.max(config.imageBatchDelayMs, config.safeImageBatchDelayMs);
    }
    return Math.max(0, config.imageBatchDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private classifyImageAnalysisError(errorMessage: string): { category: string; recommendation: string } {
    if (errorMessage.includes('IMAGE_RATE_LIMITED') || errorMessage.includes('429')) {
      return {
        category: 'image_rate_limited',
        recommendation:
          'Retry later, lower PARALLEL_IMAGE_BATCH_SIZE, or enable SAFE_MODE_ENABLED to reduce request burst.',
      };
    }
    if (errorMessage.includes('IMAGE_SOURCE_FORBIDDEN') || errorMessage.includes('403')) {
      return {
        category: 'image_source_forbidden',
        recommendation:
          'Verify source image URL permissions/signatures and CDN access; this is usually non-retryable.',
      };
    }
    if (errorMessage.includes('IMAGE_NON_RETRYABLE_CLIENT_ERROR')) {
      return {
        category: 'image_client_error',
        recommendation: 'Fix request/input URL payload; this class of 4xx errors is non-retryable.',
      };
    }
    return {
      category: 'image_analysis_error',
      recommendation: 'Retry after dependency health check or reduce pipeline concurrency.',
    };
  }

  /**
   * Extract issues from image analysis result.
   */
  private extractIssues(
    result: ImageAnalysisResult,
    imageId: string,
    issues: AuditIssue[]
  ): void {
    const t = config.thresholds;

    if (result.quality) {
      const { resolution, blur, sharpness } = result.quality;

      if (resolution.width < t.minResolutionWidth || resolution.height < t.minResolutionHeight) {
        issues.push({
          severity: 'critical',
          category: 'image_quality',
          description: `Image resolution (${resolution.width}x${resolution.height}) is below minimum requirement (${t.minResolutionWidth}x${t.minResolutionHeight})`,
          recommendation: `Upload a higher resolution image (minimum ${t.minResolutionWidth}x${t.minResolutionHeight} pixels)`,
          imageId,
        });
      }

      if (blur < t.blur) {
        issues.push({
          severity: 'warning',
          category: 'image_quality',
          description: `Image appears blurred (blur score: ${blur.toFixed(2)}, threshold: ${t.blur})`,
          recommendation: 'Consider retaking the photo with better focus',
          imageId,
        });
      }

      if (sharpness < t.sharpness) {
        issues.push({
          severity: 'warning',
          category: 'image_quality',
          description: `Image has low sharpness (${sharpness.toFixed(2)}/100, threshold: ${t.sharpness})`,
          recommendation: 'Use a higher quality camera or improve lighting',
          imageId,
        });
      }
    }

    if (
      result.watermark &&
      result.watermark.detected &&
      (result.watermark.confidence ?? 0) >= t.watermarkConfidence
    ) {
      issues.push({
        severity: 'critical',
        category: 'watermark',
        description: `Watermark detected (confidence: ${result.watermark.confidence}%)${
          result.watermark.text ? ` - Text: "${result.watermark.text}"` : ''
        }`,
        recommendation: 'Remove watermark or use a different image without watermarks',
        imageId,
      });
    }

    if (result.category && result.category.confidence < t.categoryConfidence) {
      issues.push({
        severity: 'info',
        category: 'categorization',
        description: `Low confidence in category "${result.category.primary}" (${result.category.confidence}%, threshold: ${t.categoryConfidence}%)`,
        recommendation: 'Manually verify the image category',
        imageId,
      });
    }

    if (
      result.category?.is_tag_correct === false &&
      !categoriesMatchForAudit(result.upstream?.tag, result.category.primary)
    ) {
      issues.push({
        severity: 'warning',
        category: 'category_tag_mismatch',
        description: `Upstream tag does not match detected category (upstream: ${result.upstream?.tag || 'unknown'}, detected: ${result.category.primary})`,
        recommendation: result.category.suggested_correction
          ? `Update upstream tag to "${result.category.suggested_correction}".`
          : 'Review and correct upstream image category tag.',
        imageId,
      });
    }

    if (result.watermark?.degraded || result.category?.degraded) {
      issues.push({
        severity: 'warning',
        category: 'analysis_degraded',
        description: 'Image analysis used fallback behavior due to model/service degradation.',
        recommendation: 'Re-run this audit once image-module dependencies are healthy.',
        imageId,
      });
    }
  }

  private mapTextIssuesToAuditIssues(textIssues: TextIssue[], issues: AuditIssue[]): void {
    textIssues.forEach((textIssue) => {
      issues.push({
        severity: textIssue.severity,
        category: `text_${textIssue.category}`,
        description: textIssue.description,
        recommendation: textIssue.recommendation,
      });
    });
  }

  /**
   * Hero-image audit for property-level gallery (search / property page hero).
   * Layer 1: featured hero must be bedroom (upstream tag; legacy `room` counts).
   * Layer 2: among bedroom AI results, recommend best technical score (swap suggestion).
   */
  private computeHeroAudit(
    images: PropertyImage[],
    imageResults: ImageAnalysisResult[],
    issues: AuditIssue[],
    scope: 'property' | 'config',
    configMeta?: { sourceInventoryId: string; configName: string }
  ): HeroAudit {
    const scopeImages =
      scope === 'property'
        ? images.filter((img) => img.level === 'property')
        : images.filter(
            (img) =>
              img.level === 'config' &&
              img.source_inventory_id === configMeta?.sourceInventoryId
          );

    const heroScope = scopeImages.length > 0 ? scopeImages : scope === 'property' ? images : [];
    const scopeLabel =
      scope === 'property'
        ? 'Property'
        : `Config "${configMeta?.configName ?? configMeta?.sourceInventoryId}"`;

    if (heroScope.length === 0) {
      if (scope === 'config') {
        return {
          currentHeroImageId: null,
          currentHeroUrl: null,
          currentHeroSource: 'none',
          recommendedHeroImageId: null,
          recommendedHeroUrl: null,
          recommendedHeroScore: null,
          action: 'no_images',
          reason: `${scopeLabel} has no images.`,
        };
      }
      return {
        currentHeroImageId: null,
        currentHeroUrl: null,
        currentHeroSource: 'none',
        recommendedHeroImageId: null,
        recommendedHeroUrl: null,
        recommendedHeroScore: null,
        action: 'no_images',
        reason: 'Property has no images.',
      };
    }

    const featured = heroScope.find((img) => img.is_featured === true);
    const configFeaturedFallback =
      scope === 'property' && !featured
        ? images.find((img) => img.level === 'config' && img.is_featured === true)
        : undefined;
    const currentImg = featured ?? configFeaturedFallback ?? heroScope[0];
    const currentHeroSource: HeroAudit['currentHeroSource'] = featured
      ? 'featured_flag'
      : configFeaturedFallback
        ? 'config_featured_fallback'
        : 'position_0_fallback';
    const currentHeroCategory = currentImg.category ?? null;
    const featuredNotBedroom = !isBedroomCategory(currentHeroCategory);

    if (featuredNotBedroom) {
      const tagLabel = currentHeroCategory || 'untagged';
      issues.push({
        severity: 'critical',
        category: 'featured_not_bedroom',
        description: `${scopeLabel} featured/hero image (${currentImg.image_id}) is tagged "${tagLabel}" — must be bedroom.`,
        recommendation:
          'Set featured flag on a bedroom image (any sleeping room with a bed). Use the recommended hero if shown.',
        imageId: currentImg.image_id,
      });
    }

    const scopeImageIds = new Set(heroScope.map((i) => i.image_id));
    // When property hero falls back to a config-featured image, include it in
    // candidate scoring so we do not incorrectly report "no bedroom candidate".
    scopeImageIds.add(currentImg.image_id);
    const candidates = imageResults
      .filter((r) => scopeImageIds.has(r.imageId))
      .filter((r) => canonicalizeAiCategory(r.category?.primary) === HERO_EXPECTED_CATEGORY)
      .map((r) => ({ result: r, score: this.heroScore(r) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    const baseReturn = {
      currentHeroImageId: currentImg.image_id,
      currentHeroUrl: currentImg.image_url,
      currentHeroSource,
      currentHeroCategory,
    };

    if (candidates.length === 0) {
      const reason = `No clean ${HERO_EXPECTED_CATEGORY} image in ${scopeLabel} gallery (watermarked, missing, or none detected).`;
      if (!featuredNotBedroom) {
        issues.push({
          severity: 'critical',
          category: 'hero_image',
          description: reason,
          recommendation: `Add a high-quality ${HERO_EXPECTED_CATEGORY} photo with no watermark.`,
        });
      }
      return {
        ...baseReturn,
        recommendedHeroImageId: null,
        recommendedHeroUrl: null,
        recommendedHeroScore: null,
        action: featuredNotBedroom ? 'featured_not_bedroom' : 'no_bedroom',
        reason: featuredNotBedroom
          ? `${scopeLabel} featured image is not a bedroom, and no suitable bedroom candidate was found. ${reason}`
          : reason,
      };
    }

    const best = candidates[0];
    const recommendedImageId = best.result.imageId;
    const recommendedUrl = best.result.imageUrl;
    const recommendedScore = Math.round(best.score * 100) / 100;

    if (featuredNotBedroom) {
      return {
        ...baseReturn,
        recommendedHeroImageId: recommendedImageId,
        recommendedHeroUrl: recommendedUrl,
        recommendedHeroScore: recommendedScore,
        action: 'featured_not_bedroom',
        reason: `${scopeLabel} featured image is "${currentHeroCategory || 'untagged'}" — use bedroom ${recommendedImageId} (score ${recommendedScore}/100).`,
      };
    }

    if (recommendedImageId === currentImg.image_id) {
      return {
        ...baseReturn,
        recommendedHeroImageId: recommendedImageId,
        recommendedHeroUrl: recommendedUrl,
        recommendedHeroScore: recommendedScore,
        action: 'ok',
        reason: `Current hero is already the best ${HERO_EXPECTED_CATEGORY} candidate (score ${recommendedScore}/100).`,
      };
    }

    const reason = `${scopeLabel} hero (${currentImg.image_id}) could be swapped for ${recommendedImageId} — higher-scoring ${HERO_EXPECTED_CATEGORY} (${recommendedScore}/100).`;
    issues.push({
      severity: 'warning',
      category: 'hero_image',
      description: reason,
      recommendation: `Swap featured/hero to ${recommendedUrl}`,
      imageId: recommendedImageId,
    });
    return {
      ...baseReturn,
      recommendedHeroImageId: recommendedImageId,
      recommendedHeroUrl: recommendedUrl,
      recommendedHeroScore: recommendedScore,
      action: 'swap',
      reason,
    };
  }

  private computeConfigHeroAudits(
    images: PropertyImage[],
    imageResults: ImageAnalysisResult[],
    issues: AuditIssue[]
  ): ConfigHeroAudit[] {
    const configIds = new Set(
      images.filter((i) => i.level === 'config').map((i) => i.source_inventory_id)
    );
    const audits: ConfigHeroAudit[] = [];

    for (const sourceInventoryId of configIds) {
      const sample = images.find((i) => i.source_inventory_id === sourceInventoryId);
      const configName = sample?.config_name ?? sourceInventoryId;
      const hero = this.computeHeroAudit(images, imageResults, issues, 'config', {
        sourceInventoryId,
        configName,
      });
      audits.push({
        sourceInventoryId,
        configName,
        currentHeroImageId: hero.currentHeroImageId,
        currentHeroUrl: hero.currentHeroUrl,
        currentHeroSource: hero.currentHeroSource,
        currentHeroCategory: hero.currentHeroCategory,
        recommendedHeroImageId: hero.recommendedHeroImageId,
        recommendedHeroUrl: hero.recommendedHeroUrl,
        recommendedHeroScore: hero.recommendedHeroScore,
        action: hero.action,
        reason: hero.reason,
      });
    }

    return audits;
  }

  /**
   * Score an image as a hero candidate, 0-100.
   * Hard disqualifiers (return 0): watermark detected, wrong category, no quality data.
   * Otherwise: 50% resolution-vs-recommended, 50% sharpness.
   */
  private heroScore(img: ImageAnalysisResult): number {
    if (img.watermark?.detected) return 0;
    if (canonicalizeAiCategory(img.category?.primary) !== HERO_EXPECTED_CATEGORY) return 0;
    if (!img.quality) return 0;

    const t = config.thresholds;
    const { width, height } = img.quality.resolution;
    const wRatio = Math.min(width / t.recommendedResolutionWidth, 1);
    const hRatio = Math.min(height / t.recommendedResolutionHeight, 1);
    const resolutionScore = ((wRatio + hRatio) / 2) * 100;

    const sharpnessScore = img.quality.sharpness ?? 0;
    return resolutionScore * 0.5 + sharpnessScore * 0.5;
  }

  /**
   * Overall quality score (0-100). Weighted: resolution 40, watermark 40, sharpness 20.
   * Portfolio adjustments: small bonus for consistency, penalty when many very-low images.
   */
  calculateQualityScore(
    imageResults: ImageAnalysisResult[],
    options?: { attemptedImages?: number; failedAnalyses?: number }
  ): number {
    const attemptedImages = options?.attemptedImages ?? imageResults.length;
    const failedAnalyses = options?.failedAnalyses ?? Math.max(0, attemptedImages - imageResults.length);
    if (attemptedImages === 0) return 0;

    const t = config.thresholds;

    const imageScores = imageResults.map((img) => {
      // Resolution (40%)
      let resolutionScore = 0;
      if (img.quality) {
        const { width, height } = img.quality.resolution;
        const minDim = Math.min(width, height);
        const maxDim = Math.max(width, height);

        if (minDim >= t.minResolutionHeight && maxDim >= t.minResolutionWidth) {
          if (width >= t.recommendedResolutionWidth && height >= t.recommendedResolutionHeight) {
            resolutionScore = 100;
          } else {
            const wRatio = Math.min(width / t.recommendedResolutionWidth, 1);
            const hRatio = Math.min(height / t.recommendedResolutionHeight, 1);
            resolutionScore = Math.max(70, ((wRatio + hRatio) / 2) * 100);
          }
        } else {
          const wRatio = Math.min(width / t.minResolutionWidth, 1);
          const hRatio = Math.min(height / t.minResolutionHeight, 1);
          resolutionScore = ((wRatio + hRatio) / 2) * 70;
        }
      } else {
        resolutionScore = 50;
      }

      // Watermark (40%)
      let watermarkScore = 100;
      if (img.watermark?.detected && (img.watermark.confidence ?? 0) >= t.watermarkConfidence) {
        const c = img.watermark.confidence || 100;
        watermarkScore = Math.max(0, 100 - c);
      }

      // Sharpness (20%)
      const sharpnessScore = img.quality?.sharpness ?? 100;

      let penalty = 1;
      if (img.isDuplicate) penalty *= 0.9;
      if (img.category && img.category.confidence < t.categoryConfidence) penalty *= 0.95;

      const weighted =
        (resolutionScore * 0.4 + watermarkScore * 0.4 + sharpnessScore * 0.2) * penalty;
      return Math.max(0, Math.min(100, weighted));
    });

    const failedPenaltyScores = Array.from({ length: failedAnalyses }).map(() => 0);
    const allScores = [...imageScores, ...failedPenaltyScores];
    const avg = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    let final = avg;

    const sd = this.calculateStdDev(allScores);
    if (sd < 10) final += 2;

    const veryLowCount = allScores.filter((s) => s < 30).length;
    const veryLowRate = veryLowCount / allScores.length;
    if (veryLowRate > 0.3) {
      final *= 1 - veryLowRate * 0.3;
    }

    const rounded = Math.max(0, Math.min(100, Math.round(final)));
    console.log(`Quality Score Calculation:`);
    console.log(`  - Average image score: ${avg.toFixed(2)}`);
    console.log(`  - Standard deviation: ${sd.toFixed(2)}`);
    console.log(`  - Failed analyses counted in denominator: ${failedAnalyses}`);
    console.log(`  - Very low quality images: ${veryLowCount}/${allScores.length}`);
    console.log(`  - Final score: ${rounded}/100`);
    return rounded;
  }

  private calculateStdDev(scores: number[]): number {
    if (scores.length === 0) return 0;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const squareDiffs = scores.map((s) => Math.pow(s - avg, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / scores.length);
  }
}
