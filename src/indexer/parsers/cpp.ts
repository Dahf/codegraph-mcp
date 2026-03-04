/**
 * C++ symbol extractor.
 *
 * Uses the TreeSitter Query API (S-expression patterns with @captures).
 * Queries are compiled once at module load time.
 *
 * Known C++ limitations:
 * - Preprocessor macros and template-heavy code may create ERROR nodes in the
 *   parse tree. Before extracting any symbol, check node.hasError (property, not
 *   method in tree-sitter@0.22.4). If true, skip and increment skippedDueToError.
 * - Log skipped count per file when skippedDueToError > 0 via console.warn.
 * - Do NOT abort parsing — continue processing the rest of the file.
 *
 * Extraction depth:
 * - function_definition (top-level, direct children of translation_unit)
 * - function_definition inside field_declaration_list (class/struct methods)
 *   with className from enclosing class_specifier or struct_specifier
 * - class_specifier with name → ClassNode
 * - struct_specifier with name → ClassNode (named structs treated same as classes)
 * - preproc_include → ImportNode
 * - TypeNode: always empty (C++ type aliases are out of scope for Phase 2)
 *
 * Line numbers are always stored as 1-indexed (TreeSitter row + 1).
 * Signature = first 200 chars of the node's source text.
 */
import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import type {
  ExtractedSymbols,
  FunctionNode,
  ClassNode,
  ImportNode,
} from '../../types/index.js';

const { Query } = Parser;

// ── Queries — compiled once at module load ────────────────────────────────────

const CPP_FUNCTION_QUERY = new Query(
  Cpp as unknown as Parser.Language,
  `(function_definition) @fn`,
);

const CPP_CLASS_QUERY = new Query(
  Cpp as unknown as Parser.Language,
  `(class_specifier name: (type_identifier) @name) @cls`,
);

const CPP_STRUCT_QUERY = new Query(
  Cpp as unknown as Parser.Language,
  `(struct_specifier name: (type_identifier) @name) @struct`,
);

const CPP_INCLUDE_QUERY = new Query(
  Cpp as unknown as Parser.Language,
  `(preproc_include) @inc`,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first 200 characters of a node's source text */
function signature(node: Parser.SyntaxNode, source: string): string {
  const len = Math.min(200, node.endIndex - node.startIndex);
  return source.slice(node.startIndex, node.startIndex + len);
}

/**
 * Check whether any ancestor of a node is an ERROR node.
 * Used to skip symbols whose parse context is broken.
 */
function hasErrorAncestor(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'ERROR') return true;
    current = current.parent;
  }
  return false;
}

/**
 * Extract the innermost identifier from a C++ function declarator chain.
 *
 * C++ function definition declarator field can be deeply nested:
 *   function_declarator → declarator: identifier
 *   function_declarator → declarator: pointer_declarator → declarator: identifier
 *   function_declarator → declarator: reference_declarator → declarator: identifier
 *   function_declarator → declarator: qualified_identifier → name: identifier
 *
 * Walk the chain recursively to find the final identifier or qualified_identifier.
 */
function extractFunctionName(fnNode: Parser.SyntaxNode): string | undefined {
  // Start from the declarator field of function_definition
  const declaratorField = fnNode.namedChildren.find(
    (c) =>
      c.type === 'function_declarator' ||
      c.type === 'pointer_declarator' ||
      c.type === 'reference_declarator' ||
      c.type === 'qualified_identifier' ||
      c.type === 'identifier' ||
      c.type === 'destructor_name' ||
      c.type === 'operator_name',
  );
  if (!declaratorField) return undefined;
  return resolveDeclaratorName(declaratorField);
}

function resolveDeclaratorName(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case 'identifier':
      return node.text;

    case 'operator_name':
    case 'destructor_name':
      return node.text;

    case 'qualified_identifier': {
      // last segment is the name: e.g., Foo::bar → "bar", Foo::~Foo → "~Foo"
      const name = node.namedChildren[node.namedChildren.length - 1];
      return name ? resolveDeclaratorName(name) : undefined;
    }

    case 'function_declarator': {
      // declarator field is the first named child
      const inner = node.namedChildren[0];
      return inner ? resolveDeclaratorName(inner) : undefined;
    }

    case 'pointer_declarator':
    case 'reference_declarator': {
      // walk past pointer/reference to find the real declarator
      const inner = node.namedChildren.find(
        (c) =>
          c.type === 'function_declarator' ||
          c.type === 'identifier' ||
          c.type === 'qualified_identifier' ||
          c.type === 'pointer_declarator' ||
          c.type === 'reference_declarator' ||
          c.type === 'destructor_name',
      );
      return inner ? resolveDeclaratorName(inner) : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Determine if a function_definition is inside a field_declaration_list.
 * Returns the enclosing class/struct name if it is a direct method, or undefined.
 *
 * Method chain: function_definition → field_declaration_list → (class_specifier | struct_specifier)
 *
 * Only direct members are included — nested class methods are excluded.
 */
function getEnclosingClassOrStructName(fnNode: Parser.SyntaxNode): string | undefined {
  const parent = fnNode.parent;
  if (!parent || parent.type !== 'field_declaration_list') return undefined;

  const container = parent.parent;
  if (!container) return undefined;
  if (container.type !== 'class_specifier' && container.type !== 'struct_specifier') {
    return undefined;
  }

  const nameChild = container.namedChildren.find((c) => c.type === 'type_identifier');
  return nameChild?.text;
}

/**
 * Determine if a function_definition is at the top level (direct child of
 * translation_unit) or inside a namespace (one level down).
 *
 * Top-level: parent is translation_unit OR parent is declaration_list (namespace body)
 * at depth 1 from translation_unit. We accept both for practical coverage.
 * Methods (inside field_declaration_list) are excluded here.
 */
function isTopLevelFunction(fnNode: Parser.SyntaxNode): boolean {
  const parent = fnNode.parent;
  if (!parent) return false;
  // Direct child of translation_unit (global scope)
  if (parent.type === 'translation_unit') return true;
  // Inside a namespace or linkage_specification at one level deep
  if (
    parent.type === 'declaration_list' ||
    parent.type === 'namespace_definition' ||
    parent.type === 'linkage_specification'
  ) {
    return true;
  }
  return false;
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a C++ (.cpp, .cc, .h, .hpp) file.
 *
 * Extracts:
 * - function_definition (top-level) → FunctionNode
 * - function_definition inside field_declaration_list → FunctionNode with className
 * - class_specifier with name → ClassNode
 * - struct_specifier with name → ClassNode (named structs)
 * - preproc_include → ImportNode
 * - TypeNode: always empty (C++ using/typedef out of scope for Phase 2)
 *
 * Nodes with hasError = true or with ERROR ancestors are skipped.
 * Count and warn about skipped nodes.
 */
export function extractCpp(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const imports: ImportNode[] = [];
  let skippedDueToError = 0;

  // ── Functions and methods ─────────────────────────────────────────────────
  for (const match of CPP_FUNCTION_QUERY.matches(tree.rootNode)) {
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!fnCapture) continue;
    const fn = fnCapture.node;

    // Skip nodes with parse errors
    if (fn.hasError || hasErrorAncestor(fn)) {
      skippedDueToError++;
      continue;
    }

    const funcName = extractFunctionName(fn);
    if (!funcName) continue;

    // Check if this is a class/struct method
    const className = getEnclosingClassOrStructName(fn);

    if (className !== undefined) {
      // Method: inside a field_declaration_list of a class/struct
      functions.push({
        name: funcName,
        filePath,
        startLine: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        signature: signature(fn, source),
        language: 'cpp',
        className,
      });
    } else if (isTopLevelFunction(fn)) {
      // Top-level function
      functions.push({
        name: funcName,
        filePath,
        startLine: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        signature: signature(fn, source),
        language: 'cpp',
      });
    }
    // Otherwise: function inside another function, template, etc. — skip
  }

  // ── Classes ───────────────────────────────────────────────────────────────
  for (const match of CPP_CLASS_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const clsCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'cls');
    if (!nameCapture || !clsCapture) continue;
    const cls = clsCapture.node;

    if (cls.hasError || hasErrorAncestor(cls)) {
      skippedDueToError++;
      continue;
    }

    classes.push({
      name: nameCapture.node.text,
      filePath,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      language: 'cpp',
    });
  }

  // ── Named structs → ClassNode ─────────────────────────────────────────────
  for (const match of CPP_STRUCT_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const structCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'struct');
    if (!nameCapture || !structCapture) continue;
    const struct = structCapture.node;

    if (struct.hasError || hasErrorAncestor(struct)) {
      skippedDueToError++;
      continue;
    }

    classes.push({
      name: nameCapture.node.text,
      filePath,
      startLine: struct.startPosition.row + 1,
      endLine: struct.endPosition.row + 1,
      language: 'cpp',
    });
  }

  // ── Includes → ImportNode ─────────────────────────────────────────────────
  for (const match of CPP_INCLUDE_QUERY.matches(tree.rootNode)) {
    const incCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'inc');
    if (!incCapture) continue;
    const inc = incCapture.node;

    if (inc.hasError || hasErrorAncestor(inc)) {
      skippedDueToError++;
      continue;
    }

    // The path child is either:
    //   string_literal        → #include "myfile.h"   (strip double quotes)
    //   system_lib_string     → #include <vector>      (strip < and >)
    const pathChild = inc.namedChildren.find(
      (c) => c.type === 'string_literal' || c.type === 'system_lib_string',
    );
    if (!pathChild) continue;

    let rawPath = pathChild.text;
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
      rawPath = rawPath.slice(1, -1);
    } else if (rawPath.startsWith('<') && rawPath.endsWith('>')) {
      rawPath = rawPath.slice(1, -1);
    }

    imports.push({
      modulePath: rawPath,
      filePath,
      symbols: [],
    });
  }

  // ── Warn about skipped nodes ───────────────────────────────────────────────
  if (skippedDueToError > 0) {
    console.warn(`[cpp] ${filePath}: skipped ${skippedDueToError} nodes due to parse errors`);
  }

  return { functions, classes, types: [], imports };
}
