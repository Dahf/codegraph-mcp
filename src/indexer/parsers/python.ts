/**
 * Python symbol extractor.
 *
 * Uses the TreeSitter Query API (S-expression patterns with @captures) for all
 * symbol extraction. Queries are compiled once at module load time.
 *
 * Extraction depth: top-level functions + top-level classes + direct methods of
 * those classes. Inner functions (nested inside functions) are skipped.
 *
 * Line numbers are always stored as 1-indexed (TreeSitter row + 1).
 * Python has no type alias syntax in the TreeSitter grammar — types: [] always.
 */
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type {
  ExtractedSymbols,
  FunctionNode,
  ClassNode,
  ImportNode,
} from '../../types/index.js';

const { Query } = Parser;

// ── Queries — compiled once at module load ────────────────────────────────────

const PY_FUNCTION_QUERY = new Query(
  Python as unknown as Parser.Language,
  `(function_definition name: (identifier) @name) @fn`,
);

const PY_CLASS_QUERY = new Query(
  Python as unknown as Parser.Language,
  `(class_definition name: (identifier) @name) @cls`,
);

const PY_IMPORT_QUERY = new Query(
  Python as unknown as Parser.Language,
  `(import_statement) @imp`,
);

const PY_IMPORT_FROM_QUERY = new Query(
  Python as unknown as Parser.Language,
  `(import_from_statement) @imp`,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first 200 characters of a node's source text */
function signature(node: Parser.SyntaxNode, source: string): string {
  const len = Math.min(200, node.endIndex - node.startIndex);
  return source.slice(node.startIndex, node.startIndex + len);
}

/**
 * Determine if a function_definition node is a top-level function.
 * Top-level: direct child of the module (parent.type === 'module').
 */
function isTopLevel(fnNode: Parser.SyntaxNode): boolean {
  return fnNode.parent?.type === 'module';
}

/**
 * Determine if a function_definition node is a direct method of a class.
 * Method chain: function_definition → block → class_definition
 *
 * The block parent must have type 'class_definition' to confirm it's a direct
 * class method. Inner functions (function inside function inside class) have a
 * block whose parent is another function_definition.
 */
function getEnclosingClassName(fnNode: Parser.SyntaxNode): string | undefined {
  // parent should be 'block'
  const block = fnNode.parent;
  if (!block || block.type !== 'block') return undefined;
  // grandparent should be 'class_definition'
  const classDefn = block.parent;
  if (!classDefn || classDefn.type !== 'class_definition') return undefined;
  // get the class name (first identifier child)
  const nameChild = classDefn.namedChildren.find((c) => c.type === 'identifier');
  return nameChild?.text;
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a Python (.py) file.
 *
 * Extracts:
 * - Top-level function_definition nodes (parent is module)
 * - Direct methods of class_definition nodes (parent chain: block → class_definition)
 * - class_definition nodes
 * - import_statement (import X) and import_from_statement (from X import Y)
 *
 * TypeNode is always empty — Python has no type alias syntax in tree-sitter-python.
 */
export function extractPython(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const imports: ImportNode[] = [];

  // ── Functions and methods ─────────────────────────────────────────────────
  for (const match of PY_FUNCTION_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;
    if (fn.hasError) continue;

    if (isTopLevel(fn)) {
      // Top-level function
      functions.push({
        name: nameCapture.node.text,
        filePath,
        startLine: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        signature: signature(fn, source),
        language: 'python',
      });
    } else {
      // Check if it's a direct class method
      const className = getEnclosingClassName(fn);
      if (className !== undefined) {
        functions.push({
          name: nameCapture.node.text,
          filePath,
          startLine: fn.startPosition.row + 1,
          endLine: fn.endPosition.row + 1,
          signature: signature(fn, source),
          language: 'python',
          className,
        });
      }
      // Inner functions (closures, nested functions) are skipped
    }
  }

  // ── Classes ───────────────────────────────────────────────────────────────
  for (const match of PY_CLASS_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const clsCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'cls');
    if (!nameCapture || !clsCapture) continue;
    const cls = clsCapture.node;
    if (cls.hasError) continue;
    classes.push({
      name: nameCapture.node.text,
      filePath,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      language: 'python',
    });
  }

  // ── import_statement (import X, import X.Y) ───────────────────────────────
  for (const match of PY_IMPORT_QUERY.matches(tree.rootNode)) {
    const impCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'imp');
    if (!impCapture) continue;
    const imp = impCapture.node;
    if (imp.hasError) continue;

    // Each named child is a dotted_name — collect all as imported symbols
    // e.g., `import os` → modulePath='os', symbols=['os']
    // e.g., `import sys.path` → modulePath='sys.path', symbols=['sys.path']
    // For multiple names: `import os, sys` → two separate import_statement nodes in Python
    const dotNames = imp.namedChildren.filter((c) => c.type === 'dotted_name');
    for (const dotName of dotNames) {
      imports.push({
        modulePath: dotName.text,
        filePath,
        symbols: [dotName.text],
      });
    }
  }

  // ── import_from_statement (from X import Y, Z) ───────────────────────────
  for (const match of PY_IMPORT_FROM_QUERY.matches(tree.rootNode)) {
    const impCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'imp');
    if (!impCapture) continue;
    const imp = impCapture.node;
    if (imp.hasError) continue;

    // Structure: first dotted_name child = module, remaining dotted_name children = symbols
    // e.g., `from os import path, getcwd` → module='os', symbols=['path', 'getcwd']
    const dotNames = imp.namedChildren.filter((c) => c.type === 'dotted_name');
    if (dotNames.length === 0) continue;

    const moduleNode = dotNames[0];
    const modulePath = moduleNode.text;
    // All remaining dotted_name children are the imported symbols
    const symbols = dotNames.slice(1).map((c) => c.text);

    imports.push({ modulePath, filePath, symbols });
  }

  return { functions, classes, types: [], imports, callSites: [] };
}
