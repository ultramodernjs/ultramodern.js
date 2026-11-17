const STATUS_FUNCTIONS = new Set(['always', 'cancelled', 'failure', 'success']);

const MISSING = Symbol('missing GitHub expression value');

function syntaxError(source, offset, message) {
  return new SyntaxError(
    `${message} at offset ${offset} in ${JSON.stringify(source)}`,
  );
}

function unwrapExpression(condition) {
  const source = condition.trim();
  if (!source.startsWith('${{')) {
    return source;
  }
  if (!source.endsWith('}}')) {
    throw syntaxError(source, source.length, 'Unterminated expression wrapper');
  }
  return source.slice(3, -2).trim();
}

function tokenize(condition) {
  const source = unwrapExpression(condition);
  const tokens = [];
  let offset = 0;

  while (offset < source.length) {
    const character = source[offset];
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }

    const operator = source.slice(offset, offset + 2);
    if (operator === '&&' || operator === '||' || operator === '==') {
      tokens.push({ type: operator, offset });
      offset += 2;
      continue;
    }

    if (character === '(' || character === ')' || character === ',') {
      tokens.push({ type: character, offset });
      offset += 1;
      continue;
    }

    if (character === "'") {
      const start = offset;
      let value = '';
      offset += 1;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] !== "'") {
          value += source[offset];
          offset += 1;
          continue;
        }
        if (source[offset + 1] === "'") {
          value += "'";
          offset += 2;
          continue;
        }
        offset += 1;
        closed = true;
        break;
      }
      if (!closed) {
        throw syntaxError(source, start, 'Unterminated string literal');
      }
      tokens.push({ type: 'literal', value, offset: start });
      continue;
    }

    if (/[A-Za-z_]/u.test(character)) {
      const start = offset;
      do {
        offset += 1;
        while (
          offset < source.length &&
          /[A-Za-z0-9_-]/u.test(source[offset])
        ) {
          offset += 1;
        }
        if (source[offset] !== '.') {
          break;
        }
        offset += 1;
        if (!/[A-Za-z_]/u.test(source[offset] ?? '')) {
          throw syntaxError(source, offset, 'Expected a reference segment');
        }
      } while (offset < source.length);

      const value = source.slice(start, offset);
      if (value === 'true' || value === 'false') {
        tokens.push({
          type: 'literal',
          value: value === 'true',
          offset: start,
        });
      } else {
        tokens.push({ type: 'identifier', value, offset: start });
      }
      continue;
    }

    throw syntaxError(
      source,
      offset,
      `Unexpected character ${JSON.stringify(character)}`,
    );
  }

  tokens.push({ type: 'eof', offset: source.length });
  return { source, tokens };
}

class Parser {
  constructor(source, tokens) {
    this.source = source;
    this.tokens = tokens;
    this.index = 0;
  }

  current() {
    return this.tokens[this.index];
  }

  take(type) {
    if (this.current().type !== type) {
      return undefined;
    }
    const token = this.current();
    this.index += 1;
    return token;
  }

  expect(type, message) {
    const token = this.take(type);
    if (!token) {
      throw syntaxError(this.source, this.current().offset, message);
    }
    return token;
  }

  parse() {
    const expression = this.parseOr();
    this.expect('eof', 'Expected the end of the condition');
    return expression;
  }

  parseOr() {
    let expression = this.parseAnd();
    while (this.take('||')) {
      expression = {
        type: 'binary',
        operator: '||',
        left: expression,
        right: this.parseAnd(),
      };
    }
    return expression;
  }

  parseAnd() {
    let expression = this.parseEquality();
    while (this.take('&&')) {
      expression = {
        type: 'binary',
        operator: '&&',
        left: expression,
        right: this.parseEquality(),
      };
    }
    return expression;
  }

  parseEquality() {
    const left = this.parsePrimary();
    if (!this.take('==')) {
      return left;
    }
    return {
      type: 'binary',
      operator: '==',
      left,
      right: this.parsePrimary(),
    };
  }

  parsePrimary() {
    const literal = this.take('literal');
    if (literal) {
      return { type: 'literal', value: literal.value };
    }

    if (this.take('(')) {
      const expression = this.parseOr();
      this.expect(')', "Expected ')'");
      return expression;
    }

    const identifier = this.take('identifier');
    if (!identifier) {
      throw syntaxError(
        this.source,
        this.current().offset,
        'Expected an expression',
      );
    }
    if (!this.take('(')) {
      return { type: 'reference', path: identifier.value.split('.') };
    }
    if (identifier.value.includes('.')) {
      throw syntaxError(
        this.source,
        identifier.offset,
        'Function names cannot be dotted',
      );
    }
    if (
      identifier.value !== 'always' &&
      identifier.value !== 'cancelled' &&
      identifier.value !== 'format'
    ) {
      throw syntaxError(
        this.source,
        identifier.offset,
        `Unsupported function ${JSON.stringify(identifier.value)}`,
      );
    }

    const args = [];
    if (!this.take(')')) {
      do {
        args.push(this.parseOr());
      } while (this.take(','));
      this.expect(')', "Expected ')' after function arguments");
    }
    if (
      (identifier.value === 'always' || identifier.value === 'cancelled') &&
      args.length !== 0
    ) {
      throw syntaxError(
        this.source,
        identifier.offset,
        `${identifier.value}() takes no arguments`,
      );
    }
    if (identifier.value === 'format' && args.length === 0) {
      throw syntaxError(
        this.source,
        identifier.offset,
        'format() needs a template',
      );
    }
    return { type: 'call', name: identifier.value, args };
  }
}

export function parseJobCondition(condition) {
  if (typeof condition === 'boolean') {
    return { type: 'literal', value: condition };
  }
  if (typeof condition !== 'string' || condition.trim() === '') {
    throw new TypeError(
      'A job condition must be a non-empty string or boolean',
    );
  }
  const { source, tokens } = tokenize(condition);
  return new Parser(source, tokens).parse();
}

export function conditionCalls(ast, name) {
  if (!ast || typeof ast !== 'object') {
    return false;
  }
  if (ast.type === 'call') {
    return (
      ast.name === name ||
      ast.args.some(argument => conditionCalls(argument, name))
    );
  }
  if (ast.type === 'binary') {
    return conditionCalls(ast.left, name) || conditionCalls(ast.right, name);
  }
  return false;
}

function normalizeNeeds(job) {
  if (job.needs === undefined) {
    return [];
  }
  const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
  if (!needs.every(need => typeof need === 'string' && need.length > 0)) {
    return undefined;
  }
  return needs;
}

function resultFor(results, jobId) {
  let value = MISSING;
  if (results instanceof Map) {
    if (results.has(jobId)) {
      value = results.get(jobId);
    }
  } else if (
    results &&
    typeof results === 'object' &&
    Object.prototype.hasOwnProperty.call(results, jobId)
  ) {
    value = results[jobId];
  }
  if (
    value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'result')
  ) {
    return value.result;
  }
  return value;
}

// A result given as { result, outputs } exposes its outputs; a bare result
// string, or an output that was not given, stays MISSING.
function outputFor(results, jobId, name) {
  let value = MISSING;
  if (results instanceof Map) {
    if (results.has(jobId)) {
      value = results.get(jobId);
    }
  } else if (
    results &&
    typeof results === 'object' &&
    Object.prototype.hasOwnProperty.call(results, jobId)
  ) {
    value = results[jobId];
  }
  const outputs =
    value && typeof value === 'object' ? value.outputs : undefined;
  if (
    !outputs ||
    typeof outputs !== 'object' ||
    !Object.prototype.hasOwnProperty.call(outputs, name) ||
    typeof outputs[name] !== 'string'
  ) {
    return MISSING;
  }
  return outputs[name];
}

function collectAncestors(workflow, jobId) {
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== 'object') {
    return undefined;
  }
  const ancestors = new Set();
  const visiting = new Set();

  function visit(currentId) {
    if (visiting.has(currentId)) {
      return false;
    }
    const job = jobs[currentId];
    if (!job || typeof job !== 'object') {
      return false;
    }
    const needs = normalizeNeeds(job);
    if (!needs) {
      return false;
    }
    visiting.add(currentId);
    for (const need of needs) {
      if (!Object.prototype.hasOwnProperty.call(jobs, need)) {
        return false;
      }
      if (!ancestors.has(need)) {
        ancestors.add(need);
        if (!visit(need)) {
          return false;
        }
      }
    }
    visiting.delete(currentId);
    return true;
  }

  return visit(jobId) ? ancestors : undefined;
}

function readReference(path, environment) {
  const [root, ...segments] = path;
  if (root === 'needs') {
    if (!environment.directNeeds.has(segments[0])) {
      return MISSING;
    }
    if (segments.length === 2 && segments[1] === 'result') {
      return resultFor(environment.results, segments[0]);
    }
    if (segments.length === 3 && segments[1] === 'outputs') {
      return outputFor(environment.results, segments[0], segments[2]);
    }
    return MISSING;
  }
  if (root !== 'github' && root !== 'vars' && root !== 'inputs') {
    return MISSING;
  }

  let value = environment.context?.[root];
  for (const segment of segments) {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      return MISSING;
    }
    value = value[segment];
  }
  return value === undefined ? MISSING : value;
}

function githubFormat(template, values) {
  if (typeof template !== 'string' || values.includes(MISSING)) {
    return MISSING;
  }
  let missingArgument = false;
  const formatted = template.replace(
    /\{\{|\}\}|\{(\d+)\}/gu,
    (placeholder, index) => {
      if (placeholder === '{{') {
        return '{';
      }
      if (placeholder === '}}') {
        return '}';
      }
      const value = values[Number(index)];
      if (value === undefined) {
        missingArgument = true;
        return '';
      }
      return String(value);
    },
  );
  return missingArgument ? MISSING : formatted;
}

function evaluateAst(ast, environment) {
  if (ast.type === 'literal') {
    return ast.value;
  }
  if (ast.type === 'reference') {
    return readReference(ast.path, environment);
  }
  if (ast.type === 'call') {
    if (ast.name === 'always') {
      return true;
    }
    if (ast.name === 'cancelled') {
      return environment.cancelled;
    }
    if (ast.name === 'format') {
      const [template, ...values] = ast.args.map(argument =>
        evaluateAst(argument, environment),
      );
      return githubFormat(template, values);
    }
    return MISSING;
  }
  if (ast.type !== 'binary') {
    return MISSING;
  }

  const left = evaluateAst(ast.left, environment);
  if (ast.operator === '&&') {
    return left !== MISSING && left
      ? evaluateAst(ast.right, environment)
      : false;
  }
  if (ast.operator === '||') {
    return left !== MISSING && left
      ? left
      : evaluateAst(ast.right, environment);
  }
  if (ast.operator === '==') {
    const right = evaluateAst(ast.right, environment);
    // GitHub expression string comparisons ignore case.
    if (typeof left === 'string' && typeof right === 'string') {
      return left.toLowerCase() === right.toLowerCase();
    }
    return left !== MISSING && right !== MISSING && left === right;
  }
  return MISSING;
}

export function evaluateJobSchedule({
  workflow,
  jobId,
  results = {},
  context = {},
  cancelled = false,
}) {
  try {
    if (typeof cancelled !== 'boolean') {
      return false;
    }
    const job = workflow?.jobs?.[jobId];
    if (!job || typeof job !== 'object') {
      return false;
    }
    const directNeeds = normalizeNeeds(job);
    if (!directNeeds) {
      return false;
    }

    const ast =
      job.if === undefined
        ? { type: 'literal', value: true }
        : parseJobCondition(job.if);
    const hasStatusFunction = [...STATUS_FUNCTIONS].some(name =>
      conditionCalls(ast, name),
    );
    const ancestors = collectAncestors(workflow, jobId);
    if (!ancestors) {
      return false;
    }
    if (
      !hasStatusFunction &&
      (cancelled ||
        [...ancestors].some(
          ancestor => resultFor(results, ancestor) !== 'success',
        ))
    ) {
      return false;
    }

    const value = evaluateAst(ast, {
      context,
      directNeeds: new Set(directNeeds),
      results,
      cancelled,
    });
    return value !== MISSING && Boolean(value);
  } catch {
    return false;
  }
}
