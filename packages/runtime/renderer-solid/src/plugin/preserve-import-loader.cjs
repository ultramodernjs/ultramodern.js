const babel = require('@babel/core');

/** Preserve the native runtime's browser URL import without patching its file. */
module.exports = function preserveSolidImport(source, inputMap) {
  const callback = this.async();
  let matched = 0;
  try {
    const result = babel.transformSync(source, {
      filename: this.resourcePath,
      babelrc: false,
      configFile: false,
      sourceMaps: true,
      inputSourceMap:
        typeof inputMap === 'string' ? JSON.parse(inputMap) : inputMap,
      plugins: [
        () => ({
          visitor: {
            ImportExpression(call) {
              if (
                call.node.source.type === 'Identifier' &&
                call.node.source.name === 'entryUrl'
              ) {
                const argument = call.node.source;
                argument.leadingComments = [
                  ...(argument.leadingComments ?? []),
                  { type: 'CommentBlock', value: ' webpackIgnore: true ' },
                ];
                matched++;
              }
            },
          },
        }),
      ],
    });
    if (matched !== 1 || !result) {
      throw new Error(
        'Solid native browser URL import contract changed. Expected one import(entryUrl) in @solidjs/web 2.0.0; update and revalidate the compiler integration.',
      );
    }
    callback(null, result.code, result.map);
  } catch (error) {
    callback(error);
  }
};
