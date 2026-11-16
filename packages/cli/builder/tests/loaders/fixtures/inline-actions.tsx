import { z } from 'zod';

console.log('zod', z);
export async function foo() {
  'use server';

  return `foo`;
}

export async function bar() {
  return qux();
}

const b = async () => {
  'use server';

  return `baz`;
};

export { b as baz };

async function qux() {
  'use server';

  return `qux`;
}

export default async function () {
  'use server';

  return `default`;
}
