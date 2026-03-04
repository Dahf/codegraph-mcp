/**
 * Go symbol extractor.
 *
 * Uses the TreeSitter Query API (S-expression patterns with @captures).
 * Queries are compiled once at module load time.
 *
 * Extraction depth:
 * - function_declaration → FunctionNode (top-level functions)
 * - method_declaration → FunctionNode with className from receiver type
 * - type_declaration containing struct_type → ClassNode
 * - type_declaration containing interface_type → TypeNode
 * - import_declaration → ImportNode
 *
 * Line numbers are always stored as 1-indexed (TreeSitter row + 1).
 * Signature = first 200 chars of the node's source text.
 *
 * Go functions and methods are inherently top-level — no depth filtering needed.
 */
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import type {
  ExtractedSymbols,
  FunctionNode,
  ClassNode,
  TypeNode,
  ImportNode,
} from '../../types/index.js';

const { Query } = Parser;

// ── Queries — compiled once at module load ────────────────────────────────────

const GO_FUNCTION_QUERY = new Query(
  Go as unknown as Parser.Language,
  `(function_declaration name: (identifier) @name) @fn`,
);

const GO_METHOD_QUERY = new Query(
  Go as unknown as Parser.Language,
  `(method_declaration name: (field_identifier) @name) @fn`,
);

const GO_TYPE_QUERY = new Query(
  Go as unknown as Parser.Language,
  `(type_declaration) @typedecl`,
);

const GO_IMPORT_QUERY = new Query(
  Go as unknown as Parser.Language,
  `(import_declaration) @imp`,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first 200 characters of a node's source text */
function signature(node: Parser.SyntaxNode, source: string): string {
  const len = Math.min(200, node.endIndex - node.startIndex);
  return source.slice(node.startIndex, node.startIndex + len);
}

/**
 * Extract the receiver type name from a method_declaration's receiver parameter_list.
 *
 * Go method receiver structure:
 *   (receiver: (parameter_list
 *     (parameter_declaration
 *       type: (type_identifier)         ← plain receiver: func (m MyType)
 *     )
 *   ))
 *   or
 *   (receiver: (parameter_list
 *     (parameter_declaration
 *       type: (pointer_type
 *         (type_identifier)             ← pointer receiver: func (m *MyType)
 *       )
 *     )
 *   ))
 *
 * Walk the first parameter_declaration's type to find the type_identifier.
 */
function getReceiverTypeName(methodNode: Parser.SyntaxNode): string | undefined {
  // receiver is a named child with field name 'receiver' or it's the first
  // parameter_list child of the method_declaration
  const receiver = methodNode.namedChildren.find((c) => c.type === 'parameter_list');
  if (!receiver) return undefined;

  // First parameter_declaration inside the receiver list
  const paramDecl = receiver.namedChildren.find((c) => c.type === 'parameter_declaration');
  if (!paramDecl) return undefined;

  // The type child of parameter_declaration
  const typeChild = paramDecl.namedChildren.find(
    (c) => c.type === 'type_identifier' || c.type === 'pointer_type' || c.type === 'qualified_type',
  );
  if (!typeChild) return undefined;

  if (typeChild.type === 'type_identifier') {
    return typeChild.text;
  }

  if (typeChild.type === 'pointer_type') {
    // pointer_type contains a type_identifier
    const inner = typeChild.namedChildren.find((c) => c.type === 'type_identifier');
    return inner?.text;
  }

  if (typeChild.type === 'qualified_type') {
    // e.g. package.TypeName — use the last type_identifier
    const inner = typeChild.namedChildren.find((c) => c.type === 'type_identifier');
    return inner?.text;
  }

  return undefined;
}

/**
 * Extract a single import_spec's modulePath and optional alias.
 *
 * import_spec structure:
 *   (import_spec path: (interpreted_string_literal))
 *   (import_spec name: (package_identifier) path: (interpreted_string_literal))
 *   (import_spec name: (dot) path: (interpreted_string_literal))
 *   (import_spec name: (blank_identifier) path: (interpreted_string_literal))
 */
function extractImportSpec(
  specNode: Parser.SyntaxNode,
  filePath: string,
): ImportNode | null {
  // Find the string path (interpreted_string_literal)
  const pathNode = specNode.namedChildren.find(
    (c) => c.type === 'interpreted_string_literal',
  );
  if (!pathNode) return null;

  // Strip surrounding double quotes from the string literal
  const rawPath = pathNode.text;
  const modulePath = rawPath.startsWith('"') && rawPath.endsWith('"')
    ? rawPath.slice(1, -1)
    : rawPath;

  // Check for alias (package_identifier, dot, or blank_identifier)
  const aliasNode = specNode.namedChildren.find(
    (c) =>
      c.type === 'package_identifier' ||
      c.type === 'dot' ||
      c.type === 'blank_identifier',
  );

  const symbols: string[] = aliasNode ? [aliasNode.text] : [];

  return { modulePath, filePath, symbols };
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a Go (.go) file.
 *
 * Extracts:
 * - function_declaration → FunctionNode (language = 'go')
 * - method_declaration → FunctionNode with className from receiver type
 * - type_declaration with struct_type → ClassNode
 * - type_declaration with interface_type → TypeNode
 * - import_declaration (single and grouped) → ImportNode[]
 */
export function extractGo(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const types: TypeNode[] = [];
  const imports: ImportNode[] = [];

  // ── Top-level functions ───────────────────────────────────────────────────
  for (const match of GO_FUNCTION_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;
    if (fn.hasError) continue;

    functions.push({
      name: nameCapture.node.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: signature(fn, source),
      language: 'go',
    });
  }

  // ── Methods ───────────────────────────────────────────────────────────────
  for (const match of GO_METHOD_QUERY.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;
    if (fn.hasError) continue;

    const className = getReceiverTypeName(fn);
    if (!className) continue;

    functions.push({
      name: nameCapture.node.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: signature(fn, source),
      language: 'go',
      className,
    });
  }

  // ── Type declarations (structs + interfaces) ──────────────────────────────
  for (const match of GO_TYPE_QUERY.matches(tree.rootNode)) {
    const declCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'typedecl');
    if (!declCapture) continue;
    const decl = declCapture.node;
    if (decl.hasError) continue;

    // type_declaration can contain one or more type_spec children
    // type_spec structure: name: type_identifier, type: struct_type | interface_type | ...
    for (const child of decl.namedChildren) {
      if (child.type !== 'type_spec') continue;
      if (child.hasError) continue;

      const nameChild = child.namedChildren.find((c) => c.type === 'type_identifier');
      if (!nameChild) continue;

      // Look for struct_type or interface_type as the value
      const typeValue = child.namedChildren.find(
        (c) => c.type === 'struct_type' || c.type === 'interface_type',
      );
      if (!typeValue) continue;

      if (typeValue.type === 'struct_type') {
        classes.push({
          name: nameChild.text,
          filePath,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          language: 'go',
        });
      } else {
        // interface_type → TypeNode
        types.push({
          name: nameChild.text,
          filePath,
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          language: 'go',
        });
      }
    }
  }

  // ── Import declarations ───────────────────────────────────────────────────
  for (const match of GO_IMPORT_QUERY.matches(tree.rootNode)) {
    const impCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'imp');
    if (!impCapture) continue;
    const imp = impCapture.node;
    if (imp.hasError) continue;

    for (const child of imp.namedChildren) {
      if (child.type === 'import_spec') {
        // Single import: import "fmt"
        const entry = extractImportSpec(child, filePath);
        if (entry) imports.push(entry);
      } else if (child.type === 'import_spec_list') {
        // Grouped import: import ( "fmt" \n "os" )
        for (const spec of child.namedChildren) {
          if (spec.type === 'import_spec') {
            const entry = extractImportSpec(spec, filePath);
            if (entry) imports.push(entry);
          }
        }
      }
    }
  }

  return { functions, classes, types, imports, callSites: [] };
}
