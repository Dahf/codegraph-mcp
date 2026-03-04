import Parser from 'tree-sitter';
import TypeScriptGrammar from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import Go from 'tree-sitter-go';
import Cpp from 'tree-sitter-cpp';
import type { ExtractedSymbols } from '../../types/index.js';

// Extractor function signature — implemented per-language in 02-02 and 02-03
export type ExtractorFn = (
  tree: Parser.Tree,
  source: string,
  filePath: string
) => ExtractedSymbols;

export interface LanguageConfig {
  /** tree-sitter grammar object passed to parser.setLanguage() */
  grammar: object;
  /** Language label stored on graph nodes */
  language: string;
  /** Populated by 02-02 and 02-03 — stub throws until implemented */
  extractor: ExtractorFn;
}

/** Stub extractor used until real implementations are installed in 02-02 / 02-03 */
function notImplemented(language: string): ExtractorFn {
  return () => {
    throw new Error(`Extractor for ${language} not yet implemented`);
  };
}

/**
 * Grammar modules declare `language: unknown` for version-agnosticism but at
 * runtime they ARE valid Parser.Language objects. Cast via unknown to satisfy
 * the strict TypeScript compiler.
 */
function asLang(grammar: object): Parser.Language {
  return grammar as unknown as Parser.Language;
}

/**
 * One Parser instance per language — NEVER create inside the file loop.
 * Each grammar is set once at module load time (expensive operation).
 */
const tsParser = new Parser();
tsParser.setLanguage(asLang(TypeScriptGrammar.typescript));

const tsxParser = new Parser();
tsxParser.setLanguage(asLang(TypeScriptGrammar.tsx));

const jsParser = new Parser();
jsParser.setLanguage(asLang(JavaScript));

const pyParser = new Parser();
pyParser.setLanguage(asLang(Python));

const rsParser = new Parser();
rsParser.setLanguage(asLang(Rust));

const goParser = new Parser();
goParser.setLanguage(asLang(Go));

const cppParser = new Parser();
cppParser.setLanguage(asLang(Cpp));

export const PARSERS: Record<string, Parser> = {
  typescript: tsParser,
  tsx: tsxParser,
  javascript: jsParser,
  python: pyParser,
  rust: rsParser,
  go: goParser,
  cpp: cppParser,
};

export const LANGUAGE_REGISTRY: Record<string, LanguageConfig> = {
  '.ts':  { grammar: TypeScriptGrammar.typescript, language: 'typescript', extractor: notImplemented('typescript') },
  '.tsx': { grammar: TypeScriptGrammar.tsx,         language: 'tsx',        extractor: notImplemented('tsx') },
  '.js':  { grammar: JavaScript,                    language: 'javascript', extractor: notImplemented('javascript') },
  '.mjs': { grammar: JavaScript,                    language: 'javascript', extractor: notImplemented('javascript') },
  '.py':  { grammar: Python,                        language: 'python',     extractor: notImplemented('python') },
  '.rs':  { grammar: Rust,                          language: 'rust',       extractor: notImplemented('rust') },
  '.go':  { grammar: Go,                            language: 'go',         extractor: notImplemented('go') },
  '.cpp': { grammar: Cpp,                           language: 'cpp',        extractor: notImplemented('cpp') },
  '.cc':  { grammar: Cpp,                           language: 'cpp',        extractor: notImplemented('cpp') },
  '.h':   { grammar: Cpp,                           language: 'cpp',        extractor: notImplemented('cpp') },
  '.hpp': { grammar: Cpp,                           language: 'cpp',        extractor: notImplemented('cpp') },
};
