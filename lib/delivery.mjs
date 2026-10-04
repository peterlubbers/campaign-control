// Publication companions are explicit. Review evidence and editable projects stay private.
export const PUBLISH_ROLES = new Set(['publishable-copy', 'graphic', 'native-video', 'captions', 'thumbnail', 'publisher-metadata', 'youtube-metadata', 'native-presentation-reference', 'pdf-document']);
const PRIMARY_ROLES = new Set(['publishable-copy', 'graphic', 'native-video', 'native-presentation-reference', 'pdf-document']);

export function deliveryFiles(asset) {
  return (asset.candidateFiles || []).filter(file => PUBLISH_ROLES.has(file.role));
}

export function hasDeliverable(asset) {
  return deliveryFiles(asset).some(file => PRIMARY_ROLES.has(file.role));
}
