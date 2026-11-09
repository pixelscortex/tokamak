/**
 * `<api-declaration path="…/file.ts" name="definePlugin" />` becomes a `ts`
 * code block holding that export's declaration, read from the source file at
 * build time. It complements `<auto-type-table>`, which renders object types
 * well but collapses functions and type aliases to a single word.
 *
 * - Functions show their signature as written (generics, parameters and return
 *   type), without the body. Overloads are all shown.
 * - Interfaces and type aliases show their full declaration.
 * - Classes show their public members' signatures, without bodies.
 * - Constants show the type the checker infers for them, since their
 *   initializer is an implementation detail.
 *
 * Leading doc comments stay with the declaration. A missing name fails the
 * build, so a renamed export can't leave a stale page behind.
 */
import { dirname, resolve } from "node:path";
import { replaceSource } from "fumadocs-core/mdx-plugins/stringifier";
import { createProject, type Generator, type Project } from "fumadocs-typescript";

type VFile = Parameters<typeof replaceSource>[0];

interface Options {
  generator: Generator;
}

// Only the mdast fields this plugin touches; MDX adds the JSX node types.
interface JsxAttribute {
  type: string;
  name: string;
  value?: unknown;
}
interface MdNode {
  type: string;
  name?: string | null;
  attributes?: JsxAttribute[];
  children?: MdNode[];
  lang?: string;
  value?: string;
}

// Declaration nodes from the TypeScript 7 AST, duck-typed so the plugin does
// not depend on SyntaxKind numbers, which are not a stable public contract.
interface Member {
  pos: number;
  end: number;
  body?: { pos: number };
}
interface Statement extends Member {
  name?: { text?: string };
  members?: Iterable<Member>;
  declarationList?: { declarations?: Iterable<{ name?: { text?: string } }> };
}

let project: Promise<Project> | undefined;

function attribute(node: MdNode, key: string): string {
  const found = node.attributes?.find((a) => a.type === "mdxJsxAttribute" && a.name === key);
  if (typeof found?.value !== "string") {
    throw new Error(`<api-declaration> needs a string "${key}" attribute`);
  }
  return found.value;
}

function declaredName(statement: Statement): string | undefined {
  if (statement.name?.text) return statement.name.text;
  for (const declaration of statement.declarationList?.declarations ?? []) {
    return declaration.name?.text;
  }
  return undefined;
}

/** Leading trivia holds blank lines and comments; keep only the comment lines. */
function split(raw: string): { comments: string; code: string } {
  const lines = raw.replace(/^\s*\n/, "").split("\n");
  let index = 0;
  let inBlock = false;
  for (; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      inBlock = !line.includes("*/");
      continue;
    }
    break;
  }
  const comments = lines.slice(0, index).filter((line) => line.trim() !== "").join("\n");
  return { comments, code: lines.slice(index).join("\n") };
}

/**
 * The checker prints an object type on one line. Put each top-level member on
 * its own line so a namespace object like `v` reads as a list of signatures.
 */
function objectLines(type: string): string {
  if (!type.startsWith("{ ") || !type.endsWith(" }")) return type;
  const body = type.slice(2, -2);
  const members: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "=" && body[i + 1] === ">") {
      i++; // an arrow's ">" closes nothing
    } else if (char === "(" || char === "{" || char === "[" || char === "<") {
      depth++;
    } else if (char === ")" || char === "}" || char === "]" || char === ">") {
      depth--;
    } else if (char === ";" && depth === 0) {
      members.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const rest = body.slice(start).trim();
  if (rest) members.push(rest);
  if (depth !== 0 || members.length < 2) return type;
  return `{\n${members.map((member) => `  ${member};`).join("\n")}\n}`;
}

/**
 * A class as its public surface: the heading, then each non-private member's
 * signature without its body. Private fields and methods are implementation.
 */
function classOutline(text: string, statement: Statement, members: Iterable<Member>): string {
  const lines: string[] = [];
  let heading: string | undefined;
  for (const member of members) {
    heading ??= text.slice(statement.pos, member.pos);
    const raw = text.slice(member.pos, member.body ? member.body.pos : member.end);
    const { comments, code } = split(raw);
    if (/^(private\s|#)/.test(code.trim())) continue;
    // Members keep their source indentation, which is already one level in.
    const signature = code.trimEnd().replace(/;$/, "");
    lines.push((comments ? `${comments}\n` : "") + `${signature};`);
  }
  heading = split(heading ?? text.slice(statement.pos, statement.end)).code.trim();
  heading = heading.replace(/^export\s+/, "").replace(/\{[\s\S]*$/, "{");
  return `${heading}\n${lines.join("\n")}\n}`;
}

async function declaration(path: string, name: string, generator: Generator): Promise<string> {
  project ??= createProject();
  const source = (await project).getSourceFile(path);
  if (!source) throw new Error(`<api-declaration>: cannot read ${path}`);
  const file = source.sourceFile as unknown as { text: string; statements: Iterable<Statement> };

  const parts: string[] = [];
  for (const statement of file.statements) {
    if (declaredName(statement) !== name) continue;
    const isConstant = statement.declarationList !== undefined;
    const end = statement.body ? statement.body.pos : statement.end;
    const { comments, code } = split(file.text.slice(statement.pos, end));
    let text = code.trim().replace(/^export\s+/, "");

    if (/^(abstract\s+)?class\b/.test(text) && statement.members) {
      text = classOutline(file.text, statement, statement.members);
    } else if (isConstant) {
      const [doc] = await generator.generateTypeTable({ path, type: `{ ${name}: typeof ${name} }` });
      const type = doc?.entries[0]?.type;
      if (!type) throw new Error(`<api-declaration>: no type for ${name} in ${path}`);
      text = `const ${name}: ${objectLines(type)};`;
    } else if (statement.body) {
      text += ";";
    }
    parts.push(comments ? `${comments}\n${text}` : text);
  }
  if (parts.length === 0) throw new Error(`<api-declaration>: ${name} is not declared in ${path}`);
  return parts.join("\n\n");
}

export function remarkApiDeclaration({ generator }: Options) {
  return async (tree: MdNode, file: VFile) => {
    const found: MdNode[] = [];
    const walk = (node: MdNode) => {
      if (node.type === "mdxJsxFlowElement" && node.name === "api-declaration") found.push(node);
      node.children?.forEach(walk);
    };
    walk(tree);

    const base = file.path ? dirname(file.path) : process.cwd();
    await Promise.all(
      found.map(async (node) => {
        const path = resolve(base, attribute(node, "path"));
        const value = await declaration(path, attribute(node, "name"), generator);
        // Turn the JSX element into a code block in place. Its position stays,
        // so the Markdown output (llms.txt, .md routes) can be given the same text.
        const { position } = node as { position?: unknown };
        for (const key of Object.keys(node)) delete (node as unknown as Record<string, unknown>)[key];
        Object.assign(node, { type: "code", lang: "ts", value, position });
        replaceSource(file, node as Parameters<typeof replaceSource>[1], `\`\`\`ts\n${value}\n\`\`\``);
      }),
    );
  };
}
