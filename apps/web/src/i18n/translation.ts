/**
 * The shape another locale must give a namespace: the same keys as English,
 * any text. A missing or extra key is a type error.
 */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string ? string : Translation<T[K]>;
};
