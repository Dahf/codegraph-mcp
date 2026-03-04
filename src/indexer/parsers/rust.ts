/**
 * Rust symbol extractor.
 *
 * Uses the TreeSitter Query API (S-expression patterns with @captures) for most
 * symbol extraction. Impl methods use tree traversal for reliable extraction of
 * the impl type name alongside its contained function items.
 *
 * Extraction depth:
 * - Top-level function_item nodes (not nested inside other function_item)
 * - Methods inside impl_item blocks (function_item children of declaration_list)
 * - struct_item → ClassNode
 * - type_item → TypeNode
 * - use_declaration → ImportNode
 *
 * Line numbers are always stored as 1-indexed (TreeSitter row + 1).
 * Signature = first 200 chars of the node's source text.
 */
import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import type {
  ExtractedSymbols,
  FunctionNode,
  ClassNode,
  TypeNode,
  ImportNode,
} from '../../types/index.js';

const { Query } = Parser;

// ── Queries — compiled once at module load ────────────────────────────────────

const RS_FUNCTION_QUERY = new Query(
  Rust as unknown as Parser.Language,
  `(function_item name: (identifier) @name) @fn`,
);

const RS_IMPL_QUERY = new Query(
  Rust as unknown as Parser.Language,
  `(impl_item) @impl`,
);

const RS_STRUCT_QUERY = new Query(
  Rust as unknown as Parser.Language,
  `(struct_item name: (type_identifier) @name) @struct`,
);

const RS_TYPE_QUERY = new Query(
  Rust as unknown as Parser.Language,
  `(type_item name: (type_identifier) @name) @type`,
);

const RS_USE_QUERY = new Query(
  Rust as unknown as Parser.Language,
  `(use_declaration argument: (_) @path) @use`,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first 200 characters of a node's source text */
function signature(node: Parser.SyntaxNode, source: string): string {
  const len = Math.min(200, node.endIndex - node.startIndex);
  return source.slice(node.startIndex, node.startIndex + len);
}

/**
 * Check whether any ancestor of the given node is a function_item.
 * Used to enforce top-level depth limit for functions.
 */
function hasAncestorFunctionItem(node: Parser.SyntaxNode): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'function_item') return true;
    current = current.parent;
  }
  return false;
}

/**
 * Extract the impl type name from an impl_item node.
 *
 * impl_item structure varies:
 *   impl TypeName { ... }               → type_identifier child
 *   impl<T> TypeName<T> { ... }         → type_identifier child (after generic)
 *   impl TraitName for TypeName { ... } → last type_identifier before body
 *
 * Strategy: find the last type_identifier child that appears before the
 * declaration_list (body). This handles both plain impls and trait impls.
 */
function getImplTypeName(implNode: Parser.SyntaxNode): string | undefined {
  const body = implNode.namedChildren.find((c) => c.type === 'declaration_list');
  if (!body) return undefined;

  // Collect all type_identifier children that appear before the body
  const typeNames: Parser.SyntaxNode[] = [];
  for (const child of implNode.namedChildren) {
    if (child === body) break;
    if (child.type === 'type_identifier') {
      typeNames.push(child);
    }
    // Also look inside generic_type nodes: impl Vec<T> → generic_type contains type_identifier
    if (child.type === 'generic_type') {
      const inner = child.namedChildren.find((c) => c.type === 'type_identifier');
      if (inner) typeNames.push(inner);
    }
  }

  // For `impl Trait for Type`, the last type_identifier is the implementing type
  // For `impl Type`, there's only one
  if (typeNames.length === 0) return undefined;
  return typeNames[typeNames.length - 1].text;
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a Rust (.rs) file.
 *
 * Extracts:
 * - Top-level function_item nodes (not nested inside other function_item)
 * - Methods: function_item children of impl_item's declaration_list, with
 *   className set to the impl's type name
 * - struct_item → ClassNode
 * - type_item → TypeNode (type alias)
 * - use_declaration → ImportNode (modulePath = full use path, symbols = [])
 */
export function extractRust(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const types: TypeNode[] = [];
  const imports: ImportNode[] = [];

  // Set of function_item nodes that are inside impl blocks — tracked to avoid
  // double-counting them as top-level functions
  const implMethodNodes = new Set<Parser.SyntaxNode>();

  // ── Impl methods ─────────────────────────────────────────────────────────
  for (const match of RS_IMPL_QUERY.matches(tree.rootNode)) {
    const implCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'impl');
    if (!implCapture) continue;
    const implNode = implCapture.node;
    if (implNode.hasError) continue;

    const className = getImplTypeName(implNode);
    if (!className) continue;

    // Walk the declaration_list (body) for direct function_item children
    const body = implNode.namedChildren.find((c) => c.type === 'declaration_list');
    if (!body) continue;

    for (const child of body.namedChildren) {
      if (child.type !== 'function_item') continue;
      if (child.hasError) continue;

      implMethodNodes.add(child);

      const nameChild = child.namedChildren.find((c) => c.type === 'identifier');
      if (!nameChild) continue;

      functions.push({
        name: nameChild.text,
        filePath,
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        signature: signature(child, source),
        language: 'rust',
        className,
      });
    }
  }

  // ── Top-level functions ───────────────────────────────────────────────────
  for (const match of RS_FUNCTION_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;

    // Skip impl methods (already collected above)
    if (implMethodNodes.has(fn)) continue;

    // Skip functions nested inside other function_item nodes
    if (hasAncestorFunctionItem(fn)) continue;

    if (fn.hasError) continue;

    functions.push({
      name: nameCapture.node.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: signature(fn, source),
      language: 'rust',
    });
  }

  // ── Structs → ClassNode ───────────────────────────────────────────────────
  for (const match of RS_STRUCT_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const structCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'struct');
    if (!nameCapture || !structCapture) continue;
    const struct = structCapture.node;
    if (struct.hasError) continue;

    classes.push({
      name: nameCapture.node.text,
      filePath,
      startLine: struct.startPosition.row + 1,
      endLine: struct.endPosition.row + 1,
      language: 'rust',
    });
  }

  // ── Type aliases → TypeNode ───────────────────────────────────────────────
  for (const match of RS_TYPE_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const typeCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'type');
    if (!nameCapture || !typeCapture) continue;
    const typeNode = typeCapture.node;
    if (typeNode.hasError) continue;

    types.push({
      name: nameCapture.node.text,
      filePath,
      startLine: typeNode.startPosition.row + 1,
      endLine: typeNode.endPosition.row + 1,
      language: 'rust',
    });
  }

  // ── Use declarations → ImportNode ─────────────────────────────────────────
  for (const match of RS_USE_QUERY.matches(tree.rootNode)) {
    const pathCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'path');
    if (!pathCapture) continue;
    const pathNode = pathCapture.node;

    // Skip use declarations that are errors
    const useCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'use');
    if (useCapture && useCapture.node.hasError) continue;

    // modulePath = full text of the use_tree argument (e.g., "std::collections::HashMap")
    imports.push({
      modulePath: pathNode.text,
      filePath,
      symbols: [],
    });
  }

  return { functions, classes, types, imports, callSites: [] };
}
