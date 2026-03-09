/**
 * Embedding model used by both the indexing pipeline and query layer.
 * Must be identical in both places — mismatched models produce meaningless similarity scores.
 */
export const EMBED_MODEL = 'nomic-embed-text';
