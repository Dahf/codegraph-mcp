/**
 * TypeScript and JavaScript symbol extractors.
 *
 * Uses the TreeSitter Query API (S-expression patterns with @captures) for all
 * symbol extraction — manual tree traversal is intentionally avoided.
 *
 * Queries are compiled once at module load time and reused across all files.
 * Line numbers are always stored as 1-indexed (TreeSitter row + 1).
 */
import Parser from 'tree-sitter';
import TypeScriptGrammar from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import type {
  ExtractedSymbols,
  FunctionNode,
  ClassNode,
  TypeNode,
  ImportNode,
} from '../../types/index.js';

const { Query } = Parser;

// ── TypeScript queries — compiled once against the TypeScript grammar ──────────

const TS_FUNCTION_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(function_declaration name: (identifier) @name) @fn`,
);

const TS_ARROW_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(variable_declarator name: (identifier) @name value: (arrow_function) @fn)`,
);

const TS_METHOD_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(method_definition name: (property_identifier) @name) @fn`,
);

const TS_CLASS_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(class_declaration name: (type_identifier) @name) @cls`,
);

const TS_INTERFACE_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(interface_declaration name: (type_identifier) @name) @iface`,
);

const TS_TYPE_ALIAS_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(type_alias_declaration name: (type_identifier) @name) @type`,
);

const TS_IMPORT_QUERY = new Query(
  TypeScriptGrammar.typescript as unknown as Parser.Language,
  `(import_statement) @imp`,
);

// ── TSX queries — compiled once against the TSX grammar ───────────────────────

const TSX_FUNCTION_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(function_declaration name: (identifier) @name) @fn`,
);

const TSX_ARROW_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(variable_declarator name: (identifier) @name value: (arrow_function) @fn)`,
);

const TSX_METHOD_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(method_definition name: (property_identifier) @name) @fn`,
);

const TSX_CLASS_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(class_declaration name: (type_identifier) @name) @cls`,
);

const TSX_INTERFACE_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(interface_declaration name: (type_identifier) @name) @iface`,
);

const TSX_TYPE_ALIAS_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(type_alias_declaration name: (type_identifier) @name) @type`,
);

const TSX_IMPORT_QUERY = new Query(
  TypeScriptGrammar.tsx as unknown as Parser.Language,
  `(import_statement) @imp`,
);

// ── JavaScript queries — compiled once against the JavaScript grammar ──────────

// Note: In JavaScript, class names use `identifier` not `type_identifier`
const JS_FUNCTION_QUERY = new Query(
  JavaScript as unknown as Parser.Language,
  `(function_declaration name: (identifier) @name) @fn`,
);

const JS_ARROW_QUERY = new Query(
  JavaScript as unknown as Parser.Language,
  `(variable_declarator name: (identifier) @name value: (arrow_function) @fn)`,
);

const JS_METHOD_QUERY = new Query(
  JavaScript as unknown as Parser.Language,
  `(method_definition name: (property_identifier) @name) @fn`,
);

const JS_CLASS_QUERY = new Query(
  JavaScript as unknown as Parser.Language,
  `(class_declaration name: (identifier) @name) @cls`,
);

const JS_IMPORT_QUERY = new Query(
  JavaScript as unknown as Parser.Language,
  `(import_statement) @imp`,
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the first 200 characters of a node's source text */
function signature(node: Parser.SyntaxNode, source: string): string {
  const len = Math.min(200, node.endIndex - node.startIndex);
  return source.slice(node.startIndex, node.startIndex + len);
}

/**
 * Walk up the ancestor chain to find the enclosing class_declaration's name.
 * Returns undefined when the method is not directly inside a class (one level).
 *
 * Allowed ancestor chain: method_definition → class_body → class_declaration
 * Anything else (e.g., method inside inner class) is excluded.
 */
function findEnclosingClassName(methodNode: Parser.SyntaxNode): string | undefined {
  // parent should be class_body
  const classBody = methodNode.parent;
  if (!classBody || classBody.type !== 'class_body') return undefined;
  // grandparent should be class_declaration
  const classDecl = classBody.parent;
  if (!classDecl || classDecl.type !== 'class_declaration') return undefined;
  // get the name child
  const nameChild = classDecl.namedChildren.find(
    (c) => c.type === 'type_identifier' || c.type === 'identifier',
  );
  return nameChild?.text;
}

/**
 * Parse the symbols array from an import_clause node.
 *
 * Rules:
 * - named_imports: extract each import_specifier's text
 * - namespace_import (* as X): return ['*']
 * - identifier (default import): return [identifier.text]
 * - mixed (default + named): combine the above
 * - no import_clause (side-effect): return []
 */
function parseImportClauseSymbols(importClauseNode: Parser.SyntaxNode | null): string[] {
  if (!importClauseNode) return [];

  const symbols: string[] = [];
  for (const child of importClauseNode.namedChildren) {
    if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_specifier') {
          // The first named child of import_specifier is the imported name
          const specName = spec.namedChildren[0];
          if (specName) symbols.push(specName.text);
        }
      }
    } else if (child.type === 'namespace_import') {
      symbols.push('*');
    } else if (child.type === 'identifier') {
      // Default import
      symbols.push(child.text);
    }
  }
  return symbols;
}

/**
 * Extract the module path (string content, without quotes) from an import_statement node.
 */
function parseModulePath(importNode: Parser.SyntaxNode): string {
  // The string node is a named child with type 'string'
  const stringNode = importNode.namedChildren.find((c) => c.type === 'string');
  if (!stringNode) return '';
  // string_fragment holds the actual text without quotes
  const fragment = stringNode.namedChildren.find((c) => c.type === 'string_fragment');
  return fragment ? fragment.text : stringNode.text;
}

// ── Core extraction implementation ────────────────────────────────────────────

interface QuerySet {
  functionQuery: Parser.Query;
  arrowQuery: Parser.Query;
  methodQuery: Parser.Query;
  classQuery: Parser.Query;
  interfaceQuery?: Parser.Query;
  typeAliasQuery?: Parser.Query;
  importQuery: Parser.Query;
  language: string;
}

function extractSymbols(
  tree: Parser.Tree,
  source: string,
  filePath: string,
  queries: QuerySet,
): ExtractedSymbols {
  const functions: FunctionNode[] = [];
  const classes: ClassNode[] = [];
  const types: TypeNode[] = [];
  const imports: ImportNode[] = [];

  // ── Functions (function_declaration) ───────────────────────────────────────
  for (const match of queries.functionQuery.matches(tree.rootNode)) {
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
      language: queries.language,
    });
  }

  // ── Arrow functions (variable_declarator with arrow_function value) ─────────
  for (const match of queries.arrowQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;
    if (fn.hasError) continue;
    // Only include module-scope arrow functions (parent chain: variable_declarator → lexical_declaration → program)
    const varDeclarator = fn.parent;
    const declaration = varDeclarator?.parent;
    const scope = declaration?.parent;
    if (!scope || scope.type !== 'program') continue;
    functions.push({
      name: nameCapture.node.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: signature(fn, source),
      language: queries.language,
    });
  }

  // ── Methods (method_definition inside class_body) ───────────────────────────
  for (const match of queries.methodQuery.matches(tree.rootNode)) {
    const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
    const fnCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'fn');
    if (!nameCapture || !fnCapture) continue;
    const fn = fnCapture.node;
    if (fn.hasError) continue;
    const className = findEnclosingClassName(fn);
    if (className === undefined) continue; // skip methods not directly inside a class_declaration
    functions.push({
      name: nameCapture.node.text,
      filePath,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      signature: signature(fn, source),
      language: queries.language,
      className,
    });
  }

  // ── Classes ─────────────────────────────────────────────────────────────────
  for (const match of queries.classQuery.matches(tree.rootNode)) {
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
      language: queries.language,
    });
  }

  // ── Interfaces (TypeScript only) ────────────────────────────────────────────
  if (queries.interfaceQuery) {
    for (const match of queries.interfaceQuery.matches(tree.rootNode)) {
      const nameCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'name');
      const ifaceCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'iface');
      if (!nameCapture || !ifaceCapture) continue;
      const iface = ifaceCapture.node;
      if (iface.hasError) continue;
      types.push({
        name: nameCapture.node.text,
        filePath,
        startLine: iface.startPosition.row + 1,
        endLine: iface.endPosition.row + 1,
        language: queries.language,
      });
    }
  }

  // ── Type aliases (TypeScript only) ─────────────────────────────────────────
  if (queries.typeAliasQuery) {
    for (const match of queries.typeAliasQuery.matches(tree.rootNode)) {
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
        language: queries.language,
      });
    }
  }

  // ── Imports ─────────────────────────────────────────────────────────────────
  for (const match of queries.importQuery.matches(tree.rootNode)) {
    const impCapture = match.captures.find((c: Parser.QueryCapture) => c.name === 'imp');
    if (!impCapture) continue;
    const imp = impCapture.node;
    if (imp.hasError) continue;

    const modulePath = parseModulePath(imp);
    if (!modulePath) continue;

    const importClauseNode = imp.namedChildren.find((c) => c.type === 'import_clause') ?? null;
    const symbols = parseImportClauseSymbols(importClauseNode);

    imports.push({ modulePath, filePath, symbols });
  }

  return { functions, classes, types, imports, callSites: [] };
}

// ── Public extractor functions ────────────────────────────────────────────────

/**
 * Extract symbols from a TypeScript (.ts) file.
 * Handles: function_declaration, arrow_function (module-scope), method_definition,
 * class_declaration, interface_declaration, type_alias_declaration, import_statement.
 */
export function extractTypeScript(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  return extractSymbols(tree, source, filePath, {
    functionQuery: TS_FUNCTION_QUERY,
    arrowQuery: TS_ARROW_QUERY,
    methodQuery: TS_METHOD_QUERY,
    classQuery: TS_CLASS_QUERY,
    interfaceQuery: TS_INTERFACE_QUERY,
    typeAliasQuery: TS_TYPE_ALIAS_QUERY,
    importQuery: TS_IMPORT_QUERY,
    language: 'typescript',
  });
}

/**
 * Extract symbols from a TypeScript JSX (.tsx) file.
 * Uses the TSX grammar with the same extractor logic as TypeScript.
 */
export function extractTsx(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  return extractSymbols(tree, source, filePath, {
    functionQuery: TSX_FUNCTION_QUERY,
    arrowQuery: TSX_ARROW_QUERY,
    methodQuery: TSX_METHOD_QUERY,
    classQuery: TSX_CLASS_QUERY,
    interfaceQuery: TSX_INTERFACE_QUERY,
    typeAliasQuery: TSX_TYPE_ALIAS_QUERY,
    importQuery: TSX_IMPORT_QUERY,
    language: 'tsx',
  });
}

/**
 * Extract symbols from a JavaScript (.js, .mjs) file.
 * Handles: function_declaration, arrow_function (module-scope), method_definition,
 * class_declaration, import_statement. No TypeScript-specific types (interfaces, type aliases).
 */
export function extractJavaScript(
  tree: Parser.Tree,
  source: string,
  filePath: string,
): ExtractedSymbols {
  return extractSymbols(tree, source, filePath, {
    functionQuery: JS_FUNCTION_QUERY,
    arrowQuery: JS_ARROW_QUERY,
    methodQuery: JS_METHOD_QUERY,
    classQuery: JS_CLASS_QUERY,
    importQuery: JS_IMPORT_QUERY,
    language: 'javascript',
  });
}
