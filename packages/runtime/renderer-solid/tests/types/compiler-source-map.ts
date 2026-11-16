import type { File } from '@babel/core';

declare const sourceMap: NonNullable<File['inputMap']>;

export const sourceMapJson: string = sourceMap.toJSON();

// @ts-expect-error The compiler source-map converter returns JSON text, not a numeric value.
export const numericSourceMap: number = sourceMap.toJSON();
