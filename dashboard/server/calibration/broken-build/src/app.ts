export function greet(name: string): string {
  return `Hello, ${name}`;
}
// TS2345: a number is not assignable to a string parameter.
export const shown: string = greet(42);
