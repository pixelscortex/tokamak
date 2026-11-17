declare module "virtual:plugin-lexer" {
  export function parse(
    code: string,
  ): readonly [readonly { n?: string; s: number; e: number; d: number }[], unknown, unknown, unknown];
}
