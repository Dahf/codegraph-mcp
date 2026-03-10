import type { ExtractedSymbols } from '../types/index.js';

/**
 * A code chunk representing a single function or class with its source text,
 * ready for embedding. Leading comments/docstrings are included.
 */
export interface CodeChunk {
  /** "className.methodName" for methods, "name" for top-level functions/classes */
  symbolName: string;
  symbolType: 'function' | 'class';
  /** Relative path within the repo */
  filePath: string;
  /** 1-indexed, adjusted to include leading comments */
  startLine: number;
  /** 1-indexed */
  endLine: number;
  language: string;
  /** Full source code of the chunk (including leading comments) */
  sourceText: string;
}

/**
 * Walk backward from a symbol's start line to include leading comments/docstrings.
 * @param lines - All lines of the source file (0-indexed array)
 * @param lineIndex - 0-based index of the symbol's first line (startLine - 1)
 * @returns 0-based index of the first leading comment line
 */
function findLeadingCommentStart(lines: string[], lineIndex: number): number {
  if (lineIndex <= 0) return 0;

  let result = lineIndex;
  let consecutiveBlanks = 0;

  for (let i = lineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();

    if (trimmed === '') {
      consecutiveBlanks++;
      // Stop at double blank lines
      if (consecutiveBlanks >= 2) break;
      continue;
    }

    // Reset blank counter on non-blank line
    consecutiveBlanks = 0;

    // Check if this line looks like a comment
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('///') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*/') ||
      trimmed.startsWith('"""') ||
      trimmed.startsWith("'''")
    ) {
      result = i;
    } else {
      // Non-comment, non-blank line -- stop
      break;
    }
  }

  return result;
}

/**
 * Extract one CodeChunk per function and per class from parsed symbols.
 * Types and imports are excluded (per locked design decision).
 *
 * @param symbols - Symbols extracted from a single file parse
 * @param sourceText - Full source text of the file
 * @param filePath - Relative path within the repo
 * @param language - Language label (typescript, python, etc.)
 * @returns Array of CodeChunks ready for embedding
 */
const MAX_CHUNK_LINES = 150;
const OVERLAP_LINES = 20;

function splitIntoChunks(
  lines: string[],
  startIdx: number,
  endIdx: number,
  symbolName: string,
  symbolType: 'function' | 'class',
  filePath: string,
  language: string,
): CodeChunk[] {
  const totalLines = endIdx - startIdx;
  if (totalLines <= MAX_CHUNK_LINES) {
    return [{
      symbolName,
      symbolType,
      filePath,
      startLine: startIdx + 1,
      endLine: endIdx,
      language,
      sourceText: lines.slice(startIdx, endIdx).join('\n'),
    }];
  }

  const chunks: CodeChunk[] = [];
  let offset = startIdx;
  let part = 1;

  while (offset < endIdx) {
    const chunkEnd = Math.min(offset + MAX_CHUNK_LINES, endIdx);
    const name = `${symbolName} [part ${part}]`;

    chunks.push({
      symbolName: name,
      symbolType,
      filePath,
      startLine: offset + 1,
      endLine: chunkEnd,
      language,
      sourceText: lines.slice(offset, chunkEnd).join('\n'),
    });

    const nextOffset = chunkEnd - OVERLAP_LINES;
    // Ensure forward progress: if overlap would stall (remaining < OVERLAP), stop
    if (nextOffset <= offset || nextOffset >= endIdx) break;
    offset = nextOffset;
    part++;
  }

  return chunks;
}

export function extractChunks(
  symbols: ExtractedSymbols,
  sourceText: string,
  filePath: string,
  language: string,
): CodeChunk[] {
  if (!sourceText) return [];

  const lines = sourceText.split('\n');
  const chunks: CodeChunk[] = [];

  for (const fn of symbols.functions) {
    const adjustedStart = findLeadingCommentStart(lines, fn.startLine - 1);
    const symbolName = fn.className ? `${fn.className}.${fn.name}` : fn.name;
    chunks.push(...splitIntoChunks(lines, adjustedStart, fn.endLine, symbolName, 'function', filePath, language));
  }

  for (const cls of symbols.classes) {
    const adjustedStart = findLeadingCommentStart(lines, cls.startLine - 1);
    chunks.push(...splitIntoChunks(lines, adjustedStart, cls.endLine, cls.name, 'class', filePath, language));
  }

  return chunks;
}
