// A bounded text field, not model-generated markup or a general layout editor.
export const supportsReviewLabel = asset => ['page', 'copy', 'sales'].includes(asset.kind) && asset.metadata?.presentation !== true && asset.metadata?.outputFormat !== 'pdf';
export const validReviewLabel = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[<>\u0000-\u001f\u007f]/.test(value);
export const reviewLabelFor = asset => asset.candidateReviewLabel ?? asset.sourceReviewLabel ?? (asset.metadata?.presentation ? 'Presentation copy review · native Google Slides required' : `${asset.channel} · ${asset.kind}`);
