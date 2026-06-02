import { ExecutionEngine } from './ExecutionEngine';
import { PropertyDataReaderDB } from './PropertyDataReaderDB';
import { ImageAuditClient } from './ImageAuditClient';
import { AuditResultWriter } from './AuditResultWriter';
import { AuditIssue, ImageAnalysisResult, PropertyImage } from '../../../shared/types';

function makeEngine() {
  // The engine only needs these types to instantiate; the methods under test
  // don't reach into them.
  return new ExecutionEngine(
    {} as PropertyDataReaderDB,
    {} as ImageAuditClient,
    {} as AuditResultWriter
  );
}

function quality(
  width: number,
  height: number,
  blur: number,
  sharpness: number,
  passed: boolean
) {
  return {
    resolution: { width, height },
    width,
    height,
    megapixels: Math.round(((width * height) / 1_000_000) * 100) / 100,
    blur,
    sharpness,
    passed,
  };
}

function img(overrides: Partial<ImageAnalysisResult> = {}): ImageAnalysisResult {
  return {
    imageId: 'img-1',
    imageUrl: 'https://example.com/x.jpg',
    quality: quality(1920, 1080, 200, 80, true),
    watermark: { detected: false, confidence: 0 },
    category: { primary: 'Bedroom', confidence: 90 },
    ...overrides,
  };
}

describe('ExecutionEngine.calculateQualityScore', () => {
  it('returns 0 for empty input', () => {
    expect(makeEngine().calculateQualityScore([])).toBe(0);
  });

  it('perfect image set scores 100', () => {
    const perfect = img({ quality: quality(1920, 1080, 200, 100, true) });
    const score = makeEngine().calculateQualityScore([perfect, { ...perfect, imageId: 'i2' }]);
    expect(score).toBe(100);
  });

  it('uniform near-perfect set scores near the cap (resolution 100 + watermark 100 + sharpness 80 = 96, plus consistency bonus)', () => {
    const score = makeEngine().calculateQualityScore([img(), img({ imageId: 'i2' })]);
    expect(score).toBeGreaterThanOrEqual(96);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('detected watermark with full confidence pulls watermark component to 0', () => {
    const score = makeEngine().calculateQualityScore([
      img({ watermark: { detected: true, confidence: 100 } }),
    ]);
    // resolution=100, watermark=0, sharpness=80 → 100*0.4+0*0.4+80*0.2 = 56
    expect(score).toBeGreaterThanOrEqual(50);
    expect(score).toBeLessThanOrEqual(58);
  });

  it('low resolution drives resolution component below the floor', () => {
    const score = makeEngine().calculateQualityScore([
      img({ quality: quality(400, 400, 200, 80, false) }),
    ]);
    // resolution scaled into 0-70, watermark=100, sharpness=80
    expect(score).toBeLessThanOrEqual(80);
    expect(score).toBeGreaterThan(40);
  });

  it('duplicate penalty reduces score', () => {
    const base = makeEngine().calculateQualityScore([img()]);
    const dup = makeEngine().calculateQualityScore([img({ isDuplicate: true })]);
    expect(dup).toBeLessThan(base);
  });

  it('applies bulk low-quality penalty when many images score very low', () => {
    const baseImg = img({
      quality: quality(200, 200, 200, 10, false),
      watermark: { detected: true, confidence: 100 },
    });
    const goodImg = img();
    const scoreManyBad = makeEngine().calculateQualityScore([
      baseImg, baseImg, baseImg, baseImg, goodImg,
    ]);
    expect(scoreManyBad).toBeLessThan(60);
  });

  it('penalizes failed analyses when provided in denominator options', () => {
    const oneGood = [img({ quality: quality(1920, 1080, 200, 100, true) })];
    const withoutFailures = makeEngine().calculateQualityScore(oneGood, { attemptedImages: 1, failedAnalyses: 0 });
    const withFailures = makeEngine().calculateQualityScore(oneGood, { attemptedImages: 4, failedAnalyses: 3 });
    expect(withFailures).toBeLessThan(withoutFailures);
  });
});

describe('ExecutionEngine hero audit', () => {
  const engine = makeEngine() as any;

  function propImage(overrides: Partial<PropertyImage> = {}): PropertyImage {
    return {
      image_id: 'p-img-0',
      property_id: '1',
      image_url: 'https://example.com/p0.jpg',
      source_inventory_id: '1',
      level: 'property',
      category: 'bedroom',
      is_featured: true,
      ...overrides,
    };
  }

  function bedroomResult(id: string, score = 80): ImageAnalysisResult {
    return img({
      imageId: id,
      imageUrl: `https://example.com/${id}.jpg`,
      category: { primary: 'bedroom', confidence: 90 },
      quality: quality(1920, 1080, 200, score, true),
    });
  }

  it('flags critical when property featured is not bedroom', () => {
    const issues: AuditIssue[] = [];
    const images = [
      propImage({ image_id: 'p-img-0', category: 'kitchen', is_featured: true }),
      propImage({ image_id: 'p-img-1', category: 'bedroom', is_featured: false }),
    ];
    const results = [bedroomResult('p-img-1')];
    const hero = engine.computeHeroAudit(images, results, issues, 'property');
    expect(hero.action).toBe('featured_not_bedroom');
    expect(issues.some((i) => i.category === 'featured_not_bedroom')).toBe(true);
    expect(hero.recommendedHeroImageId).toBe('p-img-1');
  });

  it('accepts legacy upstream room tag as bedroom for featured', () => {
    const issues: AuditIssue[] = [];
    const images = [propImage({ category: 'room', is_featured: true })];
    const results = [bedroomResult('p-img-0')];
    const hero = engine.computeHeroAudit(images, results, issues, 'property');
    expect(hero.action).toBe('ok');
    expect(issues.filter((i) => i.category === 'featured_not_bedroom')).toHaveLength(0);
  });

  it('suggests swap when featured bedroom is not the best bedroom', () => {
    const issues: AuditIssue[] = [];
    const images = [
      propImage({ image_id: 'p-img-0', category: 'bedroom', is_featured: true }),
      propImage({ image_id: 'p-img-1', category: 'bedroom', is_featured: false }),
    ];
    const results = [
      bedroomResult('p-img-0', 40),
      bedroomResult('p-img-1', 95),
    ];
    const hero = engine.computeHeroAudit(images, results, issues, 'property');
    expect(hero.action).toBe('swap');
    expect(issues.some((i) => i.category === 'hero_image' && i.severity === 'warning')).toBe(true);
  });

  it('uses config featured as property fallback before images[0]', () => {
    const issues: AuditIssue[] = [];
    const images = [
      propImage({
        image_id: 'p-img-0',
        image_url: 'https://example.com/property-amenity.jpg',
        category: 'amenities',
        is_featured: false,
      }),
      propImage({
        image_id: 'c-img-0',
        image_url: 'https://example.com/config-featured.jpg',
        source_inventory_id: '149337',
        level: 'config',
        config_name: 'Gold',
        category: 'bedroom',
        is_featured: true,
      }),
    ];
    const results = [bedroomResult('c-img-0', 88)];
    const hero = engine.computeHeroAudit(images, results, issues, 'property');

    expect(hero.currentHeroImageId).toBe('c-img-0');
    expect(hero.currentHeroSource).toBe('config_featured_fallback');
    expect(hero.action).toBe('ok');
    expect(issues.some((i) => i.category === 'featured_not_bedroom')).toBe(false);
  });
});
