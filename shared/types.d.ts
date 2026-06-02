export interface Property {
    property_id: string;
    property_name: string;
    location: string;
    property_type: string;
    status: 'active' | 'inactive' | 'draft';
    bedrooms?: number;
    bathrooms?: number;
    square_feet?: number;
    description?: string;
}
export interface PropertyImage {
    image_id: string;
    property_id: string;
    image_url: string;
    category?: string;
    uploaded_at?: string;
}
export interface ImageQualityResult {
    resolution: {
        width: number;
        height: number;
    };
    blur: number;
    sharpness: number;
    passed: boolean;
}
export interface WatermarkResult {
    detected: boolean;
    confidence: number;
    text?: string;
}
export interface CategoryResult {
    primary: string;
    confidence: number;
    alternatives?: string[];
}
export interface ImageAnalysisResult {
    imageId: string;
    imageUrl: string;
    imageHash?: string;
    quality?: ImageQualityResult;
    watermark?: WatermarkResult;
    category?: CategoryResult;
    isDuplicate?: boolean;
    duplicateOf?: string;
    similarity?: number;
}
export interface AuditIssue {
    severity: 'critical' | 'warning' | 'info';
    category: string;
    description: string;
    recommendation?: string;
    imageId?: string;
}
export interface AuditSummary {
    totalImages: number;
    criticalIssues: number;
    warnings: number;
    passedImages: number;
}
export interface AuditResult {
    auditId: string;
    timestamp: string;
    propertyId: string;
    propertyName: string;
    qualityScore: number;
    imageResults: ImageAnalysisResult[];
    issues: AuditIssue[];
    summary: AuditSummary;
}
export interface AuditOptions {
    checks?: ('quality' | 'watermark' | 'category')[];
    includeImages?: boolean;
}
export interface BulkAuditJob {
    jobId: string;
    totalProperties: number;
    status: 'queued' | 'in_progress' | 'completed' | 'failed';
}
export interface BulkAuditStatus {
    jobId: string;
    total: number;
    completed: number;
    inProgress: number;
    failed: number;
    estimatedTimeRemaining?: number;
    status: 'queued' | 'in_progress' | 'completed' | 'failed';
}
export interface BulkAuditSummary {
    jobId: string;
    totalProperties: number;
    averageQualityScore: number;
    totalIssues: number;
    issueBreakdown: {
        critical: number;
        warning: number;
        info: number;
    };
    results: Array<{
        propertyId: string;
        propertyName: string;
        qualityScore: number;
        criticalIssues: number;
        warnings: number;
    }>;
}
export interface PropertyFilters {
    location?: string;
    property_type?: string;
    status?: string;
}
//# sourceMappingURL=types.d.ts.map