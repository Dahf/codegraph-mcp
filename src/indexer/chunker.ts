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
export function extractChunks(
  symbols: ExtractedSymbols,
  sourceText: string,
  filePath: string,
  language: string,
): CodeChunk[] {
  if (!sourceText) return [];

  const lines = sourceText.split('\n');
  const chunks: CodeChunk[] = [];

  // One chunk per function
  for (const fn of symbols.functions) {
    const adjustedStart = findLeadingCommentStart(lines, fn.startLine - 1);
    const text = lines.slice(adjustedStart, fn.endLine).join('\n');
    const symbolName = fn.className ? `${fn.className}.${fn.name}` : fn.name;

    chunks.push({
      symbolName,
      symbolType: 'function',
      filePath,
      startLine: adjustedStart + 1, // back to 1-indexed
      endLine: fn.endLine,
      language,
      sourceText: text,
    });
  }

  // One chunk per class
  for (const cls of symbols.classes) {
    const adjustedStart = findLeadingCommentStart(lines, cls.startLine - 1);
    const text = lines.slice(adjustedStart, cls.endLine).join('\n');

    chunks.push({
      symbolName: cls.name,
      symbolType: 'class',
      filePath,
      startLine: adjustedStart + 1,
      endLine: cls.endLine,
      language,
      sourceText: text,
    });
  }

  return chunks;
}
