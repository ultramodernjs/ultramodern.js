import assert from 'node:assert/strict';

const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(segment) {
  const result = [];
  let value = 0,
    shift = 0;
  for (const char of segment) {
    const digit = alphabet.indexOf(char);
    assert(digit >= 0, 'invalid base64 VLQ');
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      assert(shift < 50);
      continue;
    }
    result.push(value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2));
    value = 0;
    shift = 0;
  }
  assert.equal(shift, 0, 'unterminated base64 VLQ');
  return result;
}
export function validateMappings(map, generated) {
  let source = 0,
    originalLine = 0,
    originalColumn = 0,
    name = 0,
    count = 0;
  const generatedLines = generated.split(/\r?\n/);
  const sources = map.sourcesContent.map(content => content.split(/\r?\n/));
  for (const [lineIndex, line] of map.mappings.split(';').entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(',').filter(Boolean)) {
      const values = decode(segment);
      assert([1, 4, 5].includes(values.length), 'invalid mapping segment');
      assert(values[0] >= 0);
      generatedColumn += values[0];
      assert(lineIndex < generatedLines.length);
      assert(generatedColumn <= generatedLines[lineIndex].length);
      if (values.length === 1) continue;
      source += values[1];
      originalLine += values[2];
      originalColumn += values[3];
      assert(source >= 0 && source < sources.length);
      assert(originalLine >= 0 && originalLine < sources[source].length);
      assert(
        originalColumn >= 0 &&
          originalColumn <= sources[source][originalLine].length,
      );
      if (values.length === 5) {
        name += values[4];
        assert(name >= 0 && name < map.names.length);
      }
      count++;
    }
  }
  assert(count > 0, 'no source mappings');
  return count;
}
