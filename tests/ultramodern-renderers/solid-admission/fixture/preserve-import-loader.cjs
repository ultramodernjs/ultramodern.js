module.exports = function (source) {
  const babel = require(this.getOptions().babelPath ?? '@babel/core');
  let matched = 0;
  const result = babel.transformSync(source, {
    filename: this.resourcePath,
    configFile: false,
    babelrc: false,
    parserOpts: { createImportExpressions: true },
    plugins: [
      () => ({
        visitor: {
          ImportExpression(path) {
            if (
              path.node.source.type === 'Identifier' &&
              path.node.source.name === 'entryUrl'
            ) {
              path.node.source.leadingComments = [
                { type: 'CommentBlock', value: ' webpackIgnore: true ' },
              ];
              matched++;
            }
          },
        },
      }),
    ],
  });
  if (matched !== 1)
    throw new Error('Solid rc22 native URL import contract changed');
  return result.code;
};
