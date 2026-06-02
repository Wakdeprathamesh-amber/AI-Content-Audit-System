import { db } from '../config/database';
import {
  Property,
  PropertyImage,
  PropertyFilters,
  InventoryLevel,
} from '../../../shared/types';

/** Coerce upstream string/bool flag to a real boolean. Empty/missing → false. */
function parseBoolFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

/**
 * Tri-state bool parser for upstream signals that may legitimately be absent.
 * - Missing/empty → null  ("upstream didn't run on this image")
 * - "true"/"false" / true/false → real boolean
 */
function parseTriStateBool(raw: unknown): boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
  }
  return null;
}

/** Property root row + unit config children (inventories.parent_id). */
const INVENTORY_CLUSTER_SQL = `
  SELECT
    i.id,
    i.parent_id,
    CASE
      WHEN i.parent_id IS NULL THEN 'property'
      ELSE 'config'
    END AS level,
    i.name,
    i.canonical_name,
    i.inventory_no,
    i.unit_type,
    i.status,
    i.location,
    i.description,
    i.pricing,
    i.meta,
    i.provider_id,
    i.region_id,
    i.source_link,
    i.images,
    i.videos,
    i.virtual_views
  FROM inventories i
  WHERE i.id = $1
     OR i.parent_id = $1
  ORDER BY
    CASE WHEN i.parent_id IS NULL THEN 1 ELSE 2 END,
    i.id
`;

interface InventoryClusterRow {
  id: string | number;
  parent_id: string | number | null;
  level: InventoryLevel;
  name: string;
  images: unknown;
  location?: unknown;
  description?: unknown;
  status?: string;
  unit_type?: string;
  canonical_name?: string;
  inventory_no?: string;
  pricing?: unknown;
  meta?: unknown;
  provider_id?: number;
  region_id?: number;
  source_link?: unknown;
}

/**
 * Build Amber's customer-facing URL from the inventory's canonical_name.
 * Pattern verified against amberstudent.com: /places/<canonical_name>.
 * Returns null when there's no usable slug.
 */
const AMBER_BASE_URL = 'https://amberstudent.com/places/';
function buildAmberUrl(canonicalName: unknown): string | null {
  if (typeof canonicalName !== 'string') return null;
  const slug = canonicalName.trim();
  if (!slug) return null;
  return `${AMBER_BASE_URL}${encodeURIComponent(slug)}`;
}

function parseImagesColumn(images: unknown): any[] {
  if (!images) return [];
  try {
    const parsed = typeof images === 'string' ? JSON.parse(images) : images;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeImageUrl(img: any): string | null {
  const url = img?.path || img?.base_path;
  if (typeof url !== 'string' || !url.trim()) return null;
  return url.trim();
}

export class PropertyDataReaderDB {
  /**
   * Resolve the root property inventory id. When the caller passes a config
   * child id, walk up via parent_id to the property row.
   */
  async resolveRootPropertyId(inventoryId: string): Promise<string | null> {
    const result = await db.query(
      `SELECT id, parent_id FROM inventories WHERE id = $1 LIMIT 1`,
      [inventoryId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const rootId = row.parent_id != null ? row.parent_id : row.id;
    return String(rootId);
  }

  /**
   * Fetch property row + all config children for a cluster.
   */
  private async fetchInventoryCluster(rootPropertyId: string): Promise<InventoryClusterRow[]> {
    const result = await db.query(INVENTORY_CLUSTER_SQL, [rootPropertyId]);
    return result.rows as InventoryClusterRow[];
  }

  /**
   * Get a single property by ID (property root or config child id).
   * Always returns metadata from the root property row.
   */
  async getProperty(propertyId: string): Promise<Property | null> {
    try {
      const rootId = await this.resolveRootPropertyId(propertyId);
      if (!rootId) return null;

      const cluster = await this.fetchInventoryCluster(rootId);
      if (cluster.length === 0) return null;

      const propertyRow =
        cluster.find((r) => r.level === 'property' || r.parent_id == null) ?? cluster[0];

      const mapped = this.mapRowToProperty(propertyRow);
      mapped.property_id = rootId;
      return mapped;
    } catch (error) {
      console.error('Error fetching property:', error);
      throw new Error(`Failed to fetch property ${propertyId}: ${error}`);
    }
  }

  /**
   * Get all images for a property cluster: root property media + every config child.
   * Dedupes by image URL (same asset linked on property + config).
   */
  async getPropertyImages(propertyId: string): Promise<PropertyImage[]> {
    try {
      const rootId = await this.resolveRootPropertyId(propertyId);
      if (!rootId) return [];

      const cluster = await this.fetchInventoryCluster(rootId);
      const images: PropertyImage[] = [];
      const seenUrls = new Set<string>();

      for (const row of cluster) {
        const inventoryId = String(row.id);
        const level = row.level;
        const configName = level === 'config' ? row.name : undefined;
        const imagesJson = parseImagesColumn(row.images);

        imagesJson.forEach((img: any, index: number) => {
          const imageUrl = normalizeImageUrl(img);
          if (!imageUrl) return;

          const urlKey = imageUrl.toLowerCase();
          if (seenUrls.has(urlKey)) return;
          seenUrls.add(urlKey);

          images.push({
            image_id: `${inventoryId}-img-${index}`,
            property_id: rootId,
            image_url: imageUrl,
            source_inventory_id: inventoryId,
            level,
            config_name: configName,
            category: img.type || undefined,
            uploaded_at: new Date().toISOString(),
            is_featured: parseBoolFlag(img.featured),
            upstream_blurred: parseTriStateBool(img.blurred),
            upstream_watermark_present: parseTriStateBool(img.watermark_present),
            upstream_watermark_text:
              typeof img.watermark_text === 'string' && img.watermark_text.trim()
                ? img.watermark_text
                : null,
            ignore_ai_analysis: parseBoolFlag(img.ignore_ai_analysis),
          });
        });
      }

      const propertyCount = images.filter((i) => i.level === 'property').length;
      const configCount = images.filter((i) => i.level === 'config').length;
      const configUnits = new Set(
        images.filter((i) => i.level === 'config').map((i) => i.source_inventory_id)
      ).size;
      console.log(
        `Loaded ${images.length} images for cluster ${rootId} ` +
          `(property: ${propertyCount}, configs: ${configCount} across ${configUnits} unit inventories)`
      );

      return images;
    } catch (error) {
      console.error('Error fetching property images:', error);
      throw new Error(`Failed to fetch images for property ${propertyId}: ${error}`);
    }
  }

  /**
   * Get all properties (with limit for performance) — property roots only.
   */
  async getAllProperties(limit: number = 100): Promise<Property[]> {
    try {
      const query = `
        SELECT
          id,
          name,
          location,
          status,
          description,
          images,
          canonical_name,
          inventory_no,
          unit_type,
          pricing,
          meta,
          provider_id,
          region_id,
          source_link
        FROM inventories
        WHERE status = 'active'
          AND parent_id IS NULL
        ORDER BY name
        LIMIT $1
      `;

      const result = await db.query(query, [limit]);
      return result.rows.map((row) => this.mapRowToProperty(row));
    } catch (error) {
      console.error('Error fetching all properties:', error);
      throw new Error(`Failed to fetch properties: ${error}`);
    }
  }

  /**
   * Filter properties based on criteria — property roots only.
   */
  async filterProperties(filters: PropertyFilters): Promise<Property[]> {
    try {
      const conditions: string[] = ["status = 'active'", 'parent_id IS NULL'];
      const params: any[] = [];
      let paramIndex = 1;

      if (filters.location) {
        conditions.push(`location::text ILIKE $${paramIndex}`);
        params.push(`%${filters.location}%`);
        paramIndex++;
      }

      if (filters.property_type) {
        conditions.push(`unit_type = $${paramIndex}`);
        params.push(filters.property_type);
        paramIndex++;
      }

      if (filters.status) {
        conditions[0] = `status = $${paramIndex}`;
        params.push(filters.status);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const query = `
        SELECT
          id,
          name,
          location,
          status,
          description,
          images,
          canonical_name,
          inventory_no,
          unit_type,
          pricing,
          meta,
          provider_id,
          region_id,
          source_link
        FROM inventories
        ${whereClause}
        ORDER BY name
        LIMIT 100
      `;

      const result = await db.query(query, params);
      return result.rows.map((row) => this.mapRowToProperty(row));
    } catch (error) {
      console.error('Error filtering properties:', error);
      throw new Error(`Failed to filter properties: ${error}`);
    }
  }

  /**
   * Get property count (root inventories only).
   */
  async getPropertyCount(filters?: PropertyFilters): Promise<number> {
    try {
      const conditions: string[] = ["status = 'active'", 'parent_id IS NULL'];
      const params: any[] = [];
      let paramIndex = 1;

      if (filters?.location) {
        conditions.push(`location::text ILIKE $${paramIndex}`);
        params.push(`%${filters.location}%`);
        paramIndex++;
      }

      if (filters?.property_type) {
        conditions.push(`unit_type = $${paramIndex}`);
        params.push(filters.property_type);
        paramIndex++;
      }

      if (filters?.status) {
        conditions[0] = `status = $${paramIndex}`;
        params.push(filters.status);
        paramIndex++;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const query = `
        SELECT COUNT(*) as count
        FROM inventories
        ${whereClause}
      `;

      const result = await db.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Error counting properties:', error);
      throw new Error(`Failed to count properties: ${error}`);
    }
  }

  /**
   * Total images across property cluster (property + configs, URL-deduped).
   */
  async getImageCount(propertyId: string): Promise<number> {
    const images = await this.getPropertyImages(propertyId);
    return images.length;
  }

  /**
   * Map database row to Property object.
   *
   * Beyond the legacy `location` summary string, we now surface city, country,
   * and administrative region (state/province) from the Google-Places JSON so
   * the Sheets output can give the supply team enough geographic context to
   * navigate without re-querying the DB.
   */
  private mapRowToProperty(row: any): Property {
    const locationJson = this.parseLocationJson(row.location);

    const locationStr =
      locationJson?.secondary ||
      locationJson?.primary ||
      locationJson?.name ||
      (row.location ? String(row.location) : 'Unknown');

    const city =
      locationJson?.locality?.long_name ||
      locationJson?.locality?.short_name ||
      null;
    const country =
      locationJson?.country?.long_name ||
      locationJson?.country?.short_name ||
      null;
    // `state` here is the administrative region (state/province/country
    // subdivision) from Google Places — used as a pragmatic stand-in for
    // "region" without a join against Amber's regions table.
    const region =
      locationJson?.state?.long_name ||
      locationJson?.state?.short_name ||
      locationJson?.district?.long_name ||
      null;

    const sourceUrl =
      typeof row.source_link === 'string' && row.source_link.trim()
        ? row.source_link.trim()
        : null;
    const canonicalName =
      typeof row.canonical_name === 'string' && row.canonical_name.trim()
        ? row.canonical_name.trim()
        : null;
    const amberUrl = buildAmberUrl(canonicalName);

    // Parse description array if it's a string
    let descriptionStr = '';
    if (row.description) {
      try {
        const descArray =
          typeof row.description === 'string' ? JSON.parse(row.description) : row.description;
        if (Array.isArray(descArray)) {
          descriptionStr = descArray.map((d: any) => d.value || '').join(' ');
        } else {
          descriptionStr = String(row.description);
        }
      } catch {
        descriptionStr = String(row.description);
      }
    }

    return {
      property_id: String(row.id),
      property_name: row.name || 'Unnamed Property',
      location: locationStr,
      city,
      country,
      region,
      source_url: sourceUrl,
      amber_url: amberUrl,
      canonical_name: canonicalName,
      property_type: row.unit_type || 'unknown',
      status: (row.status as Property['status']) || 'active',
      bedrooms: 0, // Not available in inventories table
      bathrooms: 0, // Not available in inventories table
      square_feet: 0, // Not available in inventories table
      description: descriptionStr,
    };
  }

  /** Robustly parse the `location` column (JSON object or stringified JSON). */
  private parseLocationJson(raw: unknown): any | null {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Test database connection
   */
  async testConnection(): Promise<boolean> {
    return await db.testConnection();
  }
}
