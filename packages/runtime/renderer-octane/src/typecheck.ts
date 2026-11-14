import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveEffectTsrsCompiler } from '@modern-js/app-tools-extensions/build-config';
import {
  type CodeInformation,
  type Mapping,
  SourceMap,
  shouldReportDiagnostics,
} from '@volar/language-core';
import {
  findNodeAtLocation,
  getNodeValue,
  type ParseError,
  parse,
  parseTree,
} from 'jsonc-parser';
import { compileToVolarMappings } from 'octane/compiler/volar';
import { typescriptVersion } from 'tsrs';
import { type FileSystemCallbacks, serverFS } from 'tsrs/fs';
import { API, type Diagnostic } from 'tsrs/sync';

export interface OctaneTypeDiagnostic {
  fileName?: string;
  pos: number;
  end: number;
  line?: number;
  column?: number;
  code: number | string;
  source?: string;
  category: 'error' | 'warning' | 'message';
  text: string;
  origin: 'typescript' | 'octane' | 'projection';
  relatedInformation?: OctaneTypeDiagnostic[];
}

export interface OctaneTypecheckResult {
  compilerVersion: string;
  files: string[];
  diagnostics: OctaneTypeDiagnostic[];
}

export interface OctaneTypecheckOptions {
  project: string;
  cwd?: string;
  compilerOptions?: Record<string, unknown>;
}

interface TextProjection {
  fileName: string;
  source: string;
  code: string;
  map: SourceMap<CodeInformation>;
}
type Projection = Pick<
  ReturnType<typeof compileToVolarMappings>,
  'errors' | 'diagnostics'
> &
  TextProjection;

const nativeExtension = /\.tsrx$/u;
const projectedExtension = /\.tsrx\.tsx$/u;

function location(source: string, pos: number) {
  const prefix = source.slice(0, pos);
  const lines = prefix.split(/\r\n|\r|\n/u);
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function readFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return undefined;
    throw error;
  }
}

/** Only filename fields change; native TypeScript owns config inheritance and globs. */
function projectConfig(
  source: string,
  fileName: string,
  discovery: 'ordinary' | 'native' | 'complete',
  roots?: readonly string[],
): TextProjection | undefined {
  const errors: ParseError[] = [];
  const config = parseTree(source.replace(/^\uFEFF/u, ' '), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !config || config.type !== 'object') return undefined;
  const edits: { offset: number; length: number; content: string }[] = [];
  const additions: string[] = [];
  for (const field of ['files', 'include', 'exclude']) {
    const array = findNodeAtLocation(config, [field]);
    if (roots) {
      const content = JSON.stringify(field === 'files' ? roots : []);
      if (!array) additions.push(`${JSON.stringify(field)}:${content}`);
      else if (
        array.type === 'array' &&
        (array.children ?? []).every(node => node.type === 'string')
      )
        edits.push({ offset: array.offset, length: array.length, content });
      continue;
    }
    if (array?.type !== 'array') continue;
    for (const node of array.children ?? []) {
      const file = getNodeValue(node);
      if (typeof file !== 'string') continue;
      const projected =
        field === 'files' || discovery === 'complete'
          ? nativeExtension.test(file)
            ? `${file}.tsx`
            : file
          : discovery === 'native' &&
              /[.*?]/u.test(file.replaceAll('\\', '/').split('/').at(-1) ?? '')
            ? `${file.endsWith('/**') ? `${file}/*` : file}.tsx`
            : file;
      if (projected !== file)
        edits.push({
          offset: node.offset,
          length: node.length,
          content: JSON.stringify(projected),
        });
    }
  }
  if (additions.length)
    edits.push({
      offset: config.offset + 1,
      length: 0,
      content: `${additions.join(',')}${config.children?.length ? ',' : ''}`,
    });
  if (!edits.length) return undefined;
  const mappings: Mapping<CodeInformation>[] = [];
  let sourceOffset = 0;
  let code = '';
  for (const edit of edits.sort((left, right) => left.offset - right.offset)) {
    const unchanged = source.slice(sourceOffset, edit.offset);
    mappings.push({
      sourceOffsets: [sourceOffset],
      generatedOffsets: [code.length],
      lengths: [unchanged.length],
      data: { verification: true },
    });
    code += unchanged;
    mappings.push({
      sourceOffsets: [edit.offset],
      generatedOffsets: [code.length],
      lengths: [edit.length],
      generatedLengths: [edit.content.length],
      data: { verification: true },
    });
    code += edit.content;
    sourceOffset = edit.offset + edit.length;
  }
  mappings.push({
    sourceOffsets: [sourceOffset],
    generatedOffsets: [code.length],
    lengths: [source.length - sourceOffset],
    data: { verification: true },
  });
  code += source.slice(sourceOffset);
  return { source, fileName, code, map: new SourceMap(mappings) };
}

function diagnosticText(diagnostic: Diagnostic): string {
  return [
    diagnostic.text,
    ...(diagnostic.messageChain?.map(diagnosticText) ?? []),
  ].join('\n');
}

/** Checks authored TSRX through Octane's projection and the Effect-enabled tsrs API. */
export function checkOctaneProject(
  options: OctaneTypecheckOptions,
): OctaneTypecheckResult {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let project = path.resolve(cwd, options.project);
  if (fs.existsSync(project) && fs.statSync(project).isDirectory())
    project = path.join(project, 'tsconfig.json');
  if (!fs.existsSync(project))
    throw new Error(`Cannot find project ${project}`);
  if (
    options.compilerOptions?.noEmit === false ||
    options.compilerOptions?.noCheck === true ||
    options.compilerOptions?.skipLibCheck === true ||
    options.compilerOptions?.skipDefaultLibCheck === true
  )
    throw new Error(
      'Octane typechecking requires noEmit, full checking, and library checking',
    );

  const effectiveConfig = path.join(
    path.dirname(project),
    `.octane-typecheck-${randomUUID()}.json`,
  );
  const authoredConfig = parse(
    (readFile(project) ?? '').replace(/^\uFEFF/u, ' '),
    [],
    { allowTrailingComma: true },
  );
  const effectiveOptions = {
    extends: project,
    ...(Array.isArray(authoredConfig?.references)
      ? { references: authoredConfig.references }
      : {}),
    compilerOptions: {
      ...options.compilerOptions,
      noEmit: true,
      noCheck: false,
      skipLibCheck: false,
      skipDefaultLibCheck: false,
    },
  };
  // Resolve relative to the API client's own installation, so the native
  // protocol and its compiler metadata always belong to the same tsrs cohort.
  const tsserverPath = resolveEffectTsrsCompiler({
    from: typeof __filename === 'string' ? __filename : import.meta.url,
  });
  const virtual = new Map([
    [effectiveConfig, JSON.stringify(effectiveOptions)],
  ]);
  const projections = new Map<string, Projection>();
  const configurations = new Map<string, TextProjection>();
  const configFiles = new Set([project]);
  const referencedConfigs = new Set([project]);
  const referenceRoots = new Map<string, Set<string>>();
  let discovery: 'ordinary' | 'native' | 'complete' = 'ordinary';
  function authoredName(file: string): string {
    if (!projectedExtension.test(file)) return file;
    const authored = file.slice(0, -4);
    if (!fs.existsSync(authored)) return file;
    if (fs.existsSync(file))
      throw new Error(
        `Octane projection collision: ${authored} conflicts with physical ${file}`,
      );
    return authored;
  }
  function projection(file: string): Projection | undefined {
    const fileName = authoredName(file);
    if (fileName === file) return undefined;
    const known = projections.get(file);
    if (known) return known;
    const source = readFile(fileName);
    if (source === undefined) return undefined;
    let compiled: Pick<
      ReturnType<typeof compileToVolarMappings>,
      'code' | 'mappings' | 'errors' | 'diagnostics'
    >;
    try {
      compiled = compileToVolarMappings(source, fileName, { loose: true });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      compiled = {
        code: 'export {};',
        mappings: [],
        diagnostics: [],
        errors: [
          {
            name: error.name,
            message: error.message,
            fileName,
            type: 'fatal',
            ...('pos' in error && typeof error.pos === 'number'
              ? { pos: error.pos }
              : {}),
            ...('end' in error && typeof error.end === 'number'
              ? { end: error.end }
              : {}),
          },
        ],
      };
    }
    const result = {
      ...compiled,
      source,
      fileName,
      map: new SourceMap(compiled.mappings),
    };
    projections.set(file, result);
    virtual.set(path.normalize(file), compiled.code);
    return result;
  }
  const overlay: FileSystemCallbacks = {
    readFile(file) {
      const content = virtual.get(path.normalize(file));
      if (content !== undefined) return content;
      const compiled = projection(file);
      if (compiled) return compiled.code;
      if (file.endsWith('.json')) {
        const source = readFile(file);
        if (source !== undefined) {
          // Config parsing reads extends through the native resolver. Package
          // manifests encountered there are metadata, not configuration files.
          if (
            !configFiles.has(file) &&
            (discovery === 'complete' || path.basename(file) === 'package.json')
          )
            return source;
          configFiles.add(file);
          const configData = parse(source.replace(/^\uFEFF/u, ' '), [], {
            allowTrailingComma: true,
          });
          // References are not inherited from extends. Follow only the
          // requested config and actual reference targets, never their bases.
          for (const reference of referencedConfigs.has(file) &&
          Array.isArray(configData?.references)
            ? configData.references
            : []) {
            if (typeof reference?.path !== 'string') continue;
            const target = path.resolve(path.dirname(file), reference.path);
            const referenceFile = target.endsWith('.json')
              ? target
              : path.join(target, 'tsconfig.json');
            configFiles.add(referenceFile);
            referencedConfigs.add(referenceFile);
          }
          const roots =
            discovery === 'complete' ? referenceRoots.get(file) : undefined;
          const config = projectConfig(
            source,
            file,
            discovery,
            roots ? [...roots] : undefined,
          );
          if (config) configurations.set(file, config);
          else configurations.delete(file);
          return config?.code ?? source;
        }
      }
      return serverFS.useOS;
    },
    fileExists(file) {
      if (virtual.has(path.normalize(file)) || authoredName(file) !== file)
        return true;
      return serverFS.useOS;
    },
    directoryExists(directory) {
      const prefix = `${path.normalize(directory).replace(/[\\/]$/u, '')}${path.sep}`;
      return [...virtual.keys()].some(file => file.startsWith(prefix))
        ? true
        : serverFS.useOS;
    },
    getAccessibleEntries(directory) {
      const files = new Set<string>();
      const directories = new Set<string>();
      const symlinks: string[] = [];
      for (const file of virtual.keys()) {
        const relative = path.relative(directory, file);
        if (
          !relative ||
          relative.startsWith(`..${path.sep}`) ||
          relative === '..' ||
          path.isAbsolute(relative)
        )
          continue;
        const [first, ...rest] = relative.split(path.sep);
        if (first) (rest.length ? directories : files).add(first);
      }
      try {
        for (const entry of fs.readdirSync(directory, {
          withFileTypes: true,
        })) {
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              isDirectory = fs
                .statSync(path.join(directory, entry.name))
                .isDirectory();
            } catch (error) {
              if (
                error instanceof Error &&
                'code' in error &&
                (error.code === 'ENOENT' || error.code === 'ENOTDIR')
              )
                continue;
              throw error;
            }
          }
          if (entry.isSymbolicLink()) symlinks.push(entry.name);
          if (isDirectory) directories.add(entry.name);
          else {
            files.add(entry.name);
            if (nativeExtension.test(entry.name)) {
              const projected = path.join(directory, `${entry.name}.tsx`);
              authoredName(projected);
              files.add(`${entry.name}.tsx`);
            }
          }
        }
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          )
        )
          throw error;
      }
      return {
        files: [...files]
          .filter(
            file =>
              discovery !== 'ordinary' ||
              authoredName(path.join(directory, file)) ===
                path.join(directory, file),
          )
          .sort(),
        directories: [...directories].sort(),
        symlinks: symlinks.length ? symlinks.sort() : undefined,
      };
    },
    realpath(file) {
      const authored = authoredName(file);
      if (authored !== file) {
        try {
          return `${fs.realpathSync(authored)}.tsx`;
        } catch {
          return serverFS.useOS;
        }
      }
      return virtual.has(path.normalize(file)) ? file : serverFS.useOS;
    },
    stat(file) {
      const content =
        virtual.get(path.normalize(file)) ?? projection(file)?.code;
      return content === undefined
        ? serverFS.useOS
        : {
            mode: 0o100444,
            size: Buffer.byteLength(content),
            mtime: new Date(0),
          };
    },
    // Compiler writes/removals can only affect this invocation's memory.
    writeFile(file, content) {
      virtual.set(path.normalize(file), content);
    },
    removeFile(file) {
      virtual.delete(path.normalize(file));
    },
  };
  // The native matcher runs over original names and suffix-transposed TSRX
  // names separately. A '*.tsx' include/exclude therefore keeps its authored
  // meaning instead of accidentally matching every '.tsrx.tsx' projection.
  const roots = new Set<string>();
  for (const mode of ['ordinary', 'native'] as const) {
    discovery = mode;
    const parser = new API({ cwd, fs: overlay, tsserverPath });
    try {
      for (const file of parser.parseConfigFile(effectiveConfig).fileNames)
        if (mode === 'ordinary' || authoredName(file) !== file) roots.add(file);
      // Native parsing discovers each referenced config's inherited files.
      // Their roots belong to the referenced project, not this project's roots.
      const parsedReferences = new Set([project]);
      for (const reference of referencedConfigs) {
        if (parsedReferences.has(reference)) continue;
        parsedReferences.add(reference);
        const selected = referenceRoots.get(reference) ?? new Set<string>();
        referenceRoots.set(reference, selected);
        for (const file of parser.parseConfigFile(reference).fileNames)
          if (mode === 'ordinary' || authoredName(file) !== file)
            selected.add(file);
      }
    } finally {
      parser.close();
    }
  }
  discovery = 'complete';
  virtual.set(
    effectiveConfig,
    JSON.stringify({
      ...effectiveOptions,
      files: [...roots],
      include: [],
      exclude: [],
    }),
  );
  const api = new API({ cwd, fs: overlay, tsserverPath });
  try {
    const snapshot = api.createSnapshot({
      openProjects: [effectiveConfig],
      openFiles: [...roots],
    });
    const program = snapshot.getConfiguredProject(effectiveConfig)?.program;
    if (!program)
      throw new Error(`Native TypeScript did not load project ${project}`);
    function remap(diagnostic: Diagnostic): OctaneTypeDiagnostic | undefined {
      const relatedInformation = diagnostic.relatedInformation?.flatMap(
        info => {
          const mapped = remap(info);
          return mapped ? [mapped] : [];
        },
      );
      const text = diagnosticText(diagnostic);
      const compiled = diagnostic.fileName
        ? (projections.get(diagnostic.fileName) ??
          configurations.get(diagnostic.fileName))
        : undefined;
      let pos = diagnostic.pos;
      let end = diagnostic.end;
      let origin: OctaneTypeDiagnostic['origin'] = 'typescript';
      let message = text;
      if (compiled) {
        const ranges = compiled.map.toSourceRange(pos, end, true, info =>
          shouldReportDiagnostics(info, undefined, diagnostic.code),
        );
        const range = ranges.next().value;
        if (range) [pos, end] = range;
        else {
          // A deliberately disabled verification range is distinct from a gap.
          if (!compiled.map.toSourceRange(pos, end, true).next().done)
            return undefined;
          origin = 'projection';
          message = `Cannot map native ${diagnostic.source || 'TS'}${diagnostic.code} at generated offsets ${pos}-${end}: ${text}`;
          pos = 0;
          end = 0;
        }
      }
      const fileName =
        compiled?.fileName ??
        (diagnostic.fileName &&
        path.normalize(diagnostic.fileName) === effectiveConfig
          ? undefined
          : diagnostic.fileName);
      const source =
        compiled?.source ?? (fileName ? readFile(fileName) : undefined);
      return {
        ...(fileName ? { fileName } : {}),
        pos,
        end,
        ...(source !== undefined ? location(source, pos) : {}),
        code: diagnostic.code,
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        category:
          origin === 'projection' || diagnostic.category === 1
            ? 'error'
            : diagnostic.category === 0
              ? 'warning'
              : 'message',
        text: message,
        origin,
        ...(relatedInformation?.length ? { relatedInformation } : {}),
      };
    }
    const diagnostics: OctaneTypeDiagnostic[] = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getBindDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].flatMap(diagnostic => {
      const mapped = remap(diagnostic);
      return mapped ? [mapped] : [];
    });
    const nativeFiles = program.getSourceFileNames();
    for (const file of nativeFiles) {
      const compiled = projections.get(file);
      if (!compiled) continue;
      for (const diagnostic of compiled.diagnostics) {
        diagnostics.push({
          fileName: compiled.fileName,
          pos: diagnostic.start.offset,
          end: diagnostic.end.offset,
          ...location(compiled.source, diagnostic.start.offset),
          code: diagnostic.code,
          category:
            diagnostic.severity === 'error'
              ? 'error'
              : diagnostic.severity === 'warning'
                ? 'warning'
                : 'message',
          text: diagnostic.message,
          origin: 'octane',
        });
      }
      for (const error of compiled.errors) {
        const pos = error.pos ?? 0;
        diagnostics.push({
          fileName: compiled.fileName,
          pos,
          end: error.end ?? pos,
          ...location(compiled.source, pos),
          code: 'OCTANE_PARSE',
          category: 'error',
          text: error.message,
          origin: 'octane',
        });
      }
    }
    const unique = new Map(
      diagnostics.map(diagnostic => [JSON.stringify(diagnostic), diagnostic]),
    );
    return {
      compilerVersion: typescriptVersion,
      files: [
        ...new Set(
          nativeFiles.map(file => projections.get(file)?.fileName ?? file),
        ),
      ].sort(),
      diagnostics: [...unique.values()].sort(
        (left, right) =>
          (left.fileName ?? '').localeCompare(right.fileName ?? '') ||
          left.pos - right.pos ||
          String(left.code).localeCompare(String(right.code)),
      ),
    };
  } finally {
    api.close();
  }
}

export function formatOctaneDiagnostic(
  diagnostic: OctaneTypeDiagnostic,
  cwd = process.cwd(),
): string {
  const file = diagnostic.fileName
    ? `${path.relative(cwd, diagnostic.fileName)}(${diagnostic.line ?? 1},${diagnostic.column ?? 1}): `
    : '';
  const code =
    typeof diagnostic.code === 'number'
      ? `${diagnostic.source || 'TS'}${diagnostic.code}`
      : diagnostic.code;
  const related = diagnostic.relatedInformation
    ?.map(info => `  ${formatOctaneDiagnostic(info, cwd)}`)
    .join('\n');
  return `${file}${diagnostic.category} ${code}: ${diagnostic.text}${related ? `\n${related}` : ''}`;
}

const booleanOptions = new Set([
  'strict',
  'isolatedModules',
  'verbatimModuleSyntax',
  'allowImportingTsExtensions',
  'allowJs',
  'esModuleInterop',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'noPropertyAccessFromIndexSignature',
  'noImplicitReturns',
  'resolveJsonModule',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitAny',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
]);
const stringOptions = new Set([
  'target',
  'module',
  'moduleResolution',
  'moduleDetection',
  'jsx',
  'jsxImportSource',
]);

/** Node CLI entry. Unsupported options fail visibly instead of being ignored. */
export function runOctaneTypecheck(
  argv: string[],
  io: {
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): number {
  const stdout = io.stdout ?? (text => process.stdout.write(text));
  const stderr = io.stderr ?? (text => process.stderr.write(text));
  try {
    let project = 'tsconfig.json';
    let listFiles = false;
    const compilerOptions: Record<string, unknown> = {};
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index];
      if (argument === '--version' || argument === '-v') {
        stdout(`Version ${typescriptVersion}\n`);
        return 0;
      }
      if (argument === '--help' || argument === '-h') {
        stdout('octane-tsc --project <tsconfig.json> [--noEmit] [--strict]\n');
        return 0;
      }
      if (argument === '--project' || argument === '-p') {
        const value = argv[++index];
        if (!value || value.startsWith('-'))
          throw new Error('--project requires a configuration path');
        project = value;
        continue;
      }
      if (!argument?.startsWith('--'))
        throw new Error(`Unsupported Octane typecheck argument ${argument}`);
      const name = argument.slice(2);
      if (
        booleanOptions.has(name) ||
        [
          'noEmit',
          'noCheck',
          'skipLibCheck',
          'skipDefaultLibCheck',
          'pretty',
          'listFiles',
          'explainFiles',
        ].includes(name)
      ) {
        const explicit = argv[index + 1];
        const value =
          explicit === 'true' || explicit === 'false'
            ? argv[++index] === 'true'
            : true;
        if (
          (name === 'noEmit' && !value) ||
          ((name === 'noCheck' ||
            name === 'skipLibCheck' ||
            name === 'skipDefaultLibCheck') &&
            value)
        )
          throw new Error(
            `--${name} ${value} is incompatible with full Octane typechecking`,
          );
        if (name === 'listFiles' || name === 'explainFiles')
          listFiles ||= value;
        else if (name !== 'pretty') compilerOptions[name] = value;
      } else if (
        stringOptions.has(name) ||
        name === 'lib' ||
        name === 'types'
      ) {
        const value = argv[++index];
        if (!value || value.startsWith('-'))
          throw new Error(`--${name} requires a value`);
        compilerOptions[name] =
          name === 'lib' || name === 'types' ? value.split(',') : value;
      } else throw new Error(`Unsupported Octane typecheck option --${name}`);
    }
    const cwd = path.resolve(io.cwd ?? process.cwd());
    const result = checkOctaneProject({ project, cwd, compilerOptions });
    for (const diagnostic of result.diagnostics)
      stdout(`${formatOctaneDiagnostic(diagnostic, cwd)}\n`);
    if (listFiles) for (const file of result.files) stdout(`${file}\n`);
    return result.diagnostics.some(
      diagnostic => diagnostic.category === 'error',
    )
      ? 1
      : 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
