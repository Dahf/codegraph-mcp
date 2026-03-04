/**
 * FalkorDB graph writer.
 *
 * Writes all extracted symbols and edges from an index run into FalkorDB
 * using batched MERGE upserts (UNWIND + MERGE). All writes target an
 * isolated per-repo graph named `codegraph-{repoId}`.
 *
 * Re-index strategy: delete-and-rebuild — all existing nodes and relationships
 * are removed via MATCH (n) DETACH DELETE n before writing fresh data.
 */
import type { FalkorDBAdapter } from '../adapters/falkordb.js';
import type {
  ExtractedSymbols,
  CallEdge,
  SourceFile,
} from '../types/index.js';

/** Per-file bundle of symbols passed from the pipeline */
export interface FileSymbols {
  file: SourceFile;
  symbols: ExtractedSymbols;
}

/**
 * Write all symbols and edges for one repository to FalkorDB.
 *
 * @param repoId     Repo identifier — used to name the graph and as a node property
 * @param allSymbols Array of per-file symbol bundles from the parse stage
 * @param callEdges  Resolved call edges from the two-pass resolution stage
 * @param falkorAdapter  Connected FalkorDB adapter
 * @returns Total number of edges created (CONTAINS + HAS_METHOD + CALLS)
 */
export async function writeGraph(
  repoId: string,
  allSymbols: FileSymbols[],
  callEdges: CallEdge[],
  falkorAdapter: FalkorDBAdapter,
): Promise<number> {
  const graph = falkorAdapter.selectGraph('codegraph-' + repoId);

  // ── Step 1: Clear existing data (handles both first-run and re-index) ───────
  // FalkorDB creates the graph automatically on the first query.
  // DETACH DELETE removes all nodes and their relationships.
  await graph.query('MATCH (n) DETACH DELETE n');

  // ── Step 2: Create indexes (idempotent — FalkorDB ignores duplicates) ────────
  await graph.query('CREATE INDEX FOR (f:Function) ON (f.name)');
  await graph.query('CREATE INDEX FOR (f:Function) ON (f.filePath)');
  await graph.query('CREATE INDEX FOR (c:Class) ON (c.name)');
  await graph.query('CREATE INDEX FOR (fi:File) ON (fi.path)');
  await graph.query('CREATE INDEX FOR (t:Type) ON (t.name)');

  let edgesCreated = 0;

  // ── Step 3: Per-file node writes ─────────────────────────────────────────────
  for (const { file, symbols } of allSymbols) {
    const { functions, classes, types, imports } = symbols;

    // File node
    await graph.query(
      `MERGE (f:File {path: $path, repoId: $repoId})
       ON CREATE SET f.language = $language
       ON MATCH SET  f.language = $language`,
      { params: { path: file.relativePath, repoId, language: file.language } },
    );

    // Function nodes (batch)
    if (functions.length > 0) {
      const fnList = functions.map((fn) => ({
        name: fn.name,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        signature: fn.signature,
        language: fn.language,
        // Use empty string when not a method — FalkorDB requires consistent
        // property types in MERGE keys; undefined would break the MERGE
        className: fn.className ?? '',
      }));
      await graph.query(
        `UNWIND $functions AS fn
         MERGE (f:Function {name: fn.name, filePath: fn.filePath, repoId: $repoId, className: fn.className})
         ON CREATE SET f.startLine = fn.startLine, f.endLine = fn.endLine,
                       f.signature = fn.signature, f.language = fn.language
         ON MATCH SET  f.startLine = fn.startLine, f.endLine = fn.endLine,
                       f.signature = fn.signature`,
        { params: { functions: fnList, repoId } },
      );
    }

    // Class nodes (batch)
    if (classes.length > 0) {
      const clsList = classes.map((cls) => ({
        name: cls.name,
        filePath: cls.filePath,
        startLine: cls.startLine,
        endLine: cls.endLine,
        language: cls.language,
      }));
      await graph.query(
        `UNWIND $classes AS cls
         MERGE (c:Class {name: cls.name, filePath: cls.filePath, repoId: $repoId})
         ON CREATE SET c.startLine = cls.startLine, c.endLine = cls.endLine,
                       c.language = cls.language
         ON MATCH SET  c.startLine = cls.startLine, c.endLine = cls.endLine`,
        { params: { classes: clsList, repoId } },
      );
    }

    // Type nodes (batch)
    if (types.length > 0) {
      const typeList = types.map((t) => ({
        name: t.name,
        filePath: t.filePath,
        startLine: t.startLine,
        endLine: t.endLine,
        language: t.language,
      }));
      await graph.query(
        `UNWIND $types AS t
         MERGE (ty:Type {name: t.name, filePath: t.filePath, repoId: $repoId})
         ON CREATE SET ty.startLine = t.startLine, ty.endLine = t.endLine,
                       ty.language = t.language
         ON MATCH SET  ty.startLine = t.startLine, ty.endLine = t.endLine`,
        { params: { types: typeList, repoId } },
      );
    }

    // Import nodes (batch)
    if (imports.length > 0) {
      const impList = imports.map((imp) => ({
        modulePath: imp.modulePath,
        filePath: imp.filePath,
        // FalkorDB does not support array properties in MERGE keys — serialise symbols
        symbolsJson: JSON.stringify(imp.symbols),
      }));
      await graph.query(
        `UNWIND $imports AS imp
         MERGE (i:Import {modulePath: imp.modulePath, filePath: imp.filePath, repoId: $repoId})
         ON CREATE SET i.symbols = imp.symbolsJson
         ON MATCH SET  i.symbols = imp.symbolsJson`,
        { params: { imports: impList, repoId } },
      );
    }

    // ── CONTAINS edges: File → each symbol ─────────────────────────────────

    if (functions.length > 0) {
      const fnList = functions.map((fn) => ({
        filePath: fn.filePath,
        name: fn.name,
        className: fn.className ?? '',
      }));
      await graph.query(
        `UNWIND $functions AS fn
         MATCH (file:File {path: $path, repoId: $repoId})
         MATCH (f:Function {name: fn.name, filePath: fn.filePath, repoId: $repoId, className: fn.className})
         MERGE (file)-[:CONTAINS]->(f)`,
        { params: { functions: fnList, path: file.relativePath, repoId } },
      );
      edgesCreated += functions.length;
    }

    if (classes.length > 0) {
      const clsList = classes.map((cls) => ({ name: cls.name, filePath: cls.filePath }));
      await graph.query(
        `UNWIND $classes AS cls
         MATCH (file:File {path: $path, repoId: $repoId})
         MATCH (c:Class {name: cls.name, filePath: cls.filePath, repoId: $repoId})
         MERGE (file)-[:CONTAINS]->(c)`,
        { params: { classes: clsList, path: file.relativePath, repoId } },
      );
      edgesCreated += classes.length;
    }

    if (types.length > 0) {
      const typeList = types.map((t) => ({ name: t.name, filePath: t.filePath }));
      await graph.query(
        `UNWIND $types AS t
         MATCH (file:File {path: $path, repoId: $repoId})
         MATCH (ty:Type {name: t.name, filePath: t.filePath, repoId: $repoId})
         MERGE (file)-[:CONTAINS]->(ty)`,
        { params: { types: typeList, path: file.relativePath, repoId } },
      );
      edgesCreated += types.length;
    }

    if (imports.length > 0) {
      const impList = imports.map((imp) => ({ modulePath: imp.modulePath, filePath: imp.filePath }));
      await graph.query(
        `UNWIND $imports AS imp
         MATCH (file:File {path: $path, repoId: $repoId})
         MATCH (i:Import {modulePath: imp.modulePath, filePath: imp.filePath, repoId: $repoId})
         MERGE (file)-[:CONTAINS]->(i)`,
        { params: { imports: impList, path: file.relativePath, repoId } },
      );
      edgesCreated += imports.length;
    }

    // ── HAS_METHOD edges: Class → Function (methods only) ───────────────────

    const methods = functions.filter((fn) => fn.className !== undefined && fn.className !== '');
    if (methods.length > 0 && classes.length > 0) {
      const methodList = methods.map((fn) => ({
        name: fn.name,
        filePath: fn.filePath,
        className: fn.className as string,
      }));
      await graph.query(
        `UNWIND $methods AS m
         MATCH (c:Class {name: m.className, filePath: m.filePath, repoId: $repoId})
         MATCH (f:Function {name: m.name, filePath: m.filePath, repoId: $repoId, className: m.className})
         MERGE (c)-[:HAS_METHOD]->(f)`,
        { params: { methods: methodList, repoId } },
      );
      edgesCreated += methods.length;
    }
  }

  // ── Step 4: CALLS edges (after all nodes exist) ───────────────────────────
  if (callEdges.length > 0) {
    const edgeList = callEdges.map((e) => ({
      callerName: e.callerName,
      callerFilePath: e.callerFilePath,
      calleeName: e.calleeName,
      calleeFilePath: e.calleeFilePath,
      crossFile: e.crossFile,
    }));
    await graph.query(
      `UNWIND $edges AS e
       MATCH (caller:Function {name: e.callerName, filePath: e.callerFilePath, repoId: $repoId})
       MATCH (callee:Function {name: e.calleeName, filePath: e.calleeFilePath, repoId: $repoId})
       MERGE (caller)-[r:CALLS]->(callee)
       ON CREATE SET r.crossFile = e.crossFile
       ON MATCH SET  r.crossFile = e.crossFile`,
      { params: { edges: edgeList, repoId } },
    );
    edgesCreated += callEdges.length;
  }

  return edgesCreated;
}
